import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderReport } from '../src/check.js';
import { renderHtmlReport } from '../src/html.js';
import { inspectRemoteProject, remoteManifestUrl } from '../src/remote.js';

const input = 'https://github.com/microsoft/azure-pipelines-tasks/blob/master/Tasks/AzureCLIV1/package.json';
const raw = 'https://raw.githubusercontent.com/microsoft/azure-pipelines-tasks/master/Tasks/AzureCLIV1/package.json';

await test('converts nested GitHub blob URLs and accepts raw URLs', () => {
  assert.equal(remoteManifestUrl(input).href, raw);
  assert.equal(remoteManifestUrl(`${raw}?x=1#test`).href, raw);

  for (const url of ['http://github.com/a/b/blob/main/package.json', 'https://example.com/package.json',
    'https://github.com/a/b', 'https://user:pass@github.com/a/b/blob/main/package.json']) {
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
