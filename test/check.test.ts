import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import type { PackageRow, Report } from '../src/check.js';
import { inspectProject, minimumEngines, renderReport } from '../src/check.js';
import { openHtmlReport, renderHtmlReport } from '../src/html.js';

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
    assert.ok(lines.every((line) => line.length <= columns));
  }
  const html = renderHtmlReport(report, '.');
  assert.match(html, /class="minimums" aria-label="Minimum dependency versions"/);
  assert.equal((html.match(/class="minimum-item" data-status="unknown"/g) ?? []).length, 2);
  assert.match(html, /class="minimum-value"/);
  assert.match(html, /\.minimum-values \{ grid-template-columns: minmax\(0, 1fr\)/);
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
