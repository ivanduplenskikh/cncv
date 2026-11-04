import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';

import { renderReport } from '../src/check.js';
import { renderHtmlReport } from '../src/html.js';
import { inspectRemoteProject, remoteManifestUrl, resolveNodeVersion } from '../src/remote.js';

const input = 'https://github.com/microsoft/azure-pipelines-tasks/blob/master/Tasks/AzureCLIV1/package.json';
const raw = 'https://raw.githubusercontent.com/microsoft/azure-pipelines-tasks/master/Tasks/AzureCLIV1/package.json';

async function releaseCache(context: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cncv-node-cache-'));
  context.mock.method(os, 'homedir', () => directory);
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const cacheDirectory = path.join(directory, '.cncv', 'cache');
  await mkdir(cacheDirectory, { recursive: true });

  return path.join(cacheDirectory, 'node-releases.json');
}

await test('Node release cache shares fresh metadata across majors and concurrent lookups', async (context) => {
  const filePath = await releaseCache(context);
  const releases = [{ version: 'v18.20.8' }, { version: 'v20.19.0' }];
  const request = context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(JSON.stringify(releases))));
  assert.deepEqual(await Promise.all([resolveNodeVersion('18'), resolveNodeVersion('20')]), ['18.20.8', '20.19.0']);
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  await assert.rejects(resolveNodeVersion('999'), /No published stable/);
  assert.equal(request.mock.callCount(), 1);
  assert.match(await readFile(filePath, 'utf8'), /v18.20.8/);
});

await test('Node release cache revalidates daily with HTTP validators and accepts newer metadata', async (context) => {
  const filePath = await releaseCache(context);
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  let requests = 0;
  const modified = 'Wed, 01 Jan 2025 00:00:00 GMT';
  context.mock.method(globalThis, 'fetch', (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests++;
    assert.equal(url, 'https://nodejs.org/dist/index.json');

    if (requests === 2) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('if-none-match'), '"index-v1"');
      assert.equal(headers.get('if-modified-since'), modified);

      return Promise.resolve(new Response(null, { status: 304 }));
    }

    return Promise.resolve(new Response(JSON.stringify([{ version: requests === 1 ? 'v18.20.8' : 'v18.20.9' }]), {
      headers: requests === 1 ? { etag: '"index-v1"', 'last-modified': modified } : { etag: '"index-v2"' },
    }));
  });
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  now += 86_400_000 - 1;
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.equal(requests, 1);
  now++;
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.equal(requests, 2);
  const revalidated: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(revalidated, {
    checkedAt: now, releases: [{ version: 'v18.20.8' }], etag: '"index-v1"', lastModified: modified,
  });
  now += 86_400_000;
  assert.equal(await resolveNodeVersion('18'), '18.20.9');
  assert.equal(requests, 3);
  const updated: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(updated, { checkedAt: now, releases: [{ version: 'v18.20.9' }], etag: '"index-v2"' });
});

await test('Node release cache warns on stale fallback and throttles failed refreshes for a day', async (context) => {
  const filePath = await releaseCache(context);
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const checkedAt = now - 86_400_000;
  await writeFile(filePath, JSON.stringify({ checkedAt, releases: [{ version: 'v18.20.8' }] }));
  const warnings: string[] = [];
  context.mock.method(console, 'error', (message: unknown): void => {
    warnings.push(String(message));
  });
  let requests = 0;
  context.mock.method(globalThis, 'fetch', (): Promise<Response> => {
    requests++;

    return requests === 1 ? Promise.reject(new Error('Offline'))
      : Promise.resolve(new Response(JSON.stringify([{ version: 'v18.20.9' }])));
  });
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.equal(requests, 1);
  assert.match(warnings.join('\n'), /stale cached/);
  const failed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(failed, { checkedAt, releases: [{ version: 'v18.20.8' }], retryAfter: now + 86_400_000 });
  now += 86_400_000;
  assert.equal(await resolveNodeVersion('18'), '18.20.9');
  assert.equal(requests, 2);
  const recovered: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(recovered, { checkedAt: now, releases: [{ version: 'v18.20.9' }] });
});

await test('Node release cache replaces corrupt data and does not overwrite valid data with invalid responses', async (context) => {
  const filePath = await releaseCache(context);
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  context.mock.method(console, 'error', () => undefined);
  let response = [{ version: 'v18.20.8' }];
  let requests = 0;
  context.mock.method(globalThis, 'fetch', (): Promise<Response> => {
    requests++;

    return Promise.resolve(new Response(JSON.stringify(response)));
  });

  for (const corrupt of ['{', JSON.stringify({ checkedAt: now, releases: [{ version: 'invalid' }] }),
    JSON.stringify({ checkedAt: now + 86_400_000, releases: [{ version: 'v18.0.0' }] })]) {
    await writeFile(filePath, corrupt);
    assert.equal(await resolveNodeVersion('18'), '18.20.8');
  }

  assert.equal(requests, 3);
  now += 86_400_000;
  response = [{ version: 'invalid' }];
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.match(await readFile(filePath, 'utf8'), /v18.20.8/);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /invalid/);
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.equal(requests, 4);
});

await test('Node release cache write failures do not break a valid lookup or leave temporary files', async (context) => {
  const filePath = await releaseCache(context);
  await mkdir(filePath);
  const warning = context.mock.method(console, 'error', () => undefined);
  context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(JSON.stringify([{ version: 'v18.20.8' }]))));
  assert.equal(await resolveNodeVersion('18'), '18.20.8');
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(await readdir(path.dirname(filePath)), ['node-releases.json']);
});

await test('resolves Node major versions to the latest stable release from the official index', async () => {
  const requests: string[] = [];
  const request = (url: string): Promise<unknown> => {
    requests.push(url);

    return Promise.resolve([
      { version: 'v18.20.2' }, { version: 'v20.0.0' }, { version: 'v18.20.10' },
      { version: 'v18.9.9' }, { version: 'v18.21.0-rc.1' }, { version: 'v18.20.8' },
    ]);
  };
  assert.equal(await resolveNodeVersion('18', request), '18.20.10');
  assert.deepEqual(requests, ['https://nodejs.org/dist/index.json']);
  assert.equal(await resolveNodeVersion('v18', request), '18.20.10');
});

await test('exact and invalid Node targets do not fetch release metadata', async () => {
  const request = (): Promise<unknown> => Promise.reject(new Error('Unexpected release lookup'));
  assert.equal(await resolveNodeVersion('18.20.8', request), '18.20.8');
  assert.equal(await resolveNodeVersion('v18.20.8', request), '18.20.8');
  assert.equal(await resolveNodeVersion('22.0.0-rc.1', request), '22.0.0-rc.1');

  for (const invalid of ['18.20', '>=18', '18.x', 'latest', '018', '-1', '', '999999999999999999999']) {
    await assert.rejects(resolveNodeVersion(invalid, request), /exact version.*major version/);
  }
});

await test('Node major lookup reports unavailable releases, malformed data, and network failures', async () => {
  for (const data of [[], [{ version: 'v20.0.0' }], [{ version: 'v18.21.0-rc.1' }]]) {
    await assert.rejects(resolveNodeVersion('18', () => Promise.resolve(data)), /No published stable Node.js release/);
  }

  for (const data of [null, {}, [{ version: 18 }], [{ version: 'invalid' }]]) {
    await assert.rejects(resolveNodeVersion('18', () => Promise.resolve(data)), /Invalid Node.js release index/);
  }

  await assert.rejects(resolveNodeVersion('18', () => Promise.reject(new Error('Network unavailable'))), /Network unavailable/);
});

await test('converts nested GitHub blob URLs and accepts raw URLs', () => {
  assert.equal(remoteManifestUrl(input).href, raw);
  assert.equal(remoteManifestUrl(`${raw}?x=1#test`).href, raw);

  for (const url of ['http://github.com/a/b/blob/main/package.json', 'https://example.com/package.json',
    'https://github.com/a/b', 'https://user:pass@github.com/a/b/blob/main/package.json']) {
    assert.throws(() => remoteManifestUrl(url));
  }
});

await test('converts GitHub tree directories to package manifest URLs', () => {
  const directory = 'https://github.com/microsoft/azure-pipelines-tasks-common-packages/tree/main/common-npm-packages/azure-arm-rest';
  const manifest = 'https://raw.githubusercontent.com/microsoft/azure-pipelines-tasks-common-packages/main/common-npm-packages/azure-arm-rest/package.json';
  assert.equal(remoteManifestUrl(directory).href, manifest);
  assert.equal(remoteManifestUrl(`${directory}/?x=1#test`).href, manifest);
  assert.equal(remoteManifestUrl('https://github.com/a/b/tree/main').href,
    'https://raw.githubusercontent.com/a/b/main/package.json');

  for (const url of ['https://github.com/a/b/tree', 'https://github.com/a/b/blob/main/README.md',
    'https://raw.githubusercontent.com/a/b/main/directory', 'https://example.com/a/b/tree/main']) {
    assert.throws(() => remoteManifestUrl(url));
  }
});

await test('remote locked dependencies reuse tracing, exclude dev packages, and preserve nested versions', async () => {
  const manifest = { name: 'project', dependencies: { parent: '*', shared: '*' }, devDependencies: { dev: '*' } };
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': manifest,
      'node_modules/parent': { version: '1.0.0', dependencies: { shared: '*' } },
      'node_modules/shared': { version: '1.0.0', engines: { node: '>=10' } },
      'node_modules/parent/node_modules/shared': { version: '2.0.0', engines: { node: '>=22' } },
      'node_modules/dev': { version: '1.0.0', engines: { node: '>=24' } },
    },
  };
  const request = (url: string): Promise<unknown> => Promise.resolve(url === raw ? manifest : lock);
  const report = await inspectRemoteProject(input, { nodeVersion: '20.0.0' }, request);
  assert.equal(report.rows.find((row) => row.name === 'parent')?.status, 'BLOCKED');
  assert.equal(report.rows.filter((row) => row.name === 'shared').length, 2);
  assert.equal(report.rows.some((row) => row.name === 'dev'), false);
  assert.equal(report.exitCode, 1);
  assert.match(report.source ?? '', /Versions are locked/);
  assert.equal(report.rows.every((row) => row.path.startsWith('https://raw.githubusercontent.com/')), true);
  assert.match(renderReport(report), /Remote npm lockfile/);
  assert.match(renderHtmlReport(report, input), /Remote npm lockfile/);
  const direct = await inspectRemoteProject(input, { nodeVersion: '20.0.0', direct: true, omitDev: false }, request);
  assert.equal(direct.rows.find((row) => row.name === 'parent')?.status, 'UNKNOWN');
  assert.equal(direct.rows.some((row) => row.name === 'dev'), true);
});

await test('rejects unsafe lock paths, workspace links, and unsupported lock formats', async () => {
  for (const lock of [
    { lockfileVersion: 3, packages: { '../escape': {} } },
    { lockfileVersion: 3, packages: { 'node_modules/parent': { link: true } } },
    { lockfileVersion: 1, dependencies: {} },
  ]) {
    await assert.rejects(inspectRemoteProject(input, {}, (url) => Promise.resolve(url === raw ? {} : lock)));
  }

  await assert.rejects(inspectRemoteProject(input, { nodeVersion: 'nope' }), /exact/);
});

