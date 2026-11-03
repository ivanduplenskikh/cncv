import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { styleText } from 'node:util';

import Table from 'cli-table3';
import semver from 'semver';
import { z } from 'zod';

export const manifestSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  engines: z.object({ node: z.unknown().optional(), npm: z.unknown().optional() }).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

type Manifest = z.infer<typeof manifestSchema>;
type Kind = 'project' | 'dependency' | 'dev' | 'optional' | 'peer';
type Status = 'OK' | 'INCOMPATIBLE' | 'BLOCKED' | 'UNKNOWN' | 'INVALID' | 'MISSING' | 'ERROR';
type EngineStatus = 'OK' | 'INCOMPATIBLE' | 'UNKNOWN' | 'INVALID';

export interface PackageRow {
  name: string;
  version: string;
  engine: string;
  kind: Kind;
  status: Status;
  path: string;
  details?: string;
  nodeStatus?: EngineStatus;
  npmEngine?: string;
  npmStatus?: EngineStatus;
  engineIssues?: string[];
}

export interface CheckOptions {
  nodeVersion?: string;
  npmVersion?: string;
  direct?: boolean;
  omitDev?: boolean;
}

export interface Report {
  nodeVersion: string;
  npmVersion?: string;
  rows: PackageRow[];
  exitCode: 0 | 1 | 2;
  source?: string;
}

async function readManifest(manifestPath: string): Promise<Manifest> {
  const data: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));

  return manifestSchema.parse(data);
}

export function dependencyEntries(manifest: Manifest, includeDev: boolean): Map<string, Kind> {
  const entries = new Map<string, Kind>();
  const groups: [Kind, Record<string, string> | undefined][] = [
    ['peer', manifest.peerDependencies],
    ['dev', includeDev ? manifest.devDependencies : undefined],
    ['dependency', manifest.dependencies],
    ['optional', manifest.optionalDependencies],
  ];
  for (const [kind, dependencies] of groups) {
    for (const name of Object.keys(dependencies ?? {})) {
      entries.set(name, kind);
    }
  }

  return entries;
}

async function resolveManifest(name: string, fromDirectory: string): Promise<string | null> {
  if (!/^(?:@[^/\\.][^/\\]*\/)?[^/\\.][^/\\]*$/.test(name) || name.includes('\0')) {
    throw new Error(`Invalid dependency name: ${name}`);
  }
  let directory: string | null = fromDirectory;
  while (directory !== null) {
    const candidate = path.join(directory, 'node_modules', name, 'package.json');
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)
        || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        throw error;
      }
    }
    const parent = path.dirname(directory);
    directory = parent === directory ? null : parent;
  }

  return null;
}

let detectedNpmVersion: string | undefined;

export function resolveNpmVersion(input?: string): string {
  let version = input ?? detectedNpmVersion;
  if (version === undefined) {
    try {
      version = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        cwd: os.tmpdir(),
        windowsHide: true,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new Error('Cannot detect npm version. Pass --npm <exact-version>, such as --npm 10.9.2.');
    }
    detectedNpmVersion = version;
  }
  const valid = semver.valid(version);
  if (valid === null) {
    throw new Error('npm version must be exact, such as 10.9.2.');
  }

  return valid;
}

function engineStatus(engine: unknown, version: string): EngineStatus {
  if (engine === undefined) {
    return 'UNKNOWN';
  }
  if (typeof engine !== 'string' || semver.validRange(engine) === null) {
    return 'INVALID';
  }

  return semver.satisfies(version, engine) ? 'OK' : 'INCOMPATIBLE';
}

function engineText(engine: unknown): string {
  return engine === undefined ? '(not declared)' : typeof engine === 'string' ? engine : '(invalid declaration)';
}

