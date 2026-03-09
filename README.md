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

## Settings

- `cliRunner.executableNames`: executable names or workspace-relative paths.
- `cliRunner.helpArgs`: args used to fetch help output (default `["-h"]`).
- `cliRunner.searchExcludeGlob`: search exclude glob.
- `cliRunner.maxExecutables`: max discovered executables.
- `cliRunner.helpTimeoutMs`: timeout for help process.
- `cliRunner.toolExecutables`: executable mapping for tool wrappers.
- `cliRunner.restBaseUrl`: REST Services base URL.
- `cliRunner.almRestBaseUrl`: ALM REST tool base URL.
- `cliRunner.restToken` / `cliRunner.almRestToken`: auth tokens.
- `cliRunner.restTimeoutMs`: REST timeout.
- `cliRunner.restExtraHeaders`: extra REST headers.

## Commands

- `CLI Runner: Open View`
- `CLI Runner: Refresh`
- `CLI Runner: Add Executable Name`
- `CLI Runner: Run Command`
- `CLI Runner: Run Tool Wrapper Action`
- `CLI Runner: Run REST Resource Action`

## Development

```bash
npm install
npm run compile
npm run package:vsix
```

Open this folder in VS Code and press `F5` to launch Extension Development Host.

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
