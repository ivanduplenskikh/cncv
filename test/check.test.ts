import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import type { PackageRow, Report } from '../src/check.js';
import { inspectProject, minimumEngines, renderReport } from '../src/check.js';
import { openHtmlReport, renderHtmlReport, startHtmlReportServer } from '../src/html.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const cliArgs = [cli, '--no-open'];

async function writePackage(directory: string, manifest: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
}

async function fixture(context: TestContext, manifest: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cncv-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await writePackage(directory, manifest);

  return directory;
}

await test('checks root, scoped, dev, optional, peer, and nested packages', async (context) => {
  const directory = await fixture(context, {
    name: 'project',
    engines: { node: '>=20' },
    dependencies: { '@scope/parent': '*' },
    devDependencies: { dev: '*' },
    optionalDependencies: { optional: '*' },
    peerDependencies: { peer: '*' },
  });
  await writePackage(path.join(directory, 'node_modules/@scope/parent'), {
    name: '@scope/parent', version: '1.0.0', engines: { node: '^22 || >=24' }, dependencies: { child: '*' },
  });
  await writePackage(path.join(directory, 'node_modules/@scope/parent/node_modules/child'), {
    name: 'child', version: '2.0.0', engines: { node: '<20' },
  });

  for (const name of ['dev', 'optional', 'peer']) {
    await writePackage(path.join(directory, 'node_modules', name), { name, version: '1.0.0' });
  }

  const report = await inspectProject(directory, { nodeVersion: '22.14.0', omitDev: false });
  assert.equal(report.rows.length, 6);
  assert.equal(report.rows.find((row) => row.name === '@scope/parent')?.status, 'OK');
  assert.equal(report.rows.find((row) => row.name === 'child')?.status, 'INCOMPATIBLE');
  assert.equal(report.rows.find((row) => row.name === 'dev')?.status, 'UNKNOWN');
  assert.equal(report.exitCode, 1);
  const output = renderReport(report);
  assert.match(output, /Node Engine.*Type.*Status/);
  assert.doesNotMatch(output, /@scope\/parent|\| project /);
  assert.match(output, /! INCOMPATIBLE/);
  assert.match(output, /dev.*UNKNOWN/);
});

await test('resolves hoisted packages and deduplicates cycles', async (context) => {
  const directory = await fixture(context, { dependencies: { first: '*', second: '*' } });
  await writePackage(path.join(directory, 'node_modules/first'), { name: 'first', dependencies: { second: '*' } });
  await writePackage(path.join(directory, 'node_modules/second'), { name: 'second', dependencies: { first: '*' } });
  const report = await inspectProject(directory);
  assert.equal(report.rows.length, 3);
  assert.equal(report.exitCode, 0);
});

await test('keeps separate installed versions', async (context) => {
  const directory = await fixture(context, { dependencies: { parent: '*', shared: '*' } });
  await writePackage(path.join(directory, 'node_modules/parent'), { name: 'parent', dependencies: { shared: '*' } });
  await writePackage(path.join(directory, 'node_modules/shared'), { name: 'shared', version: '1.0.0' });
  await writePackage(path.join(directory, 'node_modules/parent/node_modules/shared'), { name: 'shared', version: '2.0.0' });
  const report = await inspectProject(directory);
  assert.deepEqual(report.rows.filter((row) => row.name === 'shared').map((row) => row.version), ['1.0.0', '2.0.0']);
});

await test('direct and omit-dev flags limit traversal and accept a manifest path', async (context) => {
  const directory = await fixture(context, { dependencies: { parent: '*' }, devDependencies: { dev: '*' } });
  await writePackage(path.join(directory, 'node_modules/parent'), { name: 'parent', dependencies: { absent: '*' } });
  const report = await inspectProject(path.join(directory, 'package.json'), { direct: true, omitDev: true });
  assert.equal(report.rows.length, 2);
  assert.equal(report.exitCode, 0);
});

await test('dev dependencies are omitted by default and can be explicitly included', async (context) => {
  const directory = await fixture(context, { name: 'project', devDependencies: { 'dev-only': '*' } });
  const omitted = await inspectProject(directory);
  assert.equal(omitted.rows.length, 1);
  assert.equal(omitted.exitCode, 0);
  const included = await inspectProject(directory, { omitDev: false });
  assert.equal(included.rows.find((row) => row.name === 'dev-only')?.status, 'MISSING');
  assert.equal(included.exitCode, 2);

  for (const flags of [[], ['--omit-dev']]) {
    const result = spawnSync(process.execPath, [...cliArgs, directory, ...flags], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /dev-only/);
  }

  const include = spawnSync(process.execPath, [...cliArgs, directory, '--include-dev'], { encoding: 'utf8' });
  assert.equal(include.status, 2);
  assert.match(include.stdout, /dev-only/);
  const conflict = spawnSync(process.execPath, [...cliArgs, directory, '--include-dev', '--omit-dev'], { encoding: 'utf8' });
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /Cannot combine/);
});

await test('CI mode exits with check status and creates no HTML reports', async (context) => {
  const cases = [
    { manifest: { name: 'compatible', engines: { node: '>=22' } }, status: 0 },
    { manifest: { name: 'incompatible', engines: { node: '<22' } }, status: 1 },
    { manifest: { name: 'incomplete', dependencies: { missing: '*' } }, status: 2 },
  ];

  for (const { manifest, status } of cases) {
    const directory = await fixture(context, manifest);
    const result = spawnSync(process.execPath, [cli, directory, '--ci', '--no-color', '--node', '22.14.0', '--npm', '10.9.2'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HOME: directory, USERPROFILE: directory },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout, /Node.js target: 22.14.0/);
    assert.equal(stripVTControlCharacters(result.stdout), result.stdout);
    assert.doesNotMatch(result.stdout, /[\u2500-\u257f]| +\n/u);
    assert.match(result.stdout, /MINIMUM DEPENDENCY VERSIONS\nMinimum Node.js/);
    assert.doesNotMatch(result.stdout, /HTML report|HTML snapshot|report server/);
    assert.deepEqual(await readdir(directory), ['package.json']);
  }
});

