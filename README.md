# CLI Runner Sidebar (VS Code Extension)

A modular VS Code extension that provides three workbench modules:

- `CLI Commands`: scan configured executables, parse `-h`, and run subcommands.
- `Tool Wrappers`: common SCM/ALM actions (CLI + REST mixed).
- `REST Services`: call external service APIs based on workspace context.

## Features

### 1) Activity Bar + Module Views

The extension contributes:

- View Container: `CLI Runner`
- Views:
  - `CLI Commands`
  - `Tool Wrappers`
  - `REST Services`

### 2) Discover configured executables

Use setting `cliRunner.executableNames`, for example:

```json
{
  "cliRunner.executableNames": [
    "mytool",
    "mytool.exe",
    "tools/mytool"
  ]
}
```

The extension searches the workspace and filters to executable files.

### 3) Parse commands from help output

It runs help args (default `-h`) and parses common command list formats.

### 4) Execute + enriched results

Click any action node to execute directly.

Execution experience:

- live progress notification (cancellable)
- raw stream logs in `Output` -> `CLI Runner`
- result webview with:
  - status / duration / command
  - key lines (error/warn/success/progress)
  - full output (expand/collapse)
  - REST request/response metadata and body (formatted JSON when possible)

### 5) Quickstart onboarding (first-run + on-demand)

On first activation, CLI Runner opens a guided quickstart page automatically.

The guide helps teams:

- complete required setup (workspace, executable discovery, scenario)
- run a guided click-tour across the 3 modules
- jump to plugin configuration actions directly from each checklist item
- open audit logs after workflow execution
- align on plugin design mindset (context-first, observable, deterministic workflow)

You can re-open anytime with `CLI Runner: Open Quickstart`.

### 6) Plugin interop API (callable + extensible)

CLI Runner now exposes a typed public API for other VS Code extensions.

Interop capabilities:

- list and run Tool/REST actions by ID
- execute raw process/REST requests through CLI Runner runtime
- dynamically register external Tool definitions and REST actions
- unregister dynamic registrations with token lifecycle
- call another extension's public API through a unified bridge
- subscribe to action execution events

Integration patterns:

- Type-safe: activate `chandler-local.cli-runner-sidebar` and use returned API object
- Command-based: use `cliRunner.interop.*` commands for protocol-style invocation
- Playground: use `CLI Runner: Open Interop Playground` for runnable integration snippets

Type-safe integration example:

```ts
const ext = vscode.extensions.getExtension('chandler-local.cli-runner-sidebar');
const api = await ext?.activate();
if (!api) { return; }

const caps = api.getCapabilities();
const tools = api.listToolActions();
await api.runToolActionById('automotive.pipeline');
```

## Settings

- `cliRunner.executableNames`: executable names or workspace-relative paths.
- `cliRunner.helpArgs`: args used to fetch help output (default `["-h"]`).
- `cliRunner.searchExcludeGlob`: search exclude glob.
- `cliRunner.maxExecutables`: max discovered executables.
- `cliRunner.helpTimeoutMs`: timeout for help process.
- `cliRunner.windowsOutputEncoding`: Windows output decode mode (`auto` / `utf8` / `gb18030`), useful for Chinese output garble.
- `cliRunner.toolExecutables`: executable mapping for tool wrappers.
- `cliRunner.restBaseUrl`: REST Services base URL.
- `cliRunner.almRestBaseUrl`: ALM REST tool base URL.
- `cliRunner.restToken` / `cliRunner.almRestToken`: auth tokens.
- `cliRunner.restTimeoutMs`: REST timeout.
- `cliRunner.restExtraHeaders`: extra REST headers.
- `cliRunner.activeScenario`: active automotive scenario key.
- `cliRunner.scenarios`: scenario map (`project/ecu/board/toolchain/buildType/...`).
- `cliRunner.variantMatrix`: variant map for matrix workflow.
- `cliRunner.pipelineSteps`: one-click pipeline step definitions.
- `cliRunner.preflightRequiredEnvVars`: global env preflight checks.
- `cliRunner.qualityGateMaxWarnings` / `cliRunner.qualityGateMaxErrors`: diagnostic quality gate thresholds.
- `cliRunner.enableDiagnostics`: publish parsed compiler diagnostics to Problems.
- `cliRunner.auditLogFile`: execution audit JSONL path.
- `cliRunner.updateCheckEnabled`: enable startup update checks.
- `cliRunner.updateCheckIntervalHours`: update check interval.
- `cliRunner.updateFeedUrl`: update feed URL.

