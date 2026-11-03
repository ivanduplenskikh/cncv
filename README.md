# cncv

A TypeScript CLI that checks packages' declared Node.js and npm engine compatibility.

## Run From GitHub Packages

The published package is `@ivanduplenskikh/cncv`; the executable remains `cncv`. GitHub Packages requires authentication, including for public packages. Add the following to your user-level `.npmrc`, and provide a GitHub PAT classic with `read:packages` through the environment variable (never commit a token):

```ini
@ivanduplenskikh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```sh
npx @ivanduplenskikh/cncv@1.0.0 /path/to/project
pnpm dlx @ivanduplenskikh/cncv@1.0.0 /path/to/project
```

Releases publish through GitHub Actions when a GitHub release is published. Its tag must match the package version, for example `v1.0.0`. The workflow runs checks and publishes with its temporary `GITHUB_TOKEN`; no publishing token is stored in this repository. New GitHub packages are private by default; adjust package visibility and access in GitHub as needed.

## Setup

Requires Node.js 22.13+ and pnpm 10.20.0.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Without pnpm installed, prefix commands with `npx --yes pnpm@10.20.0` instead of `pnpm`.

## Usage

Install the target project's dependencies first, then pass its directory or package manifest:

```sh
pnpm start /path/to/project
pnpm start /path/to/project/package.json --node 22.14.0
pnpm start /path/to/project --node 22.14.0 --npm 10.9.2
pnpm start /path/to/project --node 24.0.0 --direct
pnpm start /path/to/project --include-dev
```

The path defaults to the current directory. The target Node.js version defaults to the running version; `--node` requires an exact version, not a range. Public GitHub manifest URLs are also supported.

## npm Engine Checks

Declared `engines.npm` ranges are checked automatically alongside `engines.node`. The default npm target is detected with `npm --version`, even when cncv is launched through pnpm. Use `--npm <exact-version>` to override it or to run without npm installed. If detection fails, the CLI exits with code `2` and asks for an explicit target.

A mismatch in either declared engine makes a package `INCOMPATIBLE`; an invalid range makes the check `INVALID` and incomplete. Missing `engines.npm` is not a failure and does not change the existing Node status. A package without `engines.node` remains `UNKNOWN` even when its npm requirement passes. Unknown parents can become `BLOCKED` by a descendant's npm requirement, with the chain naming `engines.npm` as the cause.

Terminal output shows the npm target, declared npm ranges, and failure reasons below package rows. HTML reports include a separate npm Engine column. These checks work for local installations, remote npm lockfiles, and registry estimates. Node and npm targets are independent: choosing an older `--node` does not automatically select a matching npm release or validate npm's own ability to run on that Node version. This reports metadata; it does not install packages or enforce an npm configuration setting.

## Remote Manifests

Pass the URL of a package manifest, including manifests in repository subdirectories:

```sh
pnpm start "https://github.com/microsoft/azure-pipelines-tasks/blob/master/Tasks/AzureCLIV1/package.json" --node 10.14.0
```

GitHub `blob` links are converted to `raw.githubusercontent.com` links; raw links work directly too. Only public HTTPS GitHub manifest URLs are accepted. For refs containing slashes, use an unambiguous raw URL with the encoded ref or a commit SHA. Repository-root URLs and private authentication are not supported.

The checker first fetches a sibling npm package-lock.json:

- npm lockfile v2/v3: checks the locked package versions, engine declarations, and dependency graph. Nested package versions remain distinct. Missing engine declarations remain unknown; they are not guessed. Workspace/file links and non-node_modules lockfile locations are rejected.
- No sibling npm lockfile (HTTP 404): resolves semver ranges and tags using current public npm metadata. Both terminal and HTML output prominently label this as an `ESTIMATE`, not the repository's actual installed tree. Overrides, resolutions, and pnpm/Yarn lockfiles are not applied. Unsupported dependency sources or unavailable metadata stop the check with exit code `2`; unsupported or malformed npm lockfiles do not silently fall back.

Remote checks download metadata only: no cloning, package tarballs, installation, or repository scripts. Temporary synthetic manifests reuse the local graph checker and are removed after inspection. Network requests have a 20-second timeout and a 20 MB response limit. Registry estimates are limited to 500 package names/versions; lockfiles are limited to 10,000 package locations. Remote checks preserve `--direct`, `--include-dev`, default dev exclusion, dependency tracing, HTML reports, and exit codes.

## Report Output

Each check prints the terminal table and opens a standalone HTML report in your default browser. Reports are saved in a private `cncv-report-*` directory under the operating system's temporary directory; the CLI prints the file URL. The HTML has no external assets, scripts, or network requests. It includes summary counts, package locations, sorted results, and dependency-tracing notes. Compatible packages remain hidden.

Both reports show **Minimum Node.js (engines.node)** and **Minimum npm (engines.npm)** above the package results, including when all compatible rows are hidden. Each is the smallest semver satisfying all valid declarations from the checked dependencies, respecting alternatives and upper bounds. The project's current engine entry is excluded: these are dependency-based candidates, not proof that the project's own code supports an older runtime. Selection respects `--direct` and `--include-dev`; remote registry results remain estimates.

A minimum is labelled `partial` when some dependency declarations are missing, invalid, or unavailable, `conflict` when the declared ranges have no common version, and `unknown` when no positive minimum can be inferred. Upper bounds still apply, so a displayed minimum does not justify replacing bounded ranges with an unrestricted `>=` entry. Node and npm minima are computed independently and do not validate npm's own Node requirement, published release availability, or runtime behavior. The report does not modify package manifests or change compatibility exit codes.

For terminal-only use, including CI and headless environments:

```sh
pnpm start /path/to/project --node 22.14.0 --no-open
```

`--no-open` skips both HTML generation and browser launch. If browser launch reports an error, the saved report location is still printed and compatibility exit codes are preserved. Temporary reports remain available until removed manually or cleaned by the operating system.

To make the command available globally after building:

```sh
pnpm link --global
cncv /path/to/project --node 22.14.0
```

The table lists package name, installed version, `engines.node`, dependency type, and status. Compatible (`OK`) packages are hidden; unknown, incompatible, and error results remain visible. All selected packages are still checked, and the summary counts include hidden compatible packages. If every checked package is compatible, a confirmation replaces the table. Checks include the project, direct dependencies, optional dependencies, peers, and transitive runtime dependencies. The project's dev dependencies are excluded by default; use `--include-dev` to check them too. Dependency type describes the first reference encountered, not every relationship in the graph.

- `--direct`: skip transitive dependencies.
- `--npm <version>`: target an exact npm version instead of detecting installed npm.
- `--omit-dev`: explicitly exclude the project's dev dependencies (the default).
- `--include-dev`: include the project's dev dependencies. Cannot be combined with `--omit-dev`. Transitive dev dependencies are always excluded.
- `--no-open`: terminal-only output; do not generate or open an HTML report.
- `--help`: show usage.

Results are ordered by severity: incompatible, blocked, error, invalid, missing, then unknown. Within each group, packages are sorted by name and version. Incompatible and blocked packages are marked `! INCOMPATIBLE` or `! BLOCKED` and highlighted in bold red in color-capable terminals; other visible statuses use yellow. Redirected output stays color-free, and `NO_COLOR` disables highlighting. Cells wrap to the terminal width (minimum layout width: 64 columns; default when redirected: 100 columns).

The checker supports nested and hoisted installations, scoped packages, and pnpm-style symlinks. Each real package location is checked once, so different installed versions remain separate. Dependency code and install scripts are never executed by the checker. Local checks make no registry requests; remote checks use the metadata sources described above.

## Status And Exit Codes

| Status | Meaning |
| --- | --- |
| OK | The Node engine passes, and any declared npm engine passes. |
| INCOMPATIBLE | A declared Node or npm engine range excludes its target version. |
| BLOCKED | The package's Node compatibility is unknown, but a descendant has a Node or npm engine mismatch. |
| UNKNOWN | No Node.js engine declaration exists. |
| MISSING | A declared dependency could not be found in node_modules. |
| INVALID | A Node.js or npm engine declaration is not a valid semver range. |
| ERROR | An installed dependency manifest could not be read or validated. |

Exit code `0` means no declared incompatibilities were found, `1` means incompatible or blocked packages were found, and `2` means an error or incomplete check. Code `2` takes precedence over `1`. Unknown declarations do not cause failure. Missing optional packages and optional peers are still reported as missing and produce code `2`, even if their absence is intentional.

## Unknown Package Tracing

Packages without `engines.node` are traced through their installed dependency graph, including paths through packages whose own declarations pass. Shared packages and cycles are handled by real package identity; separate installed versions remain distinct.

- An incompatible descendant changes an unknown package to `BLOCKED`. A note below its table row shows one shortest dependency chain, including installed versions and the incompatible engine range, for example `parent@1.0.0 -> middle@2.0.0 -> leaf@3.0.0`.
- Missing packages, invalid declarations, or unreadable manifests keep it `UNKNOWN` with an incomplete-check chain. An incompatible descendant takes precedence if both are found.
- Descendants without engine metadata keep it `UNKNOWN`, with a chain to an unknown dependency.
- When every descendant's declared engine passes, it stays `UNKNOWN` with a "Dependency engines satisfied" note. Packages with no dependencies get a "No dependencies to inspect" note.

These notes do not prove the unknown package's own runtime compatibility. Tracing respects the dev-dependency selection and is skipped with `--direct`; unknown packages explicitly state that tracing was skipped. The root project is traced too when it has no engine declaration. Packages with a valid declaration retain their own engine-check status; their incompatible descendants are still reported separately.

This checks declared metadata, not actual runtime behavior. Local checks inspect installed dependencies only, not lockfiles or registry metadata. They do not inspect unrelated/extraneous packages or support Yarn Plug'n'Play without node_modules. Remote analysis has the separate lockfile/registry limitations above. Symlinks use their real location, matching Node's default resolution rather than `--preserve-symlinks` behavior.

## Development

```sh
pnpm check
pnpm typecheck
pnpm lint:fix
```

`pnpm check` runs Oxlint with zero permitted warnings, compiles all source and tests, then runs the Node.js test suite. TypeScript uses `strict`, unchecked-index checks, exact optional property types, and unused-code checks. The Oxlint configuration in `.oxlintrc.json` carries over the supported ESLint recommended and TypeScript `strictTypeChecked` rules, plus explicit return types and consistent type imports. Type-aware checks are enabled through `oxlint-tsgolint`; the TypeScript compiler remains the build and typecheck authority. Lint scripts use a single worker for reliable execution with JavaScript plugins in this small project.

Formatting is enforced through Oxlint's JavaScript-plugin support using ESLint Stylistic: two-space indentation, single quotes, semicolons, trailing commas in multiline lists, consistent bracket/operator/type spacing, mandatory block braces, LF line endings, a final newline, no trailing spaces, and at most one consecutive blank line. Imports are separated from other statements; returns and function/class declarations have consistent blank lines. The retained `simple-import-sort` plugin groups imports as side effects, Node built-ins, external packages, other absolute imports, then relative imports, and also sorts named imports and exports. Type-only imports remain enforced by the native TypeScript rules. These plugins preserve the existing formatting conventions without a separate ESLint runner or formatter.

Run `pnpm lint:fix` to apply automatic formatting and import fixes. `pnpm lint` checks without modifying files; it remains part of `pnpm check` and packaging validation. No separate formatter is required.