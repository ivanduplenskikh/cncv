import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import open from 'open';

import type { Report } from './check.js';
import { minimumEngines, visibleReportRows } from './check.js';
import { remoteManifestUrl } from './remote.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function reportIdentity(projectPath: string, report?: Report): { name: string; slug: string; id: string } {
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
  const sanitized = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').slice(0, 80).replace(/^-+|-+$/g, '') || 'project';
  const slug = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(sanitized) ? `project-${sanitized}` : sanitized;
  const key = !remote && process.platform === 'win32' ? target.toLowerCase() : target;
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);

  return { name, slug, id };
}

export function renderHtmlReport(report: Report, projectPath: string): string {
  const { name } = reportIdentity(projectPath, report);
  const rows = visibleReportRows(report);
  const compatible = report.rows.filter((row) => row.status === 'OK').length;
  const failures = report.rows.filter((row) => row.status === 'INCOMPATIBLE' || row.status === 'BLOCKED').length;
  const unresolved = report.rows.length - compatible - failures;
  const minima = minimumEngines(report);
  const minimumItems = (['node', 'npm'] as const).map((engine) => {
    const minimum = minima[engine];
    const label = `Minimum ${engine === 'node' ? 'Node.js' : 'npm'} (engines.${engine}): ${minimum.version ?? minimum.status}${minimum.status === 'partial' ? ' (partial)' : ''}`;

    return `<div class="minimum-item" data-status="${minimum.status}"><p class="minimum-value">${escapeHtml(label)}</p><p class="minimum-detail">${escapeHtml(minimum.details)}</p></div>`;
  }).join('');
  const body = rows.map((row) => {
    const failure = row.status === 'INCOMPATIBLE' || row.status === 'BLOCKED';
    const status = `${failure ? '! ' : ''}${row.status}`;
    const notes = [...(row.engineIssues ?? []), ...(row.details === undefined ? [] : [row.details])];

    return `<tr class="${failure ? 'failure' : 'unresolved'}">
      <th scope="row"><span class="package">${escapeHtml(row.name)}</span><span class="package-path">${escapeHtml(row.path)}</span></th>
      <td class="mono">${escapeHtml(row.version)}</td><td class="mono">${escapeHtml(row.engine)}</td>
      <td class="mono">${escapeHtml(row.npmEngine ?? '(not declared)')}${row.npmStatus === undefined ? '' : `<br>${row.npmStatus}`}</td>
      <td>${escapeHtml(row.kind)}</td><td><span class="status ${failure ? 'danger' : 'warning'}">${status}</span></td>
    </tr>${notes.length === 0 ? '' : `<tr class="evidence"><td colspan="6">${notes.map(escapeHtml).join('<br>')}</td></tr>`}`;
  }).join('\n');

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
    .wrap { max-width: 1280px; margin: auto; padding: 28px 32px; }
    .brand { margin: 0 0 8px; color: var(--green); font-size: 15px; font-weight: bold; }
    h1 { margin: 0; font: 32px/1.2 Georgia, serif; }
    .project { margin: 12px 0 0; overflow-wrap: anywhere; color: var(--muted); }
    .target { margin: 8px 0 0; font-weight: bold; }
    .minimums { margin: 24px 0; padding: 20px 24px; border: 1px solid #e8d39b; border-left: 4px solid var(--amber); background: #fff8e6; overflow-wrap: anywhere; }
    .minimums p { margin: 8px 0 0; }
    .minimum-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-top: 8px; }
    .minimum-item { min-width: 0; }
    .minimum-value { font-size: 18px; font-weight: bold; color: var(--amber); }
    .minimum-item[data-status="complete"] .minimum-value { color: var(--green); }
    .minimum-item[data-status="conflict"] .minimum-value { color: var(--red); }
    .minimum-detail, .minimums .project { font-size: 13px; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--line); padding-bottom: 24px; gap: 20px; }
    .summary div { min-width: 0; }
    .summary strong { display: block; font-size: 28px; font-weight: normal; }
    .summary span { color: var(--muted); font-size: 13px; }
    .red { color: var(--red); } .green { color: var(--green); } .amber { color: var(--amber); }
    .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin: 28px 0 12px; }
    h2 { margin: 0; font-size: 18px; } .section-heading p { margin: 0; color: var(--muted); font-size: 13px; }
    .table-scroll { overflow-x: auto; border: 1px solid var(--line); background: #fff; }
    table { width: 100%; min-width: 900px; table-layout: fixed; border-collapse: collapse; text-align: left; }
    col.package-col { width: 25%; } col.version-col { width: 10%; } col.engine-col { width: 20%; } col.npm-col { width: 15%; } col.type-col { width: 11%; } col.status-col { width: 19%; }
    th, td { padding: 14px 16px; vertical-align: top; overflow-wrap: anywhere; border-top: 1px solid var(--line); }
    thead th { border-top: 0; background: #edf3ef; color: #48584d; font-size: 12px; font-weight: bold; }
    tbody th { font-weight: normal; } .package { font-weight: bold; } .mono { font-family: 'Courier New', monospace; font-size: 13px; }
    .package-path { display: block; margin-top: 5px; font-size: 11px; color: var(--muted); }
    .status { display: inline-block; font-size: 11px; font-weight: bold; padding: 3px 6px; border-radius: 3px; white-space: nowrap; }
    .danger { color: var(--red); background: #fcecec; } .warning { color: var(--amber); background: #fff5d8; }
    .failure th { border-left: 3px solid var(--red); } .evidence td { border-top: 0; padding-top: 0; font-size: 13px; color: var(--muted); }
    .empty { margin: 0; padding: 28px 0; color: var(--green); font-weight: bold; }
    footer { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 16px; color: var(--muted); font-size: 12px; }
    @media (max-width: 600px) { .wrap { padding: 20px 16px; } h1 { font-size: 26px; } .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } .minimums { padding: 16px; } .minimum-values { grid-template-columns: minmax(0, 1fr); gap: 12px; } .section-heading { display: block; } .section-heading p { margin-top: 4px; } }
    @media print { .wrap { padding: 16px 0; } .table-scroll { overflow: visible; } table { min-width: 0; } .package-path { display: none; } }
  </style>
</head>
<body>
  <header><div class="wrap"><p class="brand">cncv</p><h1>Node.js Compatibility</h1><p class="project">${escapeHtml(projectPath)}</p><p class="target">Target: Node.js ${escapeHtml(report.nodeVersion)}${report.npmVersion === undefined ? '' : ` / npm ${escapeHtml(report.npmVersion)}`}</p>${report.source === undefined ? '' : `<p class="project">${escapeHtml(report.source)}</p>`}</div></header>
  <main class="wrap">
    <section class="summary" aria-label="Check summary">
      <div><strong>${String(report.rows.length)}</strong><span>Packages checked</span></div>
      <div><strong class="red">${String(failures)}</strong><span>Incompatible / blocked</span></div>
      <div><strong class="amber">${String(unresolved)}</strong><span>Unresolved</span></div>
      <div><strong class="green">${String(compatible)}</strong><span>Compatible</span></div>
    </section>
    <section class="minimums" aria-label="Minimum dependency versions"><h2>Minimum Dependency Versions</h2><div class="minimum-values">${minimumItems}</div><p class="project">Dependency declarations only; current project entry excluded. Upper bounds still apply.</p></section>
    <div class="section-heading"><h2>Results</h2><p>${String(rows.length)} shown / ${String(compatible)} compatible hidden</p></div>
    ${rows.length === 0 ? '<p class="empty">All checked packages are compatible.</p>' : `<div class="table-scroll" tabindex="0" role="region" aria-label="Package compatibility results"><table><colgroup><col class="package-col"><col class="version-col"><col class="engine-col"><col class="npm-col"><col class="type-col"><col class="status-col"></colgroup><thead><tr><th scope="col">Package</th><th scope="col">Version</th><th scope="col">Node Engine</th><th scope="col">npm Engine</th><th scope="col">Type</th><th scope="col">Status</th></tr></thead><tbody>${body}</tbody></table></div>`}
    <footer>Declared engine compatibility only. Unknown packages are not confirmed compatible. Exit code: ${String(report.exitCode)}.</footer>
  </main>
</body>
</html>`;
}

async function launchBrowser(filePath: string): Promise<void> {
  await open(filePath);
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
  const { slug, id } = reportIdentity(projectPath, report);
  const directory = path.join(os.homedir(), '.cncv', 'reports', `${slug}-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, `${slug}.html`);
  await writeFile(filePath, renderHtmlReport(report, projectPath), { encoding: 'utf8', mode: 0o600 });
  let live: Awaited<ReturnType<typeof startHtmlReportServer>> | undefined;

  try {
    if (regenerate !== undefined) {
      live = await startHtmlReportServer(projectPath, regenerate, report);
    }

    await launch(live?.url ?? filePath);

    return { filePath, ...live };
  } catch (error) {
    await live?.close();

    return { filePath, warning: `Could not open browser: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}
