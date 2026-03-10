# Maintenance Guide

This document is for maintainers who need to extend or modify the extension safely.

## 1. Architecture At A Glance

The extension is organized into three feature modules plus shared core utilities:

- `src/modules/cliModule.ts`: `CLI Commands` view.
- `src/modules/toolModule.ts`: `Tool Wrappers` view (SCM/ALM actions, CLI + REST).
- `src/modules/restModule.ts`: `REST Services` view.
- `src/core/*`: shared runtime pieces (config, context, execution, discovery, result UI, types).
- `src/extension.ts`: module wiring, global commands, refresh orchestration.
- `package.json`: VS Code contributions (views, commands, activation events, settings schema).

Runtime flow (high level):

1. `extension.ts` creates module instances and registers commands/providers.
2. Tree view action triggers a module command (`runCommand`, `runToolAction`, `runRestAction`).
3. Module builds runtime context and templates arguments/endpoint.
4. Execution goes through `core/exec.ts` (`runProcessWithProgress` or `runRestWithProgress`).
5. Result is shown in Output panel + webview (`core/resultPresenter.ts`).

## 2. Shared Contracts (Read Before Extending)

### 2.1 Template Variables (`applyTemplate`)

Variables come from `buildRuntimeContext` in `src/core/context.ts`.

- Workspace: `${workspacePath}`, `${workspaceName}`
- Active file: `${activeFilePath}`, `${activeRelativePath}`, `${activeRelativePathEncoded}`
- Selection: `${selectionText}`, `${selectionTextEncoded}`
- User/input: `${userName}`, `${input}`, `${inputEncoded}`
- Prompt variable (dynamic): `${<prompt.variable>}` and `${<prompt.variable>Encoded}`

If `requiresActiveFile` or `requiresSelection` is set, action execution is blocked when missing.

### 2.2 Process Execution Contract

All external command execution goes through `executeProcessRaw`:

- `spawn(..., { shell: false })`: no shell expansion is available.
- Cancellation kills child process (`token` -> `child.kill()`).
- Output is streamed line-by-line; both `stdout` and `stderr` are captured.
- UI keeps up to 5000 lines and up to 80 key lines for summary.
- Progress percent is parsed from any line that matches `NNN%`.

Windows invocation rules:

