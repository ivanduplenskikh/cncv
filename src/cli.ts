#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { CheckOptions } from './check.js';
import { inspectProject, renderReport } from './check.js';
import { openHtmlReport } from './html.js';
import { inspectRemoteProject } from './remote.js';

const help = `Usage: cncv [module-path] [options]

Check installed dependency engines against Node.js and npm versions.
Path: a local project, package.json file, or public GitHub package.json URL.
Remote: uses a sibling npm v2/v3 lockfile, or labeled public npm estimates.

Options:
  --node <version>  Target exact Node.js version (default: running version)
  --npm <version>   Target exact npm version (default: installed npm)
  --direct          Only check the project and direct dependencies
  --omit-dev        Exclude the project's devDependencies (default)
  --include-dev     Include the project's devDependencies
  --no-open         Terminal only; do not generate HTML or start a server
  --help, -h        Show help

Exit codes: 0 = no declared incompatibilities, 1 = incompatible,
            2 = error or incomplete check (missing/invalid packages).
Packages without engines.node are traced through installed dependencies.
An incompatible descendant makes them BLOCKED; otherwise they remain UNKNOWN.
Dependency checks do not confirm the package's own runtime compatibility.
HTML reloads rerun the check. Keep the CLI running; Ctrl+C stops the server.
`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      node: { type: 'string' },
      npm: { type: 'string' },
      direct: { type: 'boolean' },
      'omit-dev': { type: 'boolean' },
      'include-dev': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help === true) {
    console.log(help);
  } else {
    if (positionals.length > 1) {
      throw new Error('Expected at most one module path. See --help.');
    }
    if (values['omit-dev'] === true && values['include-dev'] === true) {
      throw new Error('Cannot combine --omit-dev and --include-dev.');
    }
    const options: CheckOptions = { direct: values.direct === true, omitDev: values['include-dev'] !== true };
    if (values.node !== undefined) {
      options.nodeVersion = values.node;
    }
    if (values.npm !== undefined) {
      options.npmVersion = values.npm;
    }
    const input = positionals[0] ?? '.';
    const remote = /^https?:\/\//i.test(input);
    const report = remote ? await inspectRemoteProject(input, options) : await inspectProject(input, options);
    console.log(renderReport(report, {
      color: process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env['TERM'] !== 'dumb',
      columns: process.stdout.columns || 100,
    }));
    process.exitCode = report.exitCode;
    if (values['no-open'] !== true) {
      const projectPath = remote ? input : path.resolve(input);
      const refreshOptions: CheckOptions = { ...options, nodeVersion: report.nodeVersion };
      if (report.npmVersion !== undefined) {
        refreshOptions.npmVersion = report.npmVersion;
      }
      const html = await openHtmlReport(report, projectPath, undefined, () => remote
        ? inspectRemoteProject(input, refreshOptions) : inspectProject(projectPath, refreshOptions));
      console.log(`HTML report: ${html.url ?? pathToFileURL(html.filePath).href}`);
      if (html.url !== undefined) {
        console.log('Each page load reruns the check. Keep cncv running; Ctrl+C stops the report server.');
        console.log(`HTML snapshot: ${pathToFileURL(html.filePath).href}`);
      }
      if (html.warning !== undefined) {
        console.error(`cncv: ${html.warning}`);
      }
    }
  }
} catch (error) {
  console.error(`cncv: ${error instanceof Error ? error.message : 'Unexpected error'}`);
  process.exitCode = 2;
}
