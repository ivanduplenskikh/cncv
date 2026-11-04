# cncv - **c**heck **N**ode.js **c**ompatible **v**ersions

A CLI that checks dependency declarations in `engines.node` and `engines.npm`. It checks metadata, not actual runtime compatibility, and never executes dependency code or install scripts.

Requires **Node.js 18+**.

## Quick Start

GitHub Packages publishes this CLI as `@ivanduplenskikh/cncv`. Authentication is required even for public packages. Set a GitHub PAT classic with `read:packages` in `GITHUB_PACKAGES_TOKEN` and add these entries to your user-level `.npmrc` (never commit credentials):

```ini
@ivanduplenskikh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npx @ivanduplenskikh/cncv /path/to/project
npx @ivanduplenskikh/cncv /path/to/project --node 22.14.0 --npm 10.9.2 --no-open
```

You can also use `pnpm dlx @ivanduplenskikh/cncv`, or build and run from source as described below.

For local checks, install the target project's dependencies first. The path defaults to the current directory and can also be a `package.json` file. Checks include transitive dependencies but exclude the project's dev dependencies by default. Local checks make no registry requests and require `node_modules` (no Yarn Plug'n'Play).

## Options

| Option | Effect |
| --- | --- |
| `--node <version>` | Exact version or major (`18` selects the latest stable v18 release); defaults to the running version. |
| `--npm <version>` | Exact npm target; defaults to `npm --version`. Required if detection fails. |
| `--direct` | Check only the project and direct dependencies. |
| `--include-dev` | Include the project's dev dependencies. |
| `--omit-dev` | Explicitly exclude dev dependencies; conflicts with `--include-dev`. |
| `--no-open` | Terminal-only output; no HTML files, browser, or server. |
| `--help`, `-h` | Show help. |

Node and npm targets are independent; selecting a Node version does not select or validate a matching npm release.

```sh
pnpm start . --node 18 --no-open
```

A major target (also accepted as `v18`) uses the official Node.js release index, shared across projects and majors in `~/.cncv/cache/node-releases.json`. The index is cached for 24 hours, then revalidated on the next lookup using HTTP validators when available. If a refresh fails, cncv warns, uses the last valid index, and waits another 24 hours before retrying. The first lookup needs network access. The report shows the resolved exact version; HTML refreshes keep that target. Exact targets such as `18.20.8` bypass both cache and network for offline or reproducible checks. Minor-only targets and ranges are not accepted.

## GitHub Projects

Public HTTPS GitHub `blob`, raw manifest, and `tree` directory URLs are supported:

```sh
pnpm start "https://github.com/microsoft/azure-pipelines-tasks-common-packages/tree/main/common-npm-packages/azure-arm-rest"
```

- A sibling npm lockfile v2/v3 provides locked versions, engine declarations, and the dependency graph.
- Without that lockfile (HTTP 404), current public npm metadata provides a labelled **ESTIMATE**, applying supported npm or flat pnpm overrides. pnpm/Yarn lockfiles and Yarn resolutions are not applied.

Remote checks download metadata only, not packages. Malformed lockfiles, workspace/file links, unsupported dependency sources, and unsupported overrides fail rather than silently guessing. Bare repository URLs and private authentication are unsupported. For refs containing slashes, use an unambiguous raw manifest URL with an encoded ref or commit SHA.

## Reports

By default, cncv prints a terminal report and opens a live HTML report. Refreshing the page reruns the check with the same targets and flags. Keep the CLI running; Ctrl+C stops the server. Terminal output and exit codes reflect the initial check.

A static snapshot is saved under `~/.cncv/reports/<project-name>-<path-hash>/`. Rechecking the same project overwrites it; the CLI prints both URLs. Reports use no external assets or browser scripts.

HTML puts actionable results first, separates status counts, and collapses unknown packages and metadata details. Compatible packages are hidden but included in summary counts.

Both reports show dependency-based minimum Node.js and npm versions, excluding the project's own declarations. `partial` means metadata is incomplete, `conflict` means no common version satisfies the ranges, and `unknown` means no positive minimum can be inferred. HTML includes named conflict evidence. Upper bounds still apply; a minimum is not proof of runtime support or a published release.

## Results

| Status | Meaning |
| --- | --- |
| OK | Node and any declared npm engine requirements pass. |
| INCOMPATIBLE | A declared engine excludes the target version. |
| BLOCKED | Node compatibility is unknown and a dependency has an engine mismatch. |
| UNKNOWN | No Node.js engine declaration; compatibility is unconfirmed. |
| MISSING | A declared dependency was not found. |
| INVALID | An engine declaration is invalid. |
| ERROR | A package manifest could not be read or validated. |

Unknown packages are traced through their dependencies, with chains explaining blocked or incomplete results. `--direct` skips tracing. Missing npm declarations alone are not failures.

**Exit codes:** `0` = no declared incompatibilities; `1` = incompatible or blocked; `2` = incomplete or error (takes precedence). Unknown declarations do not cause failure. Missing optional dependencies and optional peers still produce `2`.

## Development

Development requires Node.js 22.13+ and pnpm 10.20.0. From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start /path/to/project
pnpm check
```

`pnpm check` runs lint, strict TypeScript compilation, and the Node.js tests. For automatic lint fixes, use `pnpm exec oxlint --threads 1 --fix .`.

## Publishing

Increment the package version before publishing; existing versions cannot be overwritten. Never commit credentials.

The manual [GitHub Packages workflow](.github/workflows/github-packages.yml) runs checks, sets the name to `@ivanduplenskikh/cncv` only in its CI checkout, and publishes with its temporary `GITHUB_TOKEN`. The local package name remains `cncv`. After pushing the workflow, trigger it for remote `main`:

```sh
gh workflow run github-packages.yml --ref main
```
