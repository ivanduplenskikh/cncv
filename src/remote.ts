import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import semver from 'semver';
import { z } from 'zod';

import type { CheckOptions, Report } from './check.js';
import { dependencyEntries, inspectProject, manifestSchema, resolveNpmVersion } from './check.js';

type FetchJson = (url: string) => Promise<unknown>;

export function remoteManifestUrl(input: string): URL {
  const url = new URL(input);

  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    throw new Error('Remote manifests require a public HTTPS GitHub URL without credentials or a port.');
  }

  const parts = url.pathname.split('/').filter(Boolean);

  if (url.hostname === 'github.com' && (parts[2] === 'blob' || parts[2] === 'tree')) {
    const directory = parts[2] === 'tree';
    parts.splice(2, 1);

    if (directory) {
      parts.push('package.json');
    }

    url.hostname = 'raw.githubusercontent.com';
    url.pathname = `/${parts.join('/')}`;
  }

  if (url.hostname !== 'raw.githubusercontent.com' || parts.length < 4 || parts.at(-1) !== 'package.json') {
    throw new Error('Provide a GitHub tree directory URL, or a GitHub blob or raw.githubusercontent.com URL ending in package.json.');
  }

  url.search = '';
  url.hash = '';

  return url;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });

  return readJsonResponse(response, url);
}