## Automotive Quick Start (Embedded C)

```json
{
  "cliRunner.activeScenario": "BodyCtrl-Debug",
  "cliRunner.scenarios": {
    "BodyCtrl-Debug": {
      "project": "BodyCtrl",
      "ecu": "BCM",
      "board": "TC397",
      "toolchain": "cmake",
      "buildType": "Debug",
      "mcu": "TC397",
      "debugInterface": "jlink"
    }
  },
  "cliRunner.variantMatrix": {
    "Debug-TC397": {
      "variantName": "Debug-TC397",
      "buildType": "Debug",
      "board": "TC397"
    },
    "Release-TC397": {
      "variantName": "Release-TC397",
      "buildType": "Release",
      "board": "TC397"
    }
  },
  "cliRunner.preflightRequiredEnvVars": [
    "ARM_GCC_ROOT"
  ],
  "cliRunner.qualityGateMaxWarnings": 20,
  "cliRunner.qualityGateMaxErrors": 0
}
```

Then run in `Tool Wrappers`:

1. `Automotive Workflows -> Select Active Scenario`
2. `Automotive Workflows -> Run One-click Pipeline`
3. `Automotive Workflows -> Run Variant Matrix`
4. `Automotive Workflows -> Analyze .map Size`

Recommended analysis interfaces in `Tool Wrappers -> Embedded`:

- Static:
  - `Code Quality -> clang-tidy (Active File)`
  - `cppcheck -> cppcheck (Workspace)`
  - `PC-lint -> PC-lint (Workspace)`
  - `clang-format -> Format Check/Apply (Active File)`
  - `scan-build -> scan-build (Scenario Build)`
- Dynamic:
  - `CTest -> Run Unit Tests (All)/Run Smoke Tests`
  - `gcovr -> Coverage Summary (Text)/Coverage Report (XML)`
  - `Valgrind -> Memcheck (Host Binary)`
  - `QEMU -> QEMU Smoke Run`

## Commands

- `CLI Runner: Open View`
- `CLI Runner: Refresh`
- `CLI Runner: Add Executable Name`
- `CLI Runner: Run Command`
- `CLI Runner: Run Tool Wrapper Action`
- `CLI Runner: Run REST Resource Action`
- `CLI Runner: Set Active Scenario`
- `CLI Runner: Run Automotive Pipeline`
- `CLI Runner: Run Variant Matrix`
- `CLI Runner: Open Quickstart`
- `CLI Runner: Open Audit Log`
- `CLI Runner: Check For Updates`
- `CLI Runner: Open Interop Playground`

## Development

```bash
npm install
npm run compile
npm run package:vsix
```

Open this folder in VS Code and press `F5` to launch Extension Development Host.

## Maintenance

For maintainers, see [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

It includes:

- architecture and runtime flow
- extension guide for the three main modules (`CLI Commands`, `Tool Wrappers`, `REST Services`)
- external command interface requirements (help output format, exit code, stdout/stderr, Windows script behavior)
- configuration/package contribution sync checklist
- quick manual regression checklist with `mock-workspace/tools/cli-runner-test.cmd`

## Automated Distribution (GitHub Actions)

Workflows:

- `CI` (`.github/workflows/ci.yml`)
  - runs on push/PR
  - installs deps and compiles
- `Distribution` (`.github/workflows/distribution.yml`)
  - triggers on tags like `v0.1.0`
  - compiles and packages `.vsix`
  - uploads VSIX artifact
  - creates GitHub Release on tag
  - optional publish to VS Marketplace and OpenVSX

Required repository secrets for publish:

- `VSCE_PAT` for VS Code Marketplace
- `OVSX_PAT` for OpenVSX

Recommended release flow:

1. Update `package.json` version
2. Commit and push
3. Create and push matching tag (example: `v0.0.2`)
4. Workflow packages/releases/publishes automatically