await test('CI colors default on and can be disabled by flag or NO_COLOR', async (context) => {
  const directory = await fixture(context, { name: 'incompatible', engines: { node: '<22' } });
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'dumb' };
  delete env['NO_COLOR'];
  const args = [cli, directory, '--ci', '--node', '22.14.0', '--npm', '10.9.2'];
  const colored = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(colored.status, 1, colored.stderr);
  assert.notEqual(stripVTControlCharacters(colored.stdout), colored.stdout);
  assert.ok(colored.stdout.includes('\u001b[36m'));
  assert.ok(colored.stdout.includes('\u001b[31m'));

  for (const result of [
    spawnSync(process.execPath, [...args, '--no-color'], { encoding: 'utf8', env }),
    spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } }),
  ]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, stripVTControlCharacters(colored.stdout));
  }
});

await test('missing packages and invalid engines make the check incomplete', async (context) => {
  const directory = await fixture(context, { dependencies: { missing: '*', invalid: '*', malformed: '*' } });
  await writePackage(path.join(directory, 'node_modules/invalid'), { engines: { node: 'banana' } });
  await writePackage(path.join(directory, 'node_modules/malformed'), { engines: { node: 22 } });
  const report = await inspectProject(directory);
  assert.equal(report.rows.find((row) => row.name === 'missing')?.status, 'MISSING');
  assert.equal(report.rows.find((row) => row.name === 'invalid')?.status, 'INVALID');
  assert.equal(report.rows.find((row) => row.name === 'malformed')?.status, 'INVALID');
  assert.equal(report.exitCode, 2);
});

await test('malformed dependency manifest does not hide other results', async (context) => {
  const directory = await fixture(context, { dependencies: { broken: '*' } });
  await writePackage(path.join(directory, 'node_modules/broken'), {});
  await writeFile(path.join(directory, 'node_modules/broken/package.json'), '{');
  const report = await inspectProject(directory);
  assert.equal(report.rows.find((row) => row.name === 'broken')?.status, 'ERROR');
  assert.equal(report.exitCode, 2);
});

await test('follows pnpm-style symlinks and resolves dependencies beside real packages', async (context) => {
  const directory = await fixture(context, { dependencies: { linked: '*' } });
  const store = path.join(directory, 'node_modules/.pnpm/linked@1.0.0/node_modules');
  const target = path.join(store, 'linked');
  await writePackage(target, { name: 'linked', dependencies: { child: '*' } });
  await writePackage(path.join(store, 'child'), { name: 'child' });
  await symlink(target, path.join(directory, 'node_modules/linked'), 'dir');
  const report = await inspectProject(directory);
  assert.equal(report.rows.length, 3);
  assert.equal(report.exitCode, 0);
});

await test('rejects invalid target versions and dependency paths', async (context) => {
  const directory = await fixture(context, { dependencies: { '../escape': '*' } });
  await assert.rejects(inspectProject(directory, { nodeVersion: '>=22' }), /exact/);
  await assert.rejects(inspectProject(directory), /Invalid dependency name/);
});

await test('traces unknown packages through compatible intermediates and shared cycles', async (context) => {
  const directory = await fixture(context, { name: 'project', dependencies: { parent: '*', other: '*' } });
  await writePackage(path.join(directory, 'node_modules/parent'), {
    name: 'parent', version: '1.0.0', dependencies: { middle: '*' },
  });
  await writePackage(path.join(directory, 'node_modules/other'), {
    name: 'other', dependencies: { middle: '*' },
  });
  await writePackage(path.join(directory, 'node_modules/middle'), {
    name: 'middle', version: '2.0.0', engines: { node: '>=10' }, dependencies: { parent: '*', leaf: '*' },
  });
  await writePackage(path.join(directory, 'node_modules/leaf'), {
    name: 'leaf', version: '3.0.0', engines: { node: '>=22' },
  });
  const report = await inspectProject(directory, { nodeVersion: '20.0.0' });

  for (const name of ['project', 'parent', 'other']) {
    assert.equal(report.rows.find((row) => row.name === name)?.status, 'BLOCKED');
  }

  const parent = report.rows.find((row) => row.name === 'parent');
  assert.match(parent?.details ?? '', /parent@1.0.0 -> middle@2.0.0 -> leaf@3.0.0/);
  assert.match(parent?.details ?? '', /engines.node: >=22/);
  assert.equal(report.rows.find((row) => row.name === 'middle')?.status, 'OK');
  assert.equal(report.exitCode, 1);
  const output = renderReport(report, { columns: 100 });
  assert.match(output, /! BLOCKED/);
  assert.match(output, /Blocked by/);

  for (const line of output.split('\n').filter((line) => /^[\u2500-\u257f]/u.test(line))) {
    assert.ok(line.length <= 100, line);
  }

  assert.equal(stripVTControlCharacters(renderReport(report, { columns: 100, color: true })), output);

  const direct = await inspectProject(directory, { nodeVersion: '20.0.0', direct: true });
  assert.equal(direct.rows.find((row) => row.name === 'parent')?.status, 'UNKNOWN');
  assert.match(direct.rows.find((row) => row.name === 'parent')?.details ?? '', /tracing skipped/);
  assert.equal(direct.exitCode, 0);
});

await test('unknown packages remain unknown when dependencies pass or lack metadata', async (context) => {
  const directory = await fixture(context, { name: 'project', dependencies: { passing: '*', unknown: '*', leaf: '*' } });
  await writePackage(path.join(directory, 'node_modules/passing'), {
    name: 'passing', dependencies: { compatible: '*' },
  });
  await writePackage(path.join(directory, 'node_modules/compatible'), { name: 'compatible', engines: { node: '>=10' } });
  await writePackage(path.join(directory, 'node_modules/unknown'), { name: 'unknown', dependencies: { leaf: '*' } });
  await writePackage(path.join(directory, 'node_modules/leaf'), { name: 'leaf' });
  const report = await inspectProject(directory, { nodeVersion: '20.0.0' });
  assert.equal(report.rows.find((row) => row.name === 'passing')?.status, 'UNKNOWN');
  assert.match(report.rows.find((row) => row.name === 'passing')?.details ?? '', /Dependency engines satisfied/);
  assert.match(report.rows.find((row) => row.name === 'unknown')?.details ?? '', /metadata unknown: unknown -> leaf/);
  assert.match(report.rows.find((row) => row.name === 'leaf')?.details ?? '', /No dependencies to inspect/);
  assert.equal(report.exitCode, 0);
});

