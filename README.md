# CLI Runner Sidebar (VS Code Extension)

A sample VS Code extension that:

- adds an icon in the Activity Bar (left sidebar)
- scans executables in the current workspace based on configured names
- runs `<executable> -h` (configurable) to parse available subcommands
- maps parsed commands into a Tree View
- executes command on click
- captures output and shows:
  - live progress notification
  - raw stream in an Output Channel
  - beautified summary in a Webview panel

## Features

### 1) Activity Bar + Tree View

The extension contributes:

- View Container: `CLI Runner`
- View: `CLI Commands`

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

### 4) Run command + visualize output

Click a command item to execute.

The extension will:

- stream logs into `Output` -> `CLI Runner`
- track simple percent progress when lines include `NN%`
- extract key lines (error/warn/success/done/progress)
- render summary and full logs in a webview panel

## Settings

- `cliRunner.executableNames`: executable names or workspace-relative paths.
- `cliRunner.helpArgs`: args used to fetch help output (default `["-h"]`).
- `cliRunner.searchExcludeGlob`: search exclude glob.
- `cliRunner.maxExecutables`: max discovered executables.
- `cliRunner.helpTimeoutMs`: timeout for help process.

## Commands

- `CLI Runner: Refresh`
- `CLI Runner: Add Executable Name`
- `CLI Runner: Run Command`

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to launch Extension Development Host.

Then:

1. Open a workspace that contains target executable.
2. Run `CLI Runner: Add Executable Name`.
3. Click refresh if needed.
4. Expand executable and click command.