function packageRow(manifest: Manifest, name: string, kind: Kind, manifestPath: string, nodeVersion: string, npmVersion: string): PackageRow {
  const engine = manifest.engines?.node;
  const npmEngine = manifest.engines?.npm;
  const nodeStatus = engineStatus(engine, nodeVersion);
  const npmStatus = engineStatus(npmEngine, npmVersion);
  const status = nodeStatus === 'INVALID' || npmStatus === 'INVALID' ? 'INVALID'
    : nodeStatus === 'INCOMPATIBLE' || npmStatus === 'INCOMPATIBLE' ? 'INCOMPATIBLE' : nodeStatus;
  const engineIssues: string[] = [];
  for (const [label, range, result, target] of [
    ['node', engine, nodeStatus, nodeVersion], ['npm', npmEngine, npmStatus, npmVersion],
  ] as const) {
    if (result === 'INCOMPATIBLE' || result === 'INVALID') {
      engineIssues.push(`engines.${label}: ${engineText(range)} (${result.toLowerCase()}, target ${target})`);
    }
  }
  const row: PackageRow = {
    name: manifest.name ?? name,
    version: manifest.version ?? '-',
    engine: engineText(engine),
    nodeStatus,
    engineIssues,
    kind,
    status,
    path: manifestPath,
  };
  if (npmEngine !== undefined) {
    row.npmEngine = engineText(npmEngine);
    row.npmStatus = npmStatus;
  }

  return row;
}

function traceUnknowns(rows: PackageRow[], edges: Map<PackageRow, PackageRow[]>, direct: boolean): void {
  const originalStatuses = new Map(rows.map((row) => [row, row.status]));
  const describeChain = (chain: PackageRow[]): string => chain
    .map((row) => row.version === '-' ? row.name : `${row.name}@${row.version}`).join(' -> ');

  for (const root of rows) {
    if (originalStatuses.get(root) !== 'UNKNOWN') {
      continue;
    }
    if (direct) {
      root.details = 'Dependency tracing skipped (--direct); package compatibility remains unknown.';
      continue;
    }
    const visited = new Set([root]);
    const queue = [{ row: root, chain: [root] }];
    let incomplete: string | undefined;
    let unknown: string | undefined;
    let blocked = false;
    for (const current of queue) {
      for (const dependency of edges.get(current.row) ?? []) {
        if (visited.has(dependency)) {
          continue;
        }
        visited.add(dependency);
        const chain = [...current.chain, dependency];
        const status = originalStatuses.get(dependency);
        if (status === 'INCOMPATIBLE' || dependency.nodeStatus === 'INCOMPATIBLE' || dependency.npmStatus === 'INCOMPATIBLE') {
          root.status = 'BLOCKED';
          root.details = `Blocked by ${describeChain(chain)} (${dependency.engineIssues?.join('; ') ?? `engines.node: ${dependency.engine}`}).`;
          blocked = true;
          break;
        }
        if (status === 'MISSING' || status === 'INVALID' || status === 'ERROR') {
          incomplete ??= `Dependency check incomplete: ${describeChain(chain)} (${status}).`;
        } else if (status === 'UNKNOWN') {
          unknown ??= `Dependency metadata unknown: ${describeChain(chain)}.`;
        }
        queue.push({ row: dependency, chain });
      }
      if (blocked) {
        break;
      }
    }
    if (!blocked) {
      root.details = incomplete ?? unknown ?? (visited.size === 1
        ? 'No dependencies to inspect; package compatibility remains unknown.'
        : 'Dependency engines satisfied; package compatibility remains unknown.');
    }
  }
}

