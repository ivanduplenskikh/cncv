import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import open from 'open';

import type { Report } from './check.js';
import { minimumEngines, visibleReportRows } from './check.js';
import { remoteManifestUrl } from './remote.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderSource(location: string, label?: string): string {
  try {
    const url = new URL(location);

    if (url.protocol === 'https:' || url.protocol === 'http:') {
      const source = decodeURIComponent(url.hash.slice(1)) || url.pathname.split('/').filter(Boolean).slice(-2).join('/');

      return `<a href="${escapeHtml(url.href)}" rel="noreferrer">${escapeHtml(label ?? source)}</a>`;
    }
  } catch {
    return escapeHtml(location);
  }

  return escapeHtml(location);
}

function safeReportName(name: string): string {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '') || 'project';

  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `project-${slug}` : slug;
}

function reportIdentity(projectPath: string, report?: Report): { name: string; slug: string; folder: string; id: string; key: string } {
  const remote = /^https?:\/\//i.test(projectPath);
  let target = remote ? remoteManifestUrl(projectPath).href : path.resolve(projectPath);

  if (!remote && path.basename(target) === 'package.json') {
    target = path.dirname(target);
  }

  const parts = remote ? new URL(target).pathname.split('/').filter(Boolean) : [];
  const fallback = remote ? (parts.length === 4 ? parts[1] : parts.at(-2)) : path.basename(target);
  const rootName = report?.rows.find((row) => row.kind === 'project')?.name;
  const name = rootName !== undefined && rootName !== '(project)' && rootName.trim() !== ''
    ? rootName : fallback || 'project';
  const slug = safeReportName(name);
  const folder = safeReportName((remote ? parts[1] : path.basename(target)) || 'project');
  const key = !remote && process.platform === 'win32' ? target.toLowerCase() : target;
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);

  return { name, slug, folder, id, key };
}

export function renderHtmlReport(report: Report, projectPath: string): string {
  const { name } = reportIdentity(projectPath, report);
  const rows = visibleReportRows(report);
  const actionable = rows.filter((row) => row.status !== 'UNKNOWN');
  const unknown = rows.filter((row) => row.status === 'UNKNOWN');
  const compatible = report.rows.filter((row) => row.status === 'OK').length;
  const incompatible = rows.filter((row) => row.status === 'INCOMPATIBLE');
  const blocked = rows.filter((row) => row.status === 'BLOCKED').length;
  const missing = rows.filter((row) => row.status === 'MISSING').length;
  const errors = rows.filter((row) => row.status === 'ERROR' || row.status === 'INVALID').length;
  const conclusion = report.exitCode === 2 ? 'Check incomplete'
    : incompatible.length > 0 || blocked > 0 ? 'Declared incompatibilities found'
      : unknown.length > 0 ? 'No declared incompatibilities; compatibility remains unknown'
        : 'All checked packages are compatible';
  const findings = incompatible.map((row) => `<li><strong>${escapeHtml(row.name)}@${escapeHtml(row.version)}</strong>: ${escapeHtml((row.engineIssues ?? []).join(' ') || row.details || 'Declared engines exclude the selected targets.')}</li>`).join('');
  const counts = [
    [incompatible.length, 'Incompatible', 'red'], [blocked, 'Blocked', 'red'],
    [missing, 'Missing', 'amber'], [errors, 'Errors / invalid', 'amber'],
    [unknown.length, 'Unknown', 'muted'], [compatible, 'Compatible', 'green'],
  ] as const;
  const minima = minimumEngines(report);
  const minimumItems = (['node', 'npm'] as const).map((engine) => {
    const minimum = minima[engine];
    const label = `Minimum ${engine === 'node' ? 'Node.js' : 'npm'} (engines.${engine}): ${minimum.version ?? minimum.status}${minimum.status === 'partial' ? ' (partial)' : ''}`;
    const conflicts = minimum.conflicts?.map((declaration) => `<li><strong>${escapeHtml(declaration.name)}@${escapeHtml(declaration.version)}</strong>: <code>${escapeHtml(declaration.range)}</code></li>`).join('');

    return `<div class="minimum-item" data-status="${minimum.status}"><p class="minimum-value">${escapeHtml(label)}</p><p class="minimum-detail">${escapeHtml(minimum.details)}</p>${conflicts === undefined ? '' : `<details class="conflict-details"><summary>Conflicting dependency ranges</summary><ul>${conflicts}</ul></details>`}</div>`;
  }).join('');
  const renderRows = (selected: typeof rows): string => `<ul class="package-list">${selected.map((row) => {
    const failure = row.status === 'INCOMPATIBLE' || row.status === 'BLOCKED';
    const status = `${failure ? '! ' : ''}${row.status}`;
    const notes = [...(row.engineIssues ?? []), ...(row.details === undefined ? [] : [row.details])];
    const evidence = notes.map((note) => `<p class="evidence">${escapeHtml(note)}</p>`).join('');

    return `<li class="package-row ${failure ? 'failure' : 'unresolved'}">
      <div class="row-heading"><h3>${escapeHtml(row.name)} <span class="version">${escapeHtml(row.version)}</span></h3><span class="status ${failure ? 'danger' : row.status === 'UNKNOWN' ? 'neutral' : 'warning'}">${status}</span></div>
      <p class="engines">Node Engine: <code>${escapeHtml(row.engine)}</code>${row.npmEngine === undefined ? '' : ` / npm Engine: <code>${escapeHtml(row.npmEngine)}</code>`}</p>
      ${row.status === 'UNKNOWN' ? '' : evidence}
      <details class="package-details"><summary>Dependency details</summary><dl><div><dt>Type</dt><dd>${escapeHtml(row.kind)}</dd></div><div><dt>npm Engine</dt><dd>${escapeHtml(row.npmEngine ?? '(not declared)')}${row.npmStatus === undefined ? '' : ` / ${row.npmStatus}`}</dd></div><div><dt>Source</dt><dd>${renderSource(row.path)}</dd></div></dl>${row.status === 'UNKNOWN' ? evidence : ''}</details>
    </li>`;
  }).join('\n')}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>cncv | ${escapeHtml(name)} | Node.js ${escapeHtml(report.nodeVersion)}</title>
  <style>
    :root { color-scheme: light; --ink: #202820; --muted: #59645d; --line: #dce3dd; --red: #ab2626; --green: #23734a; --amber: #805c0c; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: #f7faf8; font: 15px/1.5 'Trebuchet MS', sans-serif; letter-spacing: 0; }
    header { border-top: 5px solid var(--green); border-bottom: 1px solid var(--line); background: #fff; }
    .wrap { max-width: 1120px; margin: auto; padding: 24px 32px; }
    .brand { margin: 0 0 8px; color: var(--green); font-size: 15px; font-weight: bold; }
    h1 { margin: 0; font: 28px/1.25 Georgia, serif; overflow-wrap: anywhere; }
    .project { margin: 12px 0 0; overflow-wrap: anywhere; color: var(--muted); }
    .target { margin: 8px 0 0; font-weight: bold; }
    .minimums { margin: 28px 0; padding: 20px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
    .minimums p { margin: 8px 0 0; }
    .minimum-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 8px; }
    .minimum-item { min-width: 0; }
    .minimum-value { font-size: 15px; font-weight: bold; color: var(--amber); }
    .minimum-item[data-status="complete"] .minimum-value { color: var(--green); }
    .minimum-item[data-status="conflict"] .minimum-value { color: var(--red); }
    .minimum-detail, .minimums .project { font-size: 13px; }
    .conflict-details { margin-top: 12px; font-size: 13px; }
    .conflict-details ul { padding-left: 20px; } .conflict-details li { margin: 8px 0; }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-bottom: 1px solid var(--line); padding: 20px 0; gap: 16px; }
    .summary div { min-width: 0; }
    .summary strong { display: block; font-size: 24px; font-weight: normal; }
    .summary span { color: var(--muted); font-size: 13px; }
    .red { color: var(--red); } .green { color: var(--green); } .amber { color: var(--amber); } .muted { color: var(--muted); }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 28px 0 12px; }
    h2 { margin: 0; font-size: 18px; } .section-heading p { margin: 0; color: var(--muted); font-size: 13px; }
    a { color: var(--green); text-underline-offset: 3px; }
    a:focus-visible, summary:focus-visible { outline: 2px solid var(--green); outline-offset: 4px; }
    .outcome { padding-bottom: 4px; overflow-wrap: anywhere; }
    .outcome h2 { font-size: 22px; }
    .findings { padding-left: 20px; margin: 12px 0; }
    .findings li { margin: 8px 0; }
    .package-list { list-style: none; padding: 0; margin: 0; }
    .package-row { padding: 16px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
    .row-heading { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; }
    h3 { margin: 0; font-size: 15px; min-width: 0; }
    .version { color: var(--muted); font-weight: normal; font-size: 13px; }
    .engines, .evidence { margin: 8px 0; font-size: 13px; }
    code { font: 13px/1.5 'Courier New', monospace; }
    .evidence { color: var(--muted); }
    details summary { cursor: pointer; font-weight: bold; }
    .package-details { margin-top: 10px; font-size: 13px; color: var(--muted); }
    .package-details summary { font-weight: normal; width: fit-content; }
    dl { margin: 12px 0; }
    dl div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; margin: 6px 0; }
    dt { font-weight: bold; } dd { margin: 0; }
    .unknowns { margin: 24px 0; border-top: 1px solid var(--line); padding-top: 16px; }
    .unknown-note { font-size: 13px; color: var(--muted); }
    .source-details { margin-top: 12px; font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
    .status { display: inline-block; font-size: 11px; font-weight: bold; padding: 3px 6px; border-radius: 3px; white-space: nowrap; }
    .danger { color: var(--red); background: #fcecec; } .warning { color: var(--amber); background: #fff5d8; } .neutral { color: var(--muted); background: #eaf0ed; }
    .empty { margin: 0; padding: 28px 0; color: var(--green); font-weight: bold; }
    footer { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 16px; color: var(--muted); font-size: 12px; }
    @media (max-width: 600px) { .wrap { padding: 20px 16px; } h1 { font-size: 24px; } .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; } .minimum-values { grid-template-columns: minmax(0, 1fr); gap: 12px; } .section-heading { display: block; } .section-heading p { margin-top: 4px; } .row-heading { grid-template-columns: minmax(0, 1fr); gap: 6px; } .status { justify-self: start; } }
    @media print { .wrap { padding: 16px 0; } .package-details { display: none; } }
  </style>
</head>
<body>
  <header><div class="wrap"><p class="brand">cncv / Node.js Compatibility</p><h1>${escapeHtml(name)}</h1><p class="target">Target: Node.js ${escapeHtml(report.nodeVersion)}${report.npmVersion === undefined ? '' : ` / npm ${escapeHtml(report.npmVersion)}`} / ${String(report.rows.length)} packages checked</p><details class="source-details"><summary>Check source</summary><p>${renderSource(projectPath)}</p>${report.source === undefined ? '' : `<p>${escapeHtml(report.source)}</p>`}</details>${report.source?.startsWith('ESTIMATE') === true ? '<p class="project amber">ESTIMATE: current registry metadata, not the repository installed tree.</p>' : ''}</div></header>
  <main class="wrap">
    <section class="outcome" aria-label="Check outcome"><h2>${conclusion}</h2>${findings === '' ? '' : `<ul class="findings">${findings}</ul>`}${missing + errors === 0 ? '' : `<p>${String(missing)} missing ${missing === 1 ? 'package' : 'packages'}; ${String(errors)} errors or invalid declarations. Results are incomplete.</p>`}${blocked === 0 ? '' : `<p class="unknown-note">${String(blocked)} blocked ${blocked === 1 ? 'package inherits' : 'packages inherit'} a dependency incompatibility; blocked packages are not additional engine mismatches.</p>`}</section>
    <section class="summary" aria-label="Check summary">
      ${counts.map(([count, label, color]) => `<div><strong class="${color}">${String(count)}</strong><span>${label}</span></div>`).join('')}
    </section>
    <section aria-label="Actionable results"><div class="section-heading"><h2>Actionable Results</h2><p>${String(actionable.length)} issues / ${String(compatible)} compatible hidden</p></div>${actionable.length === 0 ? `<p class="empty">${rows.length === 0 ? 'All checked packages are compatible.' : 'No actionable engine issues found.'}</p>` : renderRows(actionable)}</section>
    <section class="minimums" aria-label="Minimum dependency versions"><h2>Minimum Dependency Versions</h2><div class="minimum-values">${minimumItems}</div><p class="project">Dependency declarations only; current project entry excluded. Upper bounds still apply.</p></section>
    ${unknown.length === 0 ? '' : `<details class="unknowns"><summary>${String(unknown.length)} ${unknown.length === 1 ? 'package' : 'packages'} without Node.js engine declarations</summary><p class="unknown-note">Unknown packages are not confirmed compatible. Dependency checks do not prove their own runtime compatibility.</p>${renderRows(unknown)}</details>`}
    <footer>Declared engine compatibility only. Unknown packages are not confirmed compatible. Exit code: ${String(report.exitCode)}.</footer>
  </main>
</body>
</html>`;
}

async function launchBrowser(filePath: string): Promise<void> {
  await open(filePath);
}

let reportWrites = Promise.resolve();

async function historyProject(filePath: string): Promise<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const entry: unknown = JSON.parse(line);

      if (typeof entry === 'object' && entry !== null && 'projectPath' in entry && typeof entry.projectPath === 'string') {
        return entry.projectPath;
      }

      break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  throw new Error(`Invalid report history: ${filePath}`);
}

function saveHtmlReport(report: Report, projectPath: string, destination?: string): Promise<string> {
  const write = reportWrites.then(async () => {
    const { folder, id, key } = reportIdentity(projectPath, report);
    const root = path.join(os.homedir(), '.cncv', 'reports');
    const directories = destination === undefined
      ? [path.join(root, folder), path.join(root, `${folder}-${id}`)] : [destination];
    const entry = `${JSON.stringify({ projectPath: key, createdAt: new Date().toISOString(), report })}\n`;

    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const historyPath = path.join(directory, 'history.jsonl');

      try {
        await writeFile(historyPath, entry, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
          throw error;
        }

        if (await historyProject(historyPath) !== key) {
          continue;
        }

        await appendFile(historyPath, entry, { encoding: 'utf8', mode: 0o600 });
      }

      const filePath = path.join(directory, 'project.html');
      const temporary = path.join(directory, `${randomUUID()}.tmp`);

      try {
        await writeFile(temporary, renderHtmlReport(report, projectPath), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, filePath);
      } finally {
        await rm(temporary, { force: true });
      }

      return filePath;
    }

    throw new Error('Report directory belongs to a different project.');
  });
  reportWrites = write.then(() => undefined, () => undefined);

  return write;
}