async function readJsonResponse(response: Response, url: string): Promise<unknown> {
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)} fetching ${url}`);
  }

  if (response.body === null) {
    throw new Error(`Empty response from ${url}`);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error(`Invalid response chunk from ${url}`);
    }

    size += chunk.length;

    if (size > 20_000_000) {
      throw new Error(`Response exceeds 20 MB: ${url}`);
    }

    chunks.push(chunk);
  }

  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  return data;
}

const nodeReleaseUrl = 'https://nodejs.org/dist/index.json';
const nodeReleaseTtl = 24 * 60 * 60 * 1000;
const nodeReleasesSchema = z.array(z.object({
  version: z.string().refine((value) => semver.valid(value) !== null),
}));
const nodeReleaseCacheSchema = z.object({
  checkedAt: z.number().nonnegative(),
  retryAfter: z.number().nonnegative().optional(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  releases: nodeReleasesSchema,
});
type NodeReleaseCache = z.infer<typeof nodeReleaseCacheSchema>;
let pendingNodeReleases: Promise<z.infer<typeof nodeReleasesSchema>> | undefined;

function parseNodeReleases(data: unknown): z.infer<typeof nodeReleasesSchema> {
  const releases = nodeReleasesSchema.safeParse(data);

  if (!releases.success) {
    throw new Error('Invalid Node.js release index. Use an exact --node version to skip the lookup.');
  }

  return releases.data;
}

async function saveNodeReleaseCache(filePath: string, cache: NodeReleaseCache): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;

  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(cache), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filePath);
  } catch {
    console.error('cncv: Could not save the Node.js release cache; future lookups may require network access.');
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function loadNodeReleases(): Promise<z.infer<typeof nodeReleasesSchema>> {
  const filePath = path.join(os.homedir(), '.cncv', 'cache', 'node-releases.json');
  const now = Date.now();
  let cached: NodeReleaseCache | undefined;

  try {
    const data: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    cached = nodeReleaseCacheSchema.parse(data);

    if (cached.checkedAt > now) {
      cached = undefined;
    }
  } catch {
    cached = undefined;
  }

  if (cached !== undefined && now - cached.checkedAt < nodeReleaseTtl) {
    return cached.releases;
  }

  if (cached?.retryAfter !== undefined && cached.retryAfter > now && cached.retryAfter <= now + nodeReleaseTtl) {
    console.error('cncv: Using stale cached Node.js releases; the next refresh will be retried after the daily retry interval.');

    return cached.releases;
  }

  let updated: NodeReleaseCache;

  try {
    const headers: Record<string, string> = {};

    if (cached?.etag !== undefined) {
      headers['If-None-Match'] = cached.etag;
    }

    if (cached?.lastModified !== undefined) {
      headers['If-Modified-Since'] = cached.lastModified;
    }

    const response = await fetch(nodeReleaseUrl, { headers, signal: AbortSignal.timeout(20_000), redirect: 'error' });
    const releases = response.status === 304 && cached !== undefined
      ? cached.releases : parseNodeReleases(await readJsonResponse(response, nodeReleaseUrl));
    updated = { checkedAt: now, releases };
    const etag = response.headers.get('etag') ?? (response.status === 304 ? cached?.etag : undefined);
    const lastModified = response.headers.get('last-modified') ?? (response.status === 304 ? cached?.lastModified : undefined);

    if (etag !== undefined) {
      updated.etag = etag;
    }

    if (lastModified !== undefined) {
      updated.lastModified = lastModified;
    }
  } catch (error) {
    if (cached === undefined) {
      throw error;
    }

    console.error(`cncv: Could not refresh Node.js releases; using stale cached data. ${error instanceof Error ? error.message : 'Unknown error'}`);
    await saveNodeReleaseCache(filePath, { ...cached, retryAfter: now + nodeReleaseTtl });

    return cached.releases;
  }

  await saveNodeReleaseCache(filePath, updated);

  return updated.releases;
}

async function cachedNodeReleases(): Promise<z.infer<typeof nodeReleasesSchema>> {
  pendingNodeReleases ??= loadNodeReleases();

  try {
    return await pendingNodeReleases;
  } finally {
    pendingNodeReleases = undefined;
  }
}

export async function resolveNodeVersion(input: string, request?: FetchJson): Promise<string> {
  const exact = semver.valid(input);

  if (exact !== null) {
    return exact;
  }

  if (!/^v?(0|[1-9]\d*)$/.test(input) || semver.validRange(input) === null) {
    throw new Error('Node version must be an exact version, such as 22.14.0, or a major version, such as 18.');
  }

  const major = input.replace(/^v/, '');
  const releases = request === undefined ? await cachedNodeReleases() : parseNodeReleases(await request(nodeReleaseUrl));
  const latest = semver.maxSatisfying(releases.map((release) => release.version), `${major}.x`);

  if (latest === null) {
    throw new Error(`No published stable Node.js release found for major ${major}.`);
  }

  return new semver.SemVer(latest).version;
}

const lockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.string(), manifestSchema.extend({
    link: z.boolean().optional(),
  })),
});

async function writeManifest(directory: string, manifest: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
}

const packumentSchema = z.object({
  versions: z.record(z.string(), z.unknown()),
  'dist-tags': z.record(z.string(), z.string()).default({}),
});

interface OverrideRule {
  id: number;
  name: string;
  selector: string | undefined;
  value: string | undefined;
  children: OverrideRule[];
}

function overrideRules(manifest: z.infer<typeof manifestSchema>): OverrideRule[] {
  if (manifest.overrides !== undefined && manifest.pnpm?.overrides !== undefined) {
    throw new Error('Registry estimates cannot combine npm and pnpm overrides. Provide an npm lockfile.');
  }

  let nextId = 0;
  const parse = (entries: Record<string, unknown>): OverrideRule[] => Object.entries(entries).map(([key, entry]) => {
    const match = /^((?:@[^/]+\/)?[^/@\s>]+)(?:@(.+))?$/.exec(key);
    const name = match?.[1];
    const selector = match?.[2];

    if (name === undefined || name.includes('\\') || name.includes('\0')
      || (selector !== undefined && semver.validRange(selector) === null)) {
      throw new Error(`Unsupported override selector: ${key}. Provide an npm lockfile.`);
    }

    const object = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? entry as Record<string, unknown> : undefined;

    if (manifest.pnpm?.overrides !== undefined && typeof entry !== 'string') {
      throw new Error(`Unsupported pnpm override: ${key}. Only flat version overrides are supported.`);
    }

    let value = object === undefined ? entry : object['.'];

    if ((object === undefined || value !== undefined) && typeof value !== 'string') {
      throw new Error(`Invalid override value: ${key}.`);
    }

    if (typeof value === 'string' && value.startsWith('$')) {
      const reference = value.slice(1);
      value = manifest.dependencies?.[reference] ?? manifest.devDependencies?.[reference]
        ?? manifest.optionalDependencies?.[reference] ?? manifest.peerDependencies?.[reference];

      if (value === undefined) {
        throw new Error(`Unknown override dependency reference: ${reference}.`);
      }
    }

    const id = nextId++;

    return {
      id,
      name,
      selector,
      value: typeof value === 'string' ? value : undefined,
      children: object === undefined ? [] : parse(Object.fromEntries(Object.entries(object).filter(([child]) => child !== '.'))),
    };
  });

  return parse(manifest.overrides ?? manifest.pnpm?.overrides ?? {});
}

async function materializeRegistry(
  manifest: z.infer<typeof manifestSchema>, directory: string, request: FetchJson, options: CheckOptions,
): Promise<Map<string, string>> {
  const metadata = new Map<string, z.infer<typeof packumentSchema>>();
  const packages = new Map<string, string>();
  const origins = new Map<string, string>();
  const queue = [{ manifest, directory, root: true, rules: overrideRules(manifest) }];

  for (const current of queue) {
    for (const [name, kind] of dependencyEntries(current.manifest, current.root && options.omitDev === false)) {
      if (!/^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/.test(name) || name.includes('\0')) {
        throw new Error(`Invalid registry dependency name: ${name}`);
      }

      const groups = {
        project: undefined,
        dependency: current.manifest.dependencies,
        dev: current.manifest.devDependencies,
        optional: current.manifest.optionalDependencies,
        peer: current.manifest.peerDependencies,
      };
      const requested = groups[kind]?.[name];
      const rule = current.rules.find((candidate) => candidate.name === name && (candidate.selector === undefined
        || (requested !== undefined && semver.validRange(requested) !== null && semver.intersects(candidate.selector, requested))));
      const range = rule?.value ?? requested;
      const rules = [...new Map([...(rule?.children ?? []), ...current.rules].map((candidate) => [candidate.id, candidate])).values()];

      if (range === undefined || /^(?:file:|link:|workspace:|npm:|git|https?:|github:)/i.test(range)) {
        throw new Error(`Unsupported remote dependency: ${name}@${range ?? '(missing range)'}. Only public npm semver ranges and tags are supported without a lockfile.`);
      }

      const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
      let packument = metadata.get(name);

      if (packument === undefined) {
        if (metadata.size >= 500) {
          throw new Error('Registry estimate exceeds 500 package names. Provide an npm lockfile.');
        }

        packument = packumentSchema.parse(await request(registryUrl));
        metadata.set(name, packument);
      }

      const version = semver.validRange(range) === null
        ? packument['dist-tags'][range]
        : semver.maxSatisfying(Object.keys(packument.versions), range);

      if (version === null || version === undefined) {
        throw new Error(`No public npm version satisfies ${name}@${range}.`);
      }

      const key = `${name}@${version}\0${rules.map((candidate) => candidate.id).join(',')}`;
      let target = packages.get(key);

      if (target === undefined) {
        if (packages.size >= 500) {
          throw new Error('Registry estimate exceeds 500 package versions. Provide an npm lockfile.');
        }

        const dependency = manifestSchema.parse(packument.versions[version]);

        if (dependency.version !== version) {
          throw new Error(`Registry version mismatch: ${name}@${version}`);
        }

        target = path.join(directory, '.cncv-registry', String(packages.size));
        await writeManifest(target, { ...dependency, name });
        packages.set(key, target);
        origins.set(target, `${registryUrl}/${encodeURIComponent(version)}`);

        if (options.direct !== true) {
          queue.push({ manifest: dependency, directory: target, root: false, rules });
        }
      }

      const link = path.join(current.directory, 'node_modules', name);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(target, link, 'junction');
    }
  }

  return origins;
}

export async function inspectRemoteProject(
  input: string,
  options: CheckOptions = {},
  request: FetchJson = fetchJson,
): Promise<Report> {
  if (semver.valid(options.nodeVersion ?? process.versions.node) === null) {
    throw new Error('Node version must be exact, such as 22.14.0.');
  }

  const npmVersion = resolveNpmVersion(options.npmVersion);
  const url = remoteManifestUrl(input);
  const manifest = manifestSchema.parse(await request(url.href));
  const lockUrl = new URL('package-lock.json', url);
  const lockData = await request(lockUrl.href);
  const lock = lockData === null ? null : lockSchema.parse(lockData);
  const entries = Object.entries(lock?.packages ?? {}).filter(([location]) => location !== '');

  if (entries.length > 10_000) {
    throw new Error('Remote lockfile exceeds 10,000 package locations.');
  }

  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cncv-remote-')));

  try {
    await writeManifest(directory, manifest);
    const origins = lock === null ? await materializeRegistry(manifest, directory, request, options) : new Map<string, string>();

    for (const [location, locked] of entries) {
      if (!/^(?:node_modules\/(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*\/)*node_modules\/(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/.test(location)
        || location.includes('\0')) {
        throw new Error(`Unsupported or unsafe lockfile location: ${location}`);
      }

      if (locked.link === true) {
        throw new Error(`Remote workspace/file links are not supported: ${location}`);
      }

      await writeManifest(path.join(directory, location), locked);
    }

    const report = await inspectProject(directory, { ...options, npmVersion });

    for (const row of report.rows) {
      const location = path.relative(directory, row.path).split(path.sep).join('/');
      row.path = location === 'package.json' ? url.href
        : origins.get(path.dirname(row.path)) ?? `${lockUrl.href}#${encodeURIComponent(location)}`;
    }

    report.source = lock === null
      ? 'ESTIMATE: No sibling npm package-lock.json. Versions resolved from current public npm metadata with root npm or flat pnpm overrides, not the repository installed tree. Yarn resolutions and other lockfile formats are not applied.'
      : `Remote npm lockfile v${String(lock.lockfileVersion)}: ${lockUrl.href}. Versions are locked; engine declarations come from the lockfile.`;

    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