export async function inspectProject(inputPath = '.', options: CheckOptions = {}): Promise<Report> {
  const nodeVersion = semver.valid(options.nodeVersion ?? process.versions.node);
  if (nodeVersion === null) {
    throw new Error('Node version must be exact, such as 22.14.0.');
  }
  const npmVersion = resolveNpmVersion(options.npmVersion);
  const resolvedPath = path.resolve(inputPath);
  const inputStat = await stat(resolvedPath);
  const manifestPath = await realpath(inputStat.isDirectory() ? path.join(resolvedPath, 'package.json') : resolvedPath);
  const manifest = await readManifest(manifestPath);
  const rootRow = packageRow(manifest, '(project)', 'project', manifestPath, nodeVersion, npmVersion);
  const rows = [rootRow];
  const packages = new Map([[manifestPath, rootRow]]);
  const missing = new Map<string, PackageRow>();
  const edges = new Map<PackageRow, PackageRow[]>();
  const queue = [{ manifest, directory: path.dirname(manifestPath), root: true, row: rootRow }];

  for (const current of queue) {
    const dependencies: PackageRow[] = [];
    edges.set(current.row, dependencies);
    for (const [name, kind] of dependencyEntries(current.manifest, current.root && options.omitDev === false)) {
      const dependencyPath = await resolveManifest(name, current.directory);
      if (dependencyPath === null) {
        const key = `${current.directory}\0${name}`;
        let missingRow = missing.get(key);
        if (missingRow === undefined) {
          missingRow = { name, version: '-', engine: '(not installed)', kind, status: 'MISSING', path: current.directory };
          missing.set(key, missingRow);
          rows.push(missingRow);
        }
        dependencies.push(missingRow);
        continue;
      }
      const existing = packages.get(dependencyPath);
      if (existing !== undefined) {
        dependencies.push(existing);
        continue;
      }
      let row: PackageRow;
      try {
        const dependency = await readManifest(dependencyPath);
        row = packageRow(dependency, name, kind, dependencyPath, nodeVersion, npmVersion);
        if (options.direct !== true) {
          queue.push({ manifest: dependency, directory: path.dirname(dependencyPath), root: false, row });
        }
      } catch (error) {
        row = { name, version: '-', engine: error instanceof Error ? error.message : 'Cannot read manifest', kind, status: 'ERROR', path: dependencyPath };
      }
      packages.set(dependencyPath, row);
      rows.push(row);
      dependencies.push(row);
    }
  }

  traceUnknowns(rows, edges, options.direct === true);
  rows.sort((left, right) => {
    if (left.kind === 'project') {
      return -1;
    }
    if (right.kind === 'project') {
      return 1;
    }

    return left.name.localeCompare(right.name) || left.version.localeCompare(right.version);
  });
  const incomplete = rows.some((row) => row.status === 'MISSING' || row.status === 'INVALID' || row.status === 'ERROR');
  const incompatible = rows.some((row) => row.status === 'INCOMPATIBLE' || row.status === 'BLOCKED');

  return { nodeVersion, npmVersion, rows, exitCode: incomplete ? 2 : incompatible ? 1 : 0 };
}

export interface RenderOptions {
  color?: boolean;
  columns?: number;
}

export interface EngineMinimum {
  version?: string;
  status: 'complete' | 'partial' | 'unknown' | 'conflict';
  details: string;
}

export function minimumEngines(report: Report): { node: EngineMinimum; npm: EngineMinimum } {
  const dependencies = report.rows.filter((row) => row.kind !== 'project');
  const minimum = (engine: 'node' | 'npm'): EngineMinimum => {
    const ranges: string[] = [];
    let unresolved = 0;
    for (const row of dependencies) {
      const range = engine === 'node' ? row.engine : row.npmEngine;
      if (row.status === 'MISSING' || row.status === 'ERROR'
        || range === undefined || semver.validRange(range) === null) {
        unresolved++;
        continue;
      }
      ranges.push(range);
    }
    if (ranges.length === 0) {
      return { status: 'unknown', details: 'No valid dependency declarations available.' };
    }
    const candidates = new Set<string>();
    for (const range of ranges) {
      for (const branch of new semver.Range(range).set) {
        const candidate = semver.minVersion(branch.map((comparator) => comparator.value).join(' ') || '*');
        if (candidate !== null) {
          candidates.add(candidate.version);
          if (candidate.prerelease.length > 0) {
            candidates.add(`${String(candidate.major)}.${String(candidate.minor)}.${String(candidate.patch)}`);
          }
        }
      }
    }
    const version = [...candidates].sort(semver.compare).find((candidate) =>
      ranges.every((range) => semver.satisfies(candidate, range)));
    if (version === undefined) {
      return { status: 'conflict', details: 'No version satisfies all declared dependency ranges.' };
    }
    if (version === '0.0.0') {
      return { status: 'unknown', details: 'Dependency declarations provide no positive minimum version.' };
    }

    return {
      version,
      status: unresolved === 0 ? 'complete' : 'partial',
      details: unresolved === 0 ? 'All checked dependencies declare compatible ranges.'
        : `${String(unresolved)} checked dependencies have missing, invalid, or unavailable declarations.`,
    };
  };

  return { node: minimum('node'), npm: minimum('npm') };
}

export function renderEngineMinimums(report: Report): string[] {
  const minima = minimumEngines(report);

  return (['node', 'npm'] as const).map((engine) => {
    const minimum = minima[engine];

    return `Minimum ${engine === 'node' ? 'Node.js' : 'npm'} (engines.${engine}): ${minimum.version ?? minimum.status}${minimum.status === 'partial' ? ' (partial)' : ''}. ${minimum.details}`;
  });
}

export function visibleReportRows(report: Report): PackageRow[] {
  const priority: Record<Status, number> = { INCOMPATIBLE: 0, BLOCKED: 1, ERROR: 2, INVALID: 3, MISSING: 4, UNKNOWN: 5, OK: 6 };

  return report.rows.filter((row) => row.status !== 'OK').sort((left, right) =>
    priority[left.status] - priority[right.status]
    || left.name.localeCompare(right.name)
    || left.version.localeCompare(right.version, undefined, { numeric: true })
    || left.path.localeCompare(right.path));
}

export function renderReport(report: Report, options: RenderOptions = {}): string {
  const priority: Record<Status, number> = { INCOMPATIBLE: 0, BLOCKED: 1, ERROR: 2, INVALID: 3, MISSING: 4, UNKNOWN: 5, OK: 6 };
  const visibleRows = visibleReportRows(report);
  const width = Math.max(64, Math.min(options.columns ?? 100, 140));
  const minimumTitle = 'MINIMUM DEPENDENCY VERSIONS';
  const minimumBlock = new Table({
    head: [options.color === true ? styleText(['bold', 'cyan'], minimumTitle, { validateStream: false }) : minimumTitle],
    colWidths: [width - 2],
    wordWrap: true,
    style: { head: [], border: [], compact: true },
  });
  for (const line of [...renderEngineMinimums(report), 'Dependency declarations only; current project entry excluded. Upper bounds still apply.']) {
    minimumBlock.push([{ content: line, wrapOnWordBoundary: false }]);
  }
  const minimumLines = ['', minimumBlock.toString(), ''];
  if (visibleRows.length === 0) {
    return [`Node.js target: ${report.nodeVersion}`, ...(report.npmVersion === undefined ? [] : [`npm target: ${report.npmVersion}`]), ...(report.source === undefined ? [] : [report.source]),
      ...minimumLines,
      `All checked packages are compatible (${String(report.rows.length)} checked).`].join('\n');
  }
  const clean = (value: string): string => value.replace(/\p{Cc}/gu, ' ');
  const packageWidth = Math.floor((width - 45) * 0.55);
  const engineWidth = width - 45 - packageWidth;
  const table = new Table({
    head: ['Package', 'Version', 'Node Engine', 'Type', 'Status'],
    colWidths: [packageWidth, 11, engineWidth, 12, 16],
    wordWrap: true,
    style: { head: [], border: [], compact: true },
  });
  for (const row of visibleRows) {
    const failure = row.status === 'INCOMPATIBLE' || row.status === 'BLOCKED';
    const status = failure ? `! ${row.status}` : row.status;
    const highlight = (text: string): string => {
      if (options.color !== true) {
        return text;
      }

      return failure
        ? styleText(['bold', 'red'], text, { validateStream: false })
        : styleText('yellow', text, { validateStream: false });
    };
    table.push([
      { content: clean(row.name), wrapOnWordBoundary: false },
      { content: clean(row.version), wrapOnWordBoundary: false },
      clean(row.engine), clean(row.kind), highlight(status),
    ]);
    if (row.npmEngine !== undefined) {
      table.push([{ colSpan: 5, content: clean(`  npm engine: ${row.npmEngine} (${row.npmStatus ?? 'UNKNOWN'})`), wrapOnWordBoundary: false }]);
    }
    if (row.engineIssues !== undefined && row.engineIssues.length > 0) {
      table.push([{ colSpan: 5, content: clean(`  ${row.engineIssues.join('; ')}`), wrapOnWordBoundary: false }]);
    }
    if (row.details !== undefined) {
      table.push([{ colSpan: 5, content: `  ${clean(row.details)}`, wrapOnWordBoundary: false }]);
    }
  }
  const counts = new Map<Status, number>();
  for (const row of report.rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }

  return [
    `Node.js target: ${report.nodeVersion}`, ...(report.npmVersion === undefined ? [] : [`npm target: ${report.npmVersion}`]), ...(report.source === undefined ? [] : [report.source]), ...minimumLines, '', table.toString(), '',
    [...counts].sort(([left], [right]) => priority[left] - priority[right])
      .map(([status, count]) => `${String(count)} ${status === 'OK' ? 'compatible (hidden)' : status.toLowerCase()}`).join(', '),
  ].join('\n');
}