export async function startHtmlReportServer(
  projectPath: string,
  regenerate: () => Promise<Report>,
  report?: Report,
): Promise<{ url: string; close: () => Promise<void> }> {
  const route = `/${randomUUID()}/${reportIdentity(projectPath, report).slug}.html`;
  let host = '';
  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (request.headers.host !== host || request.url !== route) {
      response.writeHead(404).end('Not found');

      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.writeHead(405).end('Method not allowed');

      return;
    }

    if (request.method === 'HEAD') {
      response.writeHead(200).end();

      return;
    }

    try {
      response.end(renderHtmlReport(await regenerate(), projectPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      response.writeHead(500).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>cncv | Check failed</title></head><body><h1>Check failed</h1><p>${escapeHtml(message)}</p></body></html>`);
    }
  };
  const server = createServer((request, response) => {
    void respond(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Cannot determine HTML report server address.');
  }

  host = `127.0.0.1:${String(address.port)}`;

  return {
    url: `http://${host}${route}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
      server.closeIdleConnections();
    }),
  };
}

export async function openHtmlReport(
  report: Report,
  projectPath: string,
  launch: (filePath: string) => Promise<void> = launchBrowser,
  regenerate?: () => Promise<Report>,
): Promise<{ filePath: string; url?: string; close?: () => Promise<void>; warning?: string }> {
  const filePath = await saveHtmlReport(report, projectPath);
  let live: Awaited<ReturnType<typeof startHtmlReportServer>> | undefined;

  try {
    if (regenerate !== undefined) {
      live = await startHtmlReportServer(projectPath, async () => {
        const updated = await regenerate();
        await saveHtmlReport(updated, projectPath, path.dirname(filePath));

        return updated;
      }, report);
    }

    await launch(live?.url ?? filePath);

    return { filePath, ...live };
  } catch (error) {
    await live?.close();

    return { filePath, warning: `Could not open browser: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}
