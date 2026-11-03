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