await test('unknown packages explain incomplete dependencies but prioritize incompatible descendants', async (context) => {
  const directory = await fixture(context, { name: 'project', dependencies: { parent: '*' } });
  await writePackage(path.join(directory, 'node_modules/parent'), {
    name: 'parent',
    dependencies: { absent: '*', invalid: '*', broken: '*' },
    devDependencies: { 'dev-only': '*' },
  });
  await writePackage(path.join(directory, 'node_modules/invalid'), { name: 'invalid', engines: { node: 'nope' } });
  await writePackage(path.join(directory, 'node_modules/broken'), {});
  await writeFile(path.join(directory, 'node_modules/broken/package.json'), '{');
  const incomplete = await inspectProject(directory, { nodeVersion: '20.0.0' });
  assert.equal(incomplete.rows.find((row) => row.name === 'parent')?.status, 'UNKNOWN');
  assert.match(incomplete.rows.find((row) => row.name === 'parent')?.details ?? '', /parent -> absent \(MISSING\)/);
  assert.equal(incomplete.rows.some((row) => row.name === 'dev-only'), false);
  assert.equal(incomplete.exitCode, 2);

  await writePackage(path.join(directory, 'node_modules/invalid'), { name: 'invalid', engines: { node: '>=22' } });
  const blocked = await inspectProject(directory, { nodeVersion: '20.0.0' });
  assert.equal(blocked.rows.find((row) => row.name === 'parent')?.status, 'BLOCKED');
  assert.match(blocked.rows.find((row) => row.name === 'parent')?.details ?? '', /parent -> invalid/);
  assert.equal(blocked.exitCode, 2);
});

await test('CLI emits a table and uses compatibility exit codes', async (context) => {
  const directory = await fixture(context, { name: 'example', engines: { node: '>=22' } });
  const compatible = spawnSync(process.execPath, [...cliArgs, directory, '--node', '22.14.0'], { encoding: 'utf8' });
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.doesNotMatch(compatible.stdout, /example|\|.*OK/);
  assert.match(compatible.stdout, /All checked packages are compatible \(1 checked\)/);
  assert.doesNotMatch(compatible.stdout, /HTML report:/);
  const incompatible = spawnSync(process.execPath, [...cliArgs, directory, '--node', '20.0.0'], { encoding: 'utf8' });
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stdout, /INCOMPATIBLE/);
  const invalid = spawnSync(process.execPath, [...cliArgs, directory, '--node', 'oops'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /exact/);
});

await test('CLI supports help and reports unknown flags without a stack trace', () => {
  const help = spawnSync(process.execPath, [...cliArgs, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: cncv/);
  const result = spawnSync(process.execPath, [...cliArgs, '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cncv:/);
  assert.doesNotMatch(result.stderr, /at file:/);
});

await test('CLI resolves Node major targets and keeps exact targets offline', async (context) => {
  const directory = await fixture(context, { name: 'example', engines: { node: '>=18.20.8 <19' } });
  const env = { ...process.env, HOME: directory, USERPROFILE: directory };
  const lookup = `globalThis.fetch = async (url) => {
    if (url !== 'https://nodejs.org/dist/index.json') { throw new Error('Unexpected URL'); }
    return new Response(JSON.stringify([{ version: 'v18.20.2' }, { version: 'v18.20.8' }, { version: 'v20.0.0' }]));
  };`;
  const major = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(lookup)}`,
    ...cliArgs, directory, '--node', '18', '--npm', '10.9.2',
  ], { encoding: 'utf8', env });
  assert.equal(major.status, 0, major.stderr);
  assert.match(major.stdout, /Node.js target: 18.20.8/);
  const offline = 'globalThis.fetch = () => Promise.reject(new Error("Unexpected network request"));';
  const exact = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(offline)}`,
    ...cliArgs, directory, '--node', '18.20.8', '--npm', '10.9.2',
  ], { encoding: 'utf8', env });
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, /Node.js target: 18.20.8/);
  const cached = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(offline)}`,
    ...cliArgs, directory, '--node', '18', '--npm', '10.9.2',
  ], { encoding: 'utf8', env });
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /Node.js target: 18.20.8/);
  await rm(path.join(directory, '.cncv'), { recursive: true, force: true });
  const failedLookup = 'globalThis.fetch = async () => new Response("Unavailable", { status: 503 });';
  const failed = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(failedLookup)}`,
    ...cliArgs, directory, '--node', '18', '--npm', '10.9.2',
  ], { encoding: 'utf8', env });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /HTTP 503 fetching https:\/\/nodejs.org\/dist\/index.json/);
  assert.doesNotMatch(failed.stdout, /Node.js target:/);
});

await test('dependency engine minima respect alternatives, upper bounds, and prereleases', () => {
  const row = (engine: string, npmEngine: string): PackageRow => ({
    name: 'dependency', version: '1.0.0', engine, npmEngine, kind: 'dependency', status: 'OK', path: '.',
  });
  const report: Report = {
    nodeVersion: '24.0.0',
    exitCode: 0,
    rows: [
      { ...row('<10', '<5'), kind: 'project' },
      row('^18 || >=22', '>=9 <11'), row('>=20', '>=10'),
    ],
  };
  const minima = minimumEngines(report);
  assert.equal(minima.node.version, '22.0.0');
  assert.equal(minima.npm.version, '10.0.0');
  assert.equal(minima.node.status, 'complete');
  assert.equal(minimumEngines({ ...report, rows: [row('>=20', '>=9'), row('<20', '<9')] }).node.status, 'conflict');
  assert.equal(minimumEngines({ ...report, rows: [row('>=20', '>=9'), row('<20', '<9')] }).npm.status, 'conflict');
  assert.equal(minimumEngines({ ...report, rows: [row('>22.0.0', '>10.0.0')] }).node.version, '22.0.1');
  assert.equal(minimumEngines({ ...report, rows: [row('>=22.0.0-beta.1', '*'), row('>=20', '*')] }).node.version, '22.0.0');
  assert.equal(minimumEngines({ ...report, rows: [row('22.0.0-beta.1', '*')] }).node.version, '22.0.0-beta.1');
});