- `.cmd` / `.bat`: `cmd.exe /d /s /c <script> ...args`
- `.ps1`: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <script> ...args`
- others: executed directly

### 2.3 REST Execution Contract

REST calls run via `fetch` in `executeRest`:

- Methods currently supported by type contract: `GET` and `POST`.
- Timeout + user cancellation are both supported (`AbortController`).
- Authorization header is auto-filled from token if caller did not already set `authorization`.
- Base URL is selected by `restTarget`:
  - `'resource'` -> `cliRunner.restBaseUrl` / `restToken`
  - `'alm'` -> `cliRunner.almRestBaseUrl` / `almRestToken`

## 3. Extending The Three Main Modules

### 3.1 CLI Commands Module (`src/modules/cliModule.ts`)

Goal: discover workspace executables, parse help text, run command nodes.

Common extension tasks:

1. Add executable candidates in workspace settings (`cliRunner.executableNames`).
2. If parser misses commands, update `parseHelpCommands` (`src/core/cliDiscovery.ts`).
3. If invocation behavior must change, update `resolveInvocation` (`src/core/exec.ts`).

Notes:

- Help command args come from `cliRunner.helpArgs` (default `["-h"]`).
- If help parsing returns no commands, module falls back to "run executable directly".
- Split behavior for subcommand strings uses `splitArgs` (supports simple single/double quoted segments).

### 3.2 Tool Wrappers Module (`src/modules/toolModule.ts`)

Goal: curated SCM/ALM action catalog with either CLI or REST execution.

Add or modify a tool/action in `TOOL_DEFS`:

1. Add a `ToolDef` block (or extend existing) with:
   - `id`, `label`, `domain`
   - optional `executableKey` + `defaultExecutable` for CLI tools
2. Add `actions` entries:
   - CLI action: `kind: "cli"` + `argsTemplate`
   - REST action: `kind: "rest"` + `method` + `endpointTemplate` + `restTarget`
3. Optional guards:
   - `prompt` for runtime input
   - `requiresActiveFile`, `requiresSelection`

Executable resolution behavior:

- Tool reads from `cliRunner.toolExecutables[executableKey]`.
- If missing, user is prompted and value is saved to workspace settings.

### 3.3 REST Services Module (`src/modules/restModule.ts`)

Goal: direct resource APIs grouped by business area.

Add action in `REST_ACTIONS`:

1. Define `id`, `group`, `label`, `description`.
2. Set `method` and `endpointTemplate`.
3. Set `restTarget` (`resource` or `alm`) to bind proper base URL/token.
4. Optionally set `prompt`, `requiresActiveFile`, `requiresSelection`.

Grouping UI is derived from `group` value automatically.

## 4. External Command Interface Requirements

When integrating a new executable for CLI Commands or Tool Wrappers, follow this contract for reliable parsing and UX.

### Required

1. Command should return quickly for configured help args (default `-h`).
2. Help output should include one command per line in one of these parseable forms:
   - `<command><2+ spaces><description>`
   - `<command> - <description>`
   - `<command>: <description>`
3. Command token format should be alphanumeric-first and use simple word separators (`[A-Za-z][\\w:-]*`); multi-token command names should stay short (up to 3 tokens).
4. Return non-zero exit code for failures.
5. Avoid interactive prompts for the non-interactive actions in sidebar runs.

### Recommended

1. Write operational progress to stdout/stderr as line-oriented text.
2. Include percent progress like `45%` so progress notifications can show increments.
3. Emit warnings/errors on `stderr`.
4. Keep help output stable to avoid command tree churn across versions.
5. Keep output meaningful in the first ~80 key lines (summary section uses heuristics).

### Windows Script Compatibility

If your executable is a script in workspace, prefer these extensions:

- `.cmd` / `.bat` for `cmd.exe`
- `.ps1` for PowerShell

Use quoted args for paths containing spaces.

## 5. Configuration And Contribution Checklist

When adding capabilities, keep code and contribution metadata in sync:

1. If you add a new user setting:
   - Update read path in `src/core/config.ts`.
   - Add schema in `package.json` under `contributes.configuration.properties`.
2. If you add a new command:
   - Register handler in module/extension code.
   - Add command metadata in `package.json` under `contributes.commands`.
   - Add activation event if needed (`onCommand:<id>`).
   - Optionally expose in `contributes.menus`.
3. If you add a new view/module:
   - Register tree provider in code.
   - Add view in `contributes.views`.
   - Ensure `onView:<viewId>` activation event exists.
   - Wire `refresh` orchestration in `src/extension.ts`.

## 6. Manual Regression Checklist

Use `mock-workspace/tools/cli-runner-test.cmd` for fast local validation:

1. `build`: success + progress percent parsing.
2. `test`: non-zero + stderr warnings/errors.
3. `longrun`: cancellation path.
4. `flood`: large output truncation behavior.
5. `quotes demo`: quoted/multi-token command parsing.

Then run compile before packaging:

```bash
npm run compile
```

## 7. Automotive Embedded Extensions

The extension now includes automotive-oriented capabilities for embedded C workflows.

### 7.1 Embedded Tool Wrappers

`Tool Wrappers` has an `Embedded` domain with tool presets:

- CMake / GNU Make
- IAR / Green Hills / Tasking bootstrap actions
- static analysis (`clang-tidy`, `cppcheck`, `pclint`, `clang-format`, `scan-build`)
- dynamic/runtime checks (`ctest`, `gcovr`, `valgrind`, `qemu-system-arm`)
- flashing/debug bootstrap (`openocd`, `JLinkExe`)
- workflow actions (scenario, pipeline, variant matrix, map analysis)

Main code location: `src/modules/toolModule.ts`.

### 7.2 Scenario And Variant Variables

Scenario and variant values are injected into templates through runtime context:

- scenario source: `cliRunner.scenarios` + `cliRunner.activeScenario`
- variant source: `cliRunner.variantMatrix`
- helpers: `src/core/automotive.ts`

Example template usage:

- `${project}`, `${ecu}`, `${board}`, `${toolchain}`, `${buildType}`
- `${scenarioName}`, `${variantName}`
- encoded counterparts are auto-generated (e.g. `${projectEncoded}`)

### 7.3 Pipeline + Matrix Workflow

Pipeline and matrix execution use settings-driven steps:

- setting: `cliRunner.pipelineSteps`
- parser: `readAutomotiveConfig` in `src/core/config.ts`
- execution engine: `executePipeline` in `src/modules/toolModule.ts`

Each step supports:

- `name`
- `executableKey`
- `argsTemplate`
- `continueOnError`
- `requiredEnvVars`

### 7.4 Diagnostics + Quality Gate

Compiler diagnostics are parsed and published to VS Code Problems:

- parser: `src/core/diagnostics.ts`
- quality gate: `evaluateQualityGate` in `src/core/automotive.ts`
- thresholds:
  - `cliRunner.qualityGateMaxErrors`
  - `cliRunner.qualityGateMaxWarnings`

Enable/disable diagnostics parsing with `cliRunner.enableDiagnostics`.

### 7.5 Audit Traceability

All CLI/REST/workflow runs can be logged as JSONL records:

- writer: `src/core/audit.ts`
- setting: `cliRunner.auditLogFile` (default `.cli-runner/audit-log.jsonl`)

Record fields include timestamp, kind, status, duration, scenario, variant, and command/URL detail.

### 7.6 .map Binary Size Analysis

Map parsing helpers:

- parser: `src/core/mapAnalysis.ts`
- workflow entry: `automotive.analyzeMap` in `src/modules/toolModule.ts`

Current summary includes:

- `.text/.rodata`
- `.data`
- `.bss`
- top section size ranking

## 8. Quickstart And UX Entry Points

Quickstart implementation:

- core file: `src/core/quickstart.ts`
- command: `cliRunner.openQuickstart`
- command: `cliRunner.openAuditLog`
- first-run auto open flag: extension global state key `cliRunner.quickstart.shown.v2`
- activation wiring: `src/extension.ts`

Behavior:

1. First activation auto-opens quickstart page once.
2. Users can re-open it from command palette or view title toolbar help icon.
3. Page includes clickable setup checks, guided click-tour path, and design mindset.
4. Tour flow includes direct links for settings search, module focusing, and opening audit log.

View toolbar icon migration:

- Commands in `view/title` now use icon contributions from `resources/icons/{light,dark}`.
- This keeps actions compact while retaining intent via command tooltip/title.

## 9. Windows Encoding And Update Checks

### 9.1 Windows Chinese Output Compatibility

Process output decoding now supports Windows-specific encoding selection:

- setting: `cliRunner.windowsOutputEncoding`
- values: `auto` / `utf8` / `gb18030`
- implementation: `src/core/exec.ts`

Notes:

- `auto` chooses `gb18030` for Chinese UI locale and `utf8` otherwise.
- `.cmd/.bat` invocation now uses command-line quoting for better path compatibility (including spaces/CJK).
- `iconv-lite` decoding is optional-fallback; if dependency is unavailable, runtime falls back to UTF-8 without crashing activation.

### 9.2 Auto Update Check + Confirmation Entry

Update checking implementation:

- core file: `src/core/updateChecker.ts`
- command: `cliRunner.checkForUpdates`
- startup hook: `activate` in `src/extension.ts`
- toolbar entry: `view/title` menu icon button

Update check settings:

- `cliRunner.updateCheckEnabled`
- `cliRunner.updateCheckIntervalHours`
- `cliRunner.updateFeedUrl`

## 10. Plugin Interop API

CLI Runner now supports extension-to-extension interoperability in both directions:

1. Other extensions can call CLI Runner APIs.
2. CLI Runner can call other extension APIs through a bridge call.

Core files:

- `src/core/interopApi.ts` (public API contracts)
- `src/core/interopHub.ts` (runtime implementation and command protocol)
- `src/extension.ts` (`activate` returns API object)
- `cliRunner.openInteropPlayground` (visual integration helper)

Public API highlights:

- `getCapabilities()`
- `listToolActions()` / `listRestActions()`
- `runToolActionById()` / `runRestActionById()`
- `runCliCommandByRef()`
- `executeProcess()` / `executeRest()`
- `registerToolDefinitions()` / `registerRestActions()`
- `callExtensionApi()`
- `onDidRun(...)`

Command protocol (`cliRunner.interop.*`):

- `getCapabilities`
- `listToolActions`
- `listRestActions`
- `runToolActionById`
- `runRestActionById`
- `executeProcess`
- `executeRest`
- `callExtensionApi`
- `registerToolDefinitions`
- `registerRestActions`
- `unregister`

Dynamic extension points:

- Tool wrappers: `ToolModule.registerExternalToolDefs(...)`
- REST services: `RestModule.registerExternalActions(...)`

External actions are merged into tree views and removable via returned disposable.
