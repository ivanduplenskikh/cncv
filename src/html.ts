import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import open from 'open';

import type { Report } from './check.js';
import { minimumEngines, visibleReportRows } from './check.js';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function renderHtmlReport(report: Report, projectPath: string): string {
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
  <title>cncv | Node.js ${escapeHtml(report.nodeVersion)}</title>
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

export async function openHtmlReport(
  report: Report,
  projectPath: string,
  launch: (filePath: string) => Promise<void> = launchBrowser,
): Promise<{ filePath: string; warning?: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cncv-report-'));
  const filePath = path.join(directory, 'report.html');
  await writeFile(filePath, renderHtmlReport(report, projectPath), { encoding: 'utf8', mode: 0o600 });
  try {
    await launch(filePath);

    return { filePath };
  } catch (error) {
    return { filePath, warning: `Could not open browser: ${error instanceof Error ? error.message : 'Unknown error'}` };
  }
}