await test('minimum conflicts identify dependency ranges without including the root project', () => {
  const row = (name: string, engine: string): PackageRow => ({
    name, version: '1.0.0', engine, npmEngine: engine, kind: 'dependency', status: 'OK', path: name,
  });
  const report: Report = {
    nodeVersion: '24.0.0',
    exitCode: 0,
    rows: [{ ...row('project', '<10'), kind: 'project' }, row('unrestricted', '*'),
      row('modern', '>=22'), row('legacy', '<20')],
  };

  for (const minimum of Object.values(minimumEngines(report))) {
    assert.equal(minimum.status, 'conflict');
    assert.deepEqual(minimum.conflicts, [
      { name: 'modern', version: '1.0.0', range: '>=22' },
      { name: 'legacy', version: '1.0.0', range: '<20' },
    ]);
  }

  const html = renderHtmlReport(report, '.');
  assert.match(html, /Conflicting dependency ranges/);
  assert.match(html, /modern@1.0.0<\/strong>: <code>&gt;=22/);
  assert.match(html, /legacy@1.0.0<\/strong>: <code>&lt;20/);
  const impossible = minimumEngines({ ...report, rows: [row('impossible', '>22 <20')] });
  assert.equal(impossible.node.conflicts?.[0]?.name, 'impossible');
  const collective = minimumEngines({
    ...report, rows: [row('first', '^18 || ^20'), row('second', '^20 || ^22'), row('third', '^18 || ^22')],
  });
  assert.equal(collective.node.status, 'conflict');
  assert.equal(collective.node.conflicts?.length, 3);
});

await test('dependency engine minima disclose incomplete metadata independently for Node and npm', () => {
  const base: PackageRow = {
    name: 'dependency', version: '1.0.0', engine: '>=22', kind: 'dependency', status: 'OK', path: '.',
  };
  const report: Report = { nodeVersion: '24.0.0', exitCode: 0, rows: [base] };
  assert.equal(minimumEngines(report).node.version, '22.0.0');
  assert.equal(minimumEngines(report).npm.status, 'unknown');
  const partial = minimumEngines({ ...report, rows: [base, { ...base, engine: '(not declared)', npmEngine: '>=10' }] });
  assert.equal(partial.node.status, 'partial');
  assert.equal(partial.node.version, '22.0.0');
  assert.equal(partial.npm.status, 'partial');

  for (const status of ['MISSING', 'ERROR'] as const) {
    assert.equal(minimumEngines({ ...report, rows: [base, { ...base, status }] }).node.status, 'partial');
  }

  assert.equal(minimumEngines({ ...report, rows: [{ ...base, engine: 'invalid' }] }).node.status, 'unknown');
  assert.equal(minimumEngines({ ...report, rows: [{ ...base, engine: '*' }] }).node.status, 'unknown');
  assert.equal(minimumEngines({ ...report, rows: [] }).node.status, 'unknown');
});

await test('terminal and HTML show both dependency minima even when all packages are compatible', async (context) => {
  const directory = await fixture(context, { engines: { node: '>=20' }, dependencies: { first: '*', second: '*' } });
  await writePackage(path.join(directory, 'node_modules/first'), { engines: { node: '^18 || >=22', npm: '>=9 <11' } });
  await writePackage(path.join(directory, 'node_modules/second'), { engines: { node: '>=20', npm: '>=10' } });
  const report = await inspectProject(directory, { nodeVersion: '24.0.0', npmVersion: '10.0.0' });

  for (const output of [renderReport(report), renderHtmlReport(report, directory)]) {
    assert.match(output, /Minimum Node.js \(engines.node\): 22.0.0/);
    assert.match(output, /Minimum npm \(engines.npm\): 10.0.0/);
    assert.match(output, /All checked packages are compatible/);
    assert.match(output, /Upper bounds still apply/);
  }

  const incompatible = await inspectProject(directory, { nodeVersion: '16.0.0', npmVersion: '8.0.0' });
  assert.match(renderReport(incompatible), /Minimum Node.js \(engines.node\): 22.0.0/);
  assert.match(renderHtmlReport(incompatible, directory), /Minimum npm \(engines.npm\): 10.0.0/);
  assert.equal(incompatible.exitCode, 1);
});

await test('terminal and HTML label partial, conflicting, and unknown dependency minima', () => {
  const base: PackageRow = {
    name: 'dependency', version: '1.0.0', engine: '>=22', npmEngine: '>=10', kind: 'dependency', status: 'OK', path: '.',
  };
  const render = (rows: PackageRow[]): string[] => {
    const report: Report = { nodeVersion: '24.0.0', rows, exitCode: 0 };

    return [renderReport(report), renderHtmlReport(report, '.')];
  };

  for (const output of render([base, { ...base, engine: '(not declared)', npmEngine: 'invalid' }])) {
    assert.match(output, /22.0.0 \(partial\)/);
    assert.match(output, /10.0.0 \(partial\)/);
  }

  for (const output of render([base, { ...base, engine: '<20', npmEngine: '<9' }])) {
    assert.match(output, /engines.node\): conflict/);
    assert.match(output, /engines.npm\): conflict/);
  }

  for (const output of render([])) {
    assert.match(output, /engines.node\): unknown/);
    assert.match(output, /engines.npm\): unknown/);
  }
});