await test('missing npm lockfile uses labeled registry estimates with tracing and cycle-safe caching', async () => {
  const requests: string[] = [];
  const manifest = { name: 'project', dependencies: { parent: '^1', second: 'latest' }, devDependencies: { dev: '*' } };
  const request = (url: string): Promise<unknown> => {
    requests.push(url);

    if (url === raw) {
      return Promise.resolve(manifest);
    }

    if (url.endsWith('package-lock.json')) {
      return Promise.resolve(null);
    }

    if (url.endsWith('/parent')) {
      return Promise.resolve({
        versions: {
          '1.0.0': { name: 'parent', version: '1.0.0' },
          '1.5.0': { name: 'parent', version: '1.5.0', dependencies: { second: '^2' } },
          '2.0.0': { name: 'parent', version: '2.0.0', engines: { node: '>=99' } },
        },
      });
    }

    if (url.endsWith('/second')) {
      return Promise.resolve({
        'dist-tags': { latest: '2.0.0' },
        versions: {
          '2.0.0': { name: 'second', version: '2.0.0', engines: { node: '>=22' }, dependencies: { parent: '^1' } },
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };
  const report = await inspectRemoteProject(input, { nodeVersion: '20.0.0' }, request);
  assert.equal(report.rows.length, 3);
  assert.equal(report.rows.find((row) => row.name === 'parent')?.version, '1.5.0');
  assert.equal(report.rows.find((row) => row.name === 'parent')?.status, 'BLOCKED');
  assert.equal(report.rows.find((row) => row.name === 'second')?.status, 'INCOMPATIBLE');
  assert.equal(requests.filter((url) => url.endsWith('/second')).length, 1);
  assert.equal(report.exitCode, 1);
  assert.match(report.source ?? '', /ESTIMATE/);
  assert.match(report.rows.find((row) => row.name === 'parent')?.path ?? '', /registry.npmjs.org\/parent\/1.5.0/);
  assert.match(renderHtmlReport(report, input), /ESTIMATE/);
});

await test('registry estimates check the overridden version and its engines', async () => {
  const report = await inspectRemoteProject(input, { nodeVersion: '20.0.0', npmVersion: '10.0.0' }, (url) => {
    if (url === raw) {
      return Promise.resolve({ dependencies: { child: '*' }, overrides: { child: '1.0.0' } });
    }

    if (url.endsWith('package-lock.json')) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      versions: {
        '1.0.0': { version: '1.0.0', engines: { node: '>=22' } },
        '2.0.0': { version: '2.0.0', engines: { node: '>=10' } },
      },
    });
  });
  assert.equal(report.rows.find((row) => row.name === 'child')?.version, '1.0.0');
  assert.equal(report.rows.find((row) => row.name === 'child')?.status, 'INCOMPATIBLE');
  assert.equal(report.exitCode, 1);
});

await test('registry estimates reject unsupported sources and unavailable versions', async () => {
  for (const range of ['file:../other', 'workspace:*', 'npm:other@1', '^99']) {
    await assert.rejects(inspectRemoteProject(input, {}, (url) => {
      if (url === raw) {
        return Promise.resolve({ dependencies: { parent: range } });
      }

      if (url.endsWith('package-lock.json')) {
        return Promise.resolve(null);
      }

      return Promise.resolve({ versions: { '1.0.0': { version: '1.0.0' } } });
    }));
  }
});

await test('nested npm overrides keep shared versions separate by context and handle cycles', async () => {
  const manifest = {
    dependencies: { parent: '^1', branch: '^1' },
    overrides: { 'parent@^1': { '.': '1.0.0', branch: { leaf: '1.0.0' } }, 'branch@^2': '2.0.0' },
  };
  const report = await inspectRemoteProject(input, { nodeVersion: '20.0.0', npmVersion: '10.0.0' }, (url) => {
    if (url === raw) {
      return Promise.resolve(manifest);
    }

    if (url.endsWith('package-lock.json')) {
      return Promise.resolve(null);
    }

    if (url.endsWith('/parent')) {
      return Promise.resolve({
        versions: {
          '1.0.0': { version: '1.0.0', dependencies: { branch: '^1' } },
          '1.5.0': { version: '1.5.0' },
        },
      });
    }

    if (url.endsWith('/branch')) {
      return Promise.resolve({
        versions: {
          '1.0.0': { version: '1.0.0', dependencies: { leaf: '*', branch: '^1' } },
          '2.0.0': { version: '2.0.0' },
        },
      });
    }

    return Promise.resolve({
      versions: {
        '1.0.0': { version: '1.0.0', engines: { node: '>=22' } },
        '2.0.0': { version: '2.0.0', engines: { node: '>=10' } },
      },
    });
  });
  assert.equal(report.rows.find((row) => row.name === 'parent')?.version, '1.0.0');
  assert.equal(report.rows.find((row) => row.name === 'parent')?.status, 'BLOCKED');
  const branches = report.rows.filter((row) => row.name === 'branch');
  assert.equal(branches.length, 2);
  assert.deepEqual(branches.map((row) => row.status).sort(), ['BLOCKED', 'UNKNOWN']);
  assert.deepEqual(report.rows.filter((row) => row.name === 'leaf').map((row) => row.version), ['1.0.0', '2.0.0']);
  assert.equal(report.exitCode, 1);
});

await test('registry overrides support scoped names, npm references, and flat pnpm selectors', async () => {
  for (const configuration of [
    { overrides: { '@scope/child': '$baseline' } },
    { pnpm: { overrides: { '@scope/child@^1': '1.0.0' } } },
  ]) {
    const report = await inspectRemoteProject(input, { direct: true, npmVersion: '10.0.0' }, (url) => {
      if (url === raw) {
        return Promise.resolve({
          dependencies: { '@scope/child': '^1', baseline: '1.0.0' }, ...configuration,
        });
      }

      if (url.endsWith('package-lock.json')) {
        return Promise.resolve(null);
      }

      return Promise.resolve({
        versions: {
          '1.0.0': { version: '1.0.0', engines: { node: '>=10' } },
          '1.5.0': { version: '1.5.0', engines: { node: '>=99' } },
        },
      });
    });
    assert.equal(report.rows.find((row) => row.name === '@scope/child')?.version, '1.0.0');
    assert.equal(report.exitCode, 0);
    assert.match(report.source ?? '', /overrides/);
  }
});

await test('registry estimates reject unsupported or malformed overrides', async () => {
  for (const configuration of [
    { overrides: { child: 1 } },
    { overrides: { child: '$absent' } },
    { overrides: { child: 'npm:other@1' } },
    { overrides: { 'child@latest': '1.0.0' } },
    { pnpm: { overrides: { 'parent>child': '1.0.0' } } },
    { pnpm: { overrides: { child: { '.': '1.0.0' } } } },
    { overrides: {}, pnpm: { overrides: {} } },
  ]) {
    await assert.rejects(inspectRemoteProject(input, { npmVersion: '10.0.0' }, (url) => {
      if (url === raw) {
        return Promise.resolve({ dependencies: { child: '*' }, ...configuration });
      }

      if (url.endsWith('package-lock.json')) {
        return Promise.resolve(null);
      }

      throw new Error(`Unexpected request: ${url}`);
    }), /override|Unsupported remote dependency/i);
  }
});

await test('remote lockfiles remain authoritative when overrides are declared', async () => {
  const manifest = { dependencies: { child: '*' }, overrides: { child: '1.0.0' } };
  const report = await inspectRemoteProject(input, { npmVersion: '10.0.0' }, (url) => Promise.resolve(url === raw ? manifest : {
    lockfileVersion: 3,
    packages: { 'node_modules/child': { version: '2.0.0', engines: { node: '>=10' } } },
  }));
  assert.equal(report.rows.find((row) => row.name === 'child')?.version, '2.0.0');
  assert.match(report.source ?? '', /Versions are locked/);
});

await test('remote npm engine checks work for both lockfile metadata and registry estimates', async () => {
  const manifest = { name: 'project', dependencies: { child: '*' } };
  const child = { name: 'child', version: '1.0.0', engines: { node: '>=20', npm: '>=10' } };

  for (const locked of [true, false]) {
    const report = await inspectRemoteProject(input, { nodeVersion: '22.14.0', npmVersion: '9.9.0' }, (url) => {
      if (url === raw) {
        return Promise.resolve(manifest);
      }

      if (url.endsWith('package-lock.json')) {
        return Promise.resolve(locked ? { lockfileVersion: 3, packages: { 'node_modules/child': child } } : null);
      }

      return Promise.resolve({ versions: { '1.0.0': child } });
    });
    assert.equal(report.npmVersion, '9.9.0');
    assert.equal(report.rows.find((row) => row.name === 'child')?.npmStatus, 'INCOMPATIBLE');
    assert.equal(report.rows.find((row) => row.name === 'project')?.status, 'BLOCKED');
    assert.match(report.rows.find((row) => row.name === 'project')?.details ?? '', /engines.npm: >=10/);
    assert.equal(report.exitCode, 1);
  }

  await assert.rejects(inspectRemoteProject(input, { npmVersion: 'latest' }), /npm version must be exact/);
});
