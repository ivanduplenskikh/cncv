import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  if (url.hostname === 'github.com' && parts[2] === 'blob') {
    parts.splice(2, 1);
    url.hostname = 'raw.githubusercontent.com';
    url.pathname = `/${parts.join('/')}`;
  }
  if (url.hostname !== 'raw.githubusercontent.com' || parts.length < 4 || parts.at(-1) !== 'package.json') {
    throw new Error('Provide a GitHub blob URL or raw.githubusercontent.com URL ending in package.json.');
  }
  url.search = '';
  url.hash = '';

  return url;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
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

async function materializeRegistry(
  manifest: z.infer<typeof manifestSchema>, directory: string, request: FetchJson, options: CheckOptions,
): Promise<Map<string, string>> {
  const metadata = new Map<string, z.infer<typeof packumentSchema>>();
  const packages = new Map<string, string>();
  const origins = new Map<string, string>();
  const queue = [{ manifest, directory, root: true }];
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
      const range = groups[kind]?.[name];
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
      const key = `${name}@${version}`;
      let target = packages.get(key);
      if (target === undefined) {
        if (packages.size >= 500) {
          throw new Error('Registry estimate exceeds 500 package versions. Provide an npm lockfile.');
        }
        const dependency = manifestSchema.parse(packument.versions[version]);
        if (dependency.version !== version) {
          throw new Error(`Registry version mismatch: ${key}`);
        }
        target = path.join(directory, '.cncv-registry', String(packages.size));
        await writeManifest(target, { ...dependency, name });
        packages.set(key, target);
        origins.set(target, `${registryUrl}/${encodeURIComponent(version)}`);
        if (options.direct !== true) {
          queue.push({ manifest: dependency, directory: target, root: false });
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cncv-remote-'));
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
      ? 'ESTIMATE: No sibling npm package-lock.json. Versions resolved from current public npm metadata, not the repository installed tree. Overrides and other lockfile formats are not applied.'
      : `Remote npm lockfile v${String(lock.lockfileVersion)}: ${lockUrl.href}. Versions are locked; engine declarations come from the lockfile.`;

    return report;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