await test('minimum information blocks are highlighted, responsive, and bounded to terminal width', () => {
  const report: Report = {
    nodeVersion: '24.0.0', exitCode: 0, rows: [],
  };

  for (const columns of [64, 80, 140]) {
    const plain = renderReport(report, { columns });
    const colored = renderReport(report, { columns, color: true });
    assert.match(plain, /MINIMUM DEPENDENCY VERSIONS/);
    assert.notEqual(colored, plain);
    assert.equal(stripVTControlCharacters(colored), plain);
    const lines = plain.split('\n').filter((line) => /^[\u2500-\u257f]/u.test(line));
    assert.ok(lines.length > 3);
    assert.ok(lines.every((line) => line.length === columns));
  }

  const html = renderHtmlReport(report, '.');
  assert.match(html, /class="minimums" aria-label="Minimum dependency versions"/);
  assert.equal((html.match(/class="minimum-item" data-status="unknown"/g) ?? []).length, 2);
  assert.match(html, /class="minimum-value"/);
  assert.match(html, /\.minimum-values \{ grid-template-columns: minmax\(0, 1fr\)/);
});

await test('plain reports retain package evidence without table formatting', () => {
  const report: Report = {
    nodeVersion: '25.9.0',
    npmVersion: '11.12.1',
    exitCode: 1,
    source: 'Remote npm lockfile',
    rows: [
      { name: 'compatible', version: '1.0.0', engine: '>=18', kind: 'dependency', status: 'OK', path: '.' },
      {
        name: 'blocked',
        version: '2.0.0',
        engine: '(not declared)',
        npmEngine: '<11',
        npmStatus: 'INCOMPATIBLE',
        kind: 'dependency',
        status: 'BLOCKED',
        path: '.',
        engineIssues: ['npm target excluded'],
        details: 'Dependency\nrequires another version.',
      },
    ],
  };
  const output = renderReport(report, { format: 'plain', columns: 64 });
  assert.equal(output, renderReport(report, { format: 'plain', columns: 140 }));
  const colored = renderReport(report, { format: 'plain', color: true, columns: 64 });
  assert.notEqual(colored, output);
  assert.equal(stripVTControlCharacters(colored), output);
  assert.equal(stripVTControlCharacters(output), output);
  assert.doesNotMatch(output, /[\u2500-\u257f]| +\n/u);
  assert.match(output, /Remote npm lockfile/);
  assert.match(output, /BLOCKED: blocked@2.0.0 \(dependency\)\n {2}Node engine: \(not declared\)/);
  assert.match(output, /npm engine: <11 \(INCOMPATIBLE\)/);
  assert.match(output, /npm target excluded\n {2}Dependency requires another version\./);
  assert.match(output, /1 blocked, 1 compatible \(hidden\)$/);
});

await test('full-width detail rows align with table borders', () => {
  const report: Report = {
    nodeVersion: '25.9.0',
    npmVersion: '11.12.1',
    exitCode: 0,
    rows: [{
      name: 'emoji-regex',
      version: '8.0.0',
      engine: '(not declared)',
      kind: 'dependency',
      status: 'UNKNOWN',
      path: '.',
      details: 'No dependencies to inspect; package compatibility remains unknown.',
    }],
  };

  for (const columns of [64, 80, 100, 140]) {
    for (const color of [false, true]) {
      const output = stripVTControlCharacters(renderReport(report, { columns, color }));
      const lines = output.split('\n').filter((line) => /^[\u2500-\u257f]/u.test(line));
      assert.ok(lines.every((line) => line.length === columns), output);
    }
  }
});

await test('table wraps long cells, sorts by severity and name, and highlights incompatibilities', () => {
  const makeRow = (name: string, status: PackageRow['status']): PackageRow => ({
    name, status, version: '1.0.0', engine: '>=20', kind: 'dependency', path: name,
  });
  const report: Report = {
    nodeVersion: '10.14.0',
    exitCode: 2,
    rows: [
      makeRow('unknown', 'UNKNOWN'), makeRow('zebra', 'INCOMPATIBLE'),
      makeRow('missing', 'MISSING'), makeRow('alpha', 'INCOMPATIBLE'),
      { ...makeRow('broken', 'ERROR'), engine: 'A very long error message '.repeat(12) },
      makeRow('invalid', 'INVALID'), makeRow('compatible', 'OK'),
      makeRow('@scope/a-very-long-package-name', 'UNKNOWN'),
    ],
  };
  const original = [...report.rows];
  const plain = renderReport(report, { columns: 80 });
  const colored = renderReport(report, { columns: 80, color: true });
  assert.equal(stripVTControlCharacters(colored), plain);
  assert.notEqual(colored, plain);
  assert.match(plain, /! INCOMPATIBLE/);
  assert.match(plain, /@scope/);
  assert.doesNotMatch(plain, /\u2026/u);
  assert.equal(stripVTControlCharacters(plain), plain);
  const tableLines = plain.split('\n').filter((line) => /^[\u2500-\u257f]/u.test(line));
  const tableOutput = tableLines.slice(tableLines.findIndex((line) => line.includes('Package'))).join('\n');
  const names = ['alpha', 'zebra', 'broken', 'invalid', 'missing', 'unknown'];

  for (const [index, name] of names.entries()) {
    const next = names[index + 1];

    if (next !== undefined) {
      assert.ok(tableOutput.indexOf(name) < tableOutput.indexOf(next));
    }
  }

  assert.ok(tableLines.length > report.rows.length);

  for (const line of tableLines) {
    assert.ok(line.length <= 80, line);
  }

  assert.deepEqual(report.rows, original);
});

await test('HTML escapes package metadata and preserves severity ordering and hidden compatible rows', () => {
  const makeRow = (name: string, status: PackageRow['status']): PackageRow => ({
    name, status, version: '1.0.0', engine: '<22', kind: 'dependency', path: '/project/<path>',
  });
  const report: Report = {
    nodeVersion: '22.14.0',
    exitCode: 1,
    rows: [makeRow('unknown', 'UNKNOWN'), makeRow('hidden-compatible', 'OK'),
      { ...makeRow('<script>alert("test")</script>', 'INCOMPATIBLE'), details: '<img src=x onerror=alert(1)>' },
      makeRow('blocked', 'BLOCKED')],
  };
  const html = renderHtmlReport(report, '<project>');
  assert.doesNotMatch(html, /<script>|<img|hidden-compatible/);
  assert.match(html, /&lt;script&gt;alert\(&quot;test&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;project&gt;/);
  assert.match(html, /! BLOCKED/);
  assert.ok(html.indexOf('! INCOMPATIBLE') < html.indexOf('! BLOCKED'));
  assert.match(html, /default-src 'none'/);
  assert.match(renderHtmlReport({ nodeVersion: '22.14.0', rows: [makeRow('good', 'OK')], exitCode: 0 }, '.'), /All checked packages are compatible/);
});

await test('HTML prioritizes actionable results, splits counts, and collapses unknown metadata', () => {
  const row = (name: string, status: PackageRow['status']): PackageRow => ({
    name, status, version: '1.0.0', engine: '(not declared)', kind: 'dependency', path: '/project/package.json',
  });
  const legacy = row('legacy', 'INCOMPATIBLE');
  legacy.engine = '<20';
  legacy.engineIssues = ['engines.node: <20 (incompatible, target 25.9.0)'];
  legacy.path = 'https://raw.githubusercontent.com/a/b/main/package-lock.json#node_modules%2Flegacy%2Fpackage.json';
  const report: Report = {
    nodeVersion: '25.9.0',
    npmVersion: '11.12.1',
    exitCode: 2,
    rows: [
      { ...row('example-project', 'BLOCKED'), kind: 'project', details: 'Blocked by legacy@1.0.0.' },
      legacy,
      row('missing-peer', 'MISSING'), row('unknown-package', 'UNKNOWN'), row('hidden-compatible', 'OK'),
    ],
  };
  const original = JSON.stringify(report);
  const html = renderHtmlReport(report, 'https://github.com/a/b/tree/main');
  assert.match(html, /<h1>example-project<\/h1>/);
  assert.match(html, /Check incomplete/);
  assert.match(html, /1<\/strong><span>Incompatible/);
  assert.match(html, /1<\/strong><span>Blocked/);
  assert.match(html, /1<\/strong><span>Missing/);
  assert.match(html, /1<\/strong><span>Unknown/);
  assert.match(html, /not additional engine mismatches/);
  assert.match(html, /<details class="unknowns"><summary>1 package without Node.js engine declarations/);
  assert.ok(html.indexOf('aria-label="Actionable results"') < html.indexOf('class="minimums"'));
  assert.ok(html.indexOf('class="minimums"') < html.indexOf('class="unknowns"'));
  assert.match(html, /node_modules\/legacy\/package.json<\/a>/);
  assert.match(html, /<div class="row-heading"><h3>legacy.*! INCOMPATIBLE/);
  assert.doesNotMatch(html, /<table|<script|hidden-compatible|min-width: 900px/);
  assert.equal(JSON.stringify(report), original);

  const unsafe = renderHtmlReport({ ...report, rows: [{ ...row('unsafe', 'MISSING'), path: 'javascript:alert(1)' }] }, '.');
  assert.doesNotMatch(unsafe, /href="javascript:/);
  const estimate = renderHtmlReport({ ...report, source: 'ESTIMATE: metadata only' }, '.');
  assert.match(estimate, /<p class="project amber">ESTIMATE:/);
});

await test('npm engine mismatches affect status, tracing, HTML, and CLI exit codes', async (context) => {
  const directory = await fixture(context, { name: 'project', dependencies: { child: '*' } });
  await writePackage(path.join(directory, 'node_modules/child'), {
    name: 'child', version: '1.0.0', engines: { node: '>=20', npm: '>=10' },
  });
  const report = await inspectProject(directory, { nodeVersion: '22.14.0', npmVersion: '9.9.0' });
  assert.equal(report.npmVersion, '9.9.0');
  assert.equal(report.rows.find((row) => row.name === 'child')?.nodeStatus, 'OK');
  assert.equal(report.rows.find((row) => row.name === 'child')?.npmStatus, 'INCOMPATIBLE');
  assert.equal(report.rows.find((row) => row.name === 'child')?.status, 'INCOMPATIBLE');
  assert.equal(report.rows.find((row) => row.name === 'project')?.status, 'BLOCKED');
  assert.match(report.rows.find((row) => row.name === 'project')?.details ?? '', /engines.npm: >=10/);
  assert.equal(report.exitCode, 1);
  assert.match(renderReport(report), /npm target: 9.9.0/);
  assert.match(renderReport(report), /npm engine: >=10/);
  assert.match(renderHtmlReport(report, directory), /npm Engine/);
  assert.match(renderHtmlReport(report, directory), /engines.npm: &gt;=10/);
  const compatible = await inspectProject(directory, { nodeVersion: '22.14.0', npmVersion: '10.9.2' });
  assert.equal(compatible.rows.find((row) => row.name === 'child')?.status, 'OK');
  assert.equal(compatible.exitCode, 0);
  assert.doesNotMatch(renderReport(compatible), /\| child/);
  const cliResult = spawnSync(process.execPath, [...cliArgs, directory, '--node', '22.14.0', '--npm', '9.9.0'], { encoding: 'utf8' });
  assert.equal(cliResult.status, 1, cliResult.stderr);
  assert.match(cliResult.stdout, /npm target: 9.9.0/);
});

await test('missing npm declarations do not change node results and invalid npm engines are incomplete', async (context) => {
  const directory = await fixture(context, { name: 'project', engines: { node: '>=20' } });
  const options = { nodeVersion: '22.14.0', npmVersion: '10.9.2' };
  assert.equal((await inspectProject(directory, options)).rows[0]?.status, 'OK');

  for (const npm of ['banana', 10, null]) {
    await writePackage(directory, { name: 'project', engines: { node: '>=20', npm } });
    const report = await inspectProject(directory, options);
    assert.equal(report.rows[0]?.status, 'INVALID');
    assert.equal(report.exitCode, 2);
  }

  await writePackage(directory, { name: 'project', engines: { npm: '>=10' } });
  assert.equal((await inspectProject(directory, options)).rows[0]?.status, 'UNKNOWN');
  await assert.rejects(inspectProject(directory, { npmVersion: '>=10' }), /npm version must be exact/);
  const cliResult = spawnSync(process.execPath, [...cliArgs, directory, '--npm', 'nope'], { encoding: 'utf8' });
  assert.equal(cliResult.status, 2);
  assert.match(cliResult.stderr, /npm version must be exact/);
  const missingNpm = spawnSync(process.execPath, [...cliArgs, directory], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  assert.equal(missingNpm.status, 2);
  assert.match(missingNpm.stderr, /Cannot detect npm version/);
  const explicitNpm = spawnSync(process.execPath, [...cliArgs, directory, '--npm', '10.9.2'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  assert.equal(explicitNpm.status, 0, explicitNpm.stderr);
  assert.match(explicitNpm.stdout, /npm target: 10.9.2/);
});

await test('HTML page loads regenerate the report from current dependency metadata', async (context) => {
  const directory = await fixture(context, { dependencies: { child: '*' }, engines: { node: '>=20' } });
  const child = path.join(directory, 'node_modules/child');
  await writePackage(child, { name: 'child', version: '1.0.0', engines: { node: '>=22' } });
  const server = await startHtmlReportServer(directory, () => inspectProject(directory, {
    nodeVersion: '20.0.0', npmVersion: '10.0.0',
  }));
  context.after(server.close);
  const first = await fetch(server.url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.match(await first.text(), /1.0.0/);
  await writePackage(child, { name: 'child', version: '2.0.0', engines: { node: '>=10' } });
  const second = await fetch(server.url);
  assert.match(await second.text(), /All checked packages are compatible/);
  assert.equal((await fetch(new URL('/package.json', server.url))).status, 404);
  assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
  const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    httpRequest(server.url, { headers: { host: 'example.com' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(invalidHostStatus, 404);
});

await test('HTML regeneration errors are escaped and a later page load can recover', async (context) => {
  let attempts = 0;
  const server = await startHtmlReportServer('/project', () => {
    attempts++;

    if (attempts === 1) {
      return Promise.reject(new Error('<script>broken</script>'));
    }

    return Promise.resolve({ nodeVersion: '22.14.0', rows: [], exitCode: 0 });
  });
  context.after(server.close);
  const head = await fetch(server.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(attempts, 0);
  const failed = await fetch(server.url);
  assert.equal(failed.status, 500);
  const html = await failed.text();
  assert.match(html, /&lt;script&gt;broken&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const recovered = await fetch(server.url);
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /All checked packages are compatible/);
});

await test('HTML opener launches the live URL and closes the server on launch failure', async (context) => {
  const report: Report = { nodeVersion: '22.14.0', rows: [], exitCode: 0 };
  let launchUrl = '';
  const launch = async (url: string): Promise<void> => {
    launchUrl = url;
    assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal((await fetch(url)).status, 200);
  };
  const result = await openHtmlReport(report, '/project', launch, () => Promise.resolve(report));
  context.after(async () => {
    await result.close?.();
    await rm(path.dirname(result.filePath), { recursive: true, force: true });
  });
  assert.equal(result.url, launchUrl);
  assert.equal(result.warning, undefined);
  assert.match(await readFile(result.filePath, 'utf8'), /Node.js Compatibility/);
  const failed = await openHtmlReport(report, '/project', (url) => {
    launchUrl = url;

    return Promise.reject(new Error('No desktop browser'));
  }, () => Promise.resolve(report));
  context.after(async () => {
    await rm(path.dirname(failed.filePath), { recursive: true, force: true });
  });
  assert.equal(failed.url, undefined);
  assert.match(failed.warning ?? '', /No desktop browser/);
  await assert.rejects(fetch(launchUrl));
});

await test('HTML report names persist per project path and safely include the project name', async (context) => {
  const home = await fixture(context, {});
  context.mock.method(os, 'homedir', () => home);
  const parent = await fixture(context, {});
  const directory = path.join(parent, 'my-repo');
  await writePackage(directory, { name: '@scope/my-project', engines: { node: '>=20' } });
  const report = await inspectProject(directory, { nodeVersion: '22.14.0', npmVersion: '10.0.0' });
  const launch = (): Promise<void> => Promise.resolve();
  const first = await openHtmlReport(report, directory, launch);
  context.after(async () => {
    await rm(path.dirname(first.filePath), { recursive: true, force: true });
  });
  const second = await openHtmlReport({ ...report, nodeVersion: '24.0.0' }, path.join(directory, 'package.json'), launch);
  assert.equal(first.filePath, second.filePath);
  assert.equal(path.basename(first.filePath), 'project.html');
  assert.equal(path.basename(path.dirname(first.filePath)), 'my-repo');
  assert.match(await readFile(first.filePath, 'utf8'), /<title>cncv \| @scope\/my-project \| Node.js 24.0.0<\/title>/);
  const history: unknown[] = (await readFile(path.join(path.dirname(first.filePath), 'history.jsonl'), 'utf8'))
    .trim().split('\n').map((line): unknown => JSON.parse(line));
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((entry) => (entry as { report: Report }).report.nodeVersion), ['22.14.0', '24.0.0']);
  const otherParent = await fixture(context, {});
  const otherDirectory = path.join(otherParent, 'my-repo');
  await writePackage(otherDirectory, { name: '@scope/my-project' });
  const other = await openHtmlReport(report, otherDirectory, launch);
  context.after(async () => {
    await rm(path.dirname(other.filePath), { recursive: true, force: true });
  });
  assert.notEqual(other.filePath, first.filePath);
  assert.match(path.basename(path.dirname(other.filePath)), /^my-repo-[a-f0-9]{16}$/);
  const server = await startHtmlReportServer(directory, () => Promise.resolve(report), report);
  context.after(server.close);
  const nextServer = await startHtmlReportServer(directory, () => Promise.resolve(report), report);
  context.after(nextServer.close);
  const firstUrl = new URL(server.url);
  const nextUrl = new URL(nextServer.url);
  const uuidRoute = /^\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/scope-my-project\.html$/;
  assert.match(firstUrl.pathname, uuidRoute);
  assert.match(nextUrl.pathname, uuidRoute);
  assert.notEqual(firstUrl.pathname, nextUrl.pathname);
  assert.equal((await fetch(new URL(nextUrl.pathname, firstUrl))).status, 404);
  assert.equal((await fetch(firstUrl)).status, 200);
});

await test('HTML names fall back to the check path and normalize equivalent remote URLs', async (context) => {
  const launch = (): Promise<void> => Promise.resolve();
  const report: Report = { nodeVersion: '22.14.0', rows: [], exitCode: 0 };
  const directory = await fixture(context, {});
  context.mock.method(os, 'homedir', () => directory);
  const local = await openHtmlReport(report, directory, launch);
  context.after(async () => {
    await rm(path.dirname(local.filePath), { recursive: true, force: true });
  });
  assert.equal(path.basename(local.filePath), 'project.html');
  assert.equal(path.basename(path.dirname(local.filePath)), path.basename(directory).toLowerCase());
  const blob = 'https://github.com/owner/repository/blob/main/packages/my-package/package.json';
  const raw = 'https://raw.githubusercontent.com/owner/repository/main/packages/my-package/package.json';
  const first = await openHtmlReport(report, blob, launch);
  const second = await openHtmlReport(report, `${raw}?test=1#fragment`, launch);
  context.after(async () => {
    await rm(path.dirname(first.filePath), { recursive: true, force: true });
  });
  assert.equal(first.filePath, second.filePath);
  assert.equal(path.basename(first.filePath), 'project.html');
  assert.equal(path.basename(path.dirname(first.filePath)), 'repository');
  assert.match(await readFile(first.filePath, 'utf8'), /<title>cncv \| my-package \|/);

  for (const name of ['CON', '../../<script>alert(1)</script>']) {
    const named: Report = {
      ...report,
      rows: [{
        name, kind: 'project', version: '1.0.0', engine: '>=20', status: 'OK', path: directory,
      }],
    };
    const result = await openHtmlReport(named, directory, launch);
    context.after(async () => {
      await rm(path.dirname(result.filePath), { recursive: true, force: true });
    });
    assert.equal(path.basename(result.filePath), 'project.html');
    assert.match(path.basename(path.dirname(result.filePath)), /^[a-z0-9-]+$/);
    assert.doesNotMatch(await readFile(result.filePath, 'utf8'), /<script>/);

  }

  const reserved = await openHtmlReport(report, path.join(directory, 'CON'), launch);
  assert.equal(path.basename(path.dirname(reserved.filePath)), 'project-con');
});

await test('HTML refreshes update the permanent report and append history only after successful checks', async (context) => {
  const directory = await fixture(context, {});
  context.mock.method(os, 'homedir', () => directory);
  const first: Report = { nodeVersion: '22.14.0', rows: [], exitCode: 0 };
  const updated: Report = { ...first, nodeVersion: '24.0.0' };
  let fail = false;
  const result = await openHtmlReport(first, directory, () => Promise.resolve(), () => {
    if (fail) {
      return Promise.reject(new Error('Inspection failed'));
    }

    return Promise.resolve(updated);
  });
  context.after(async () => {
    await result.close?.();
  });
  assert.ok(result.url);
  const historyPath = path.join(path.dirname(result.filePath), 'history.jsonl');
  const initialHistory = await readFile(historyPath, 'utf8');
  assert.equal((await fetch(result.url, { method: 'HEAD' })).status, 200);
  assert.equal(await readFile(historyPath, 'utf8'), initialHistory);
  await Promise.all([fetch(result.url), fetch(result.url)]);
  const historyText = await readFile(historyPath, 'utf8');
  const history: unknown[] = historyText.trim().split('\n').map((line): unknown => JSON.parse(line));
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((entry) => (entry as { report: Report }).report), [first, updated, updated]);
  assert.match(await readFile(result.filePath, 'utf8'), /Node.js 24.0.0/);
  fail = true;
  assert.equal((await fetch(result.url)).status, 500);
  assert.equal(await readFile(historyPath, 'utf8'), historyText);
  assert.match(await readFile(result.filePath, 'utf8'), /Node.js 24.0.0/);
});

await test('HTML history failures preserve existing files and allow later saves to recover', async (context) => {
  const directory = await fixture(context, {});
  context.mock.method(os, 'homedir', () => directory);
  const report: Report = { nodeVersion: '22.14.0', rows: [], exitCode: 0 };
  const launch = (): Promise<void> => Promise.resolve();
  const first = await openHtmlReport(report, directory, launch);
  const historyPath = path.join(path.dirname(first.filePath), 'history.jsonl');
  const originalHistory = await readFile(historyPath, 'utf8');
  const originalHtml = await readFile(first.filePath, 'utf8');
  await writeFile(historyPath, '{invalid');
  await assert.rejects(openHtmlReport(report, directory, launch), SyntaxError);
  assert.equal(await readFile(historyPath, 'utf8'), '{invalid');
  assert.equal(await readFile(first.filePath, 'utf8'), originalHtml);
  await rm(historyPath);
  await mkdir(historyPath);
  await assert.rejects(openHtmlReport(report, directory, launch), /EISDIR/);
  await rm(historyPath, { recursive: true });
  await writeFile(historyPath, originalHistory);
  await openHtmlReport(report, directory, launch);
  assert.equal((await readFile(historyPath, 'utf8')).trim().split('\n').length, 2);
});

await test('HTML report is written before launching and remains available if browser launch fails', async (context) => {
  const report: Report = { nodeVersion: '22.14.0', rows: [], exitCode: 0 };
  let launched = false;
  const result = await openHtmlReport(report, '/project', async (filePath) => {
    assert.match(await readFile(filePath, 'utf8'), /Node.js Compatibility/);
    launched = true;
  });
  context.after(async () => {
    await rm(path.dirname(result.filePath), { recursive: true, force: true });
  });
  assert.equal(launched, true);
  assert.equal(result.warning, undefined);
  const failed = await openHtmlReport(report, '/project', () => Promise.reject(new Error('No desktop browser')));
  context.after(async () => {
    await rm(path.dirname(failed.filePath), { recursive: true, force: true });
  });
  assert.match(failed.warning ?? '', /No desktop browser/);
  assert.match(await readFile(failed.filePath, 'utf8'), /Node.js Compatibility/);
});
