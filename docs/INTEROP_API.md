# Interop API Guide

This document describes how other VS Code extensions can integrate with CLI Runner.

## 1. Extension Identity

- Extension ID: `chandler-local.cli-runner-sidebar`
- API version field: `api.apiVersion`

## 2. Type-safe Integration

```ts
import * as vscode from 'vscode';

export async function integrateCliRunner() {
  const ext = vscode.extensions.getExtension('chandler-local.cli-runner-sidebar');
  if (!ext) {
    throw new Error('CLI Runner extension is not installed.');
  }

  const api = await ext.activate();
  const caps = api.getCapabilities();
  console.log(caps);

  const toolActions = api.listToolActions();
  const restActions = api.listRestActions();
  console.log(toolActions, restActions);

  await api.runToolActionById('automotive.pipeline');
}
```

## 3. Public API Surface

From `activate()` return object:

- `getCapabilities()`
- `listToolActions()`
- `listRestActions()`
- `runToolActionById(actionId)`
- `runRestActionById(actionId)`
- `runCliCommandByRef({ executablePath, command, title?, cwd? })`
- `executeProcess({ executable, args?, cwd? })`
- `executeRest({ method, url, headers?, body?, timeoutMs? })`
- `registerToolDefinitions(defs)` returns `vscode.Disposable`
- `registerRestActions(actions)` returns `vscode.Disposable`
- `openQuickstart()`
- `checkForUpdates(interactive?)`
- `callExtensionApi({ extensionId, method, args? })`
- `onDidRun(listener)`

## 4. Command Protocol (`cliRunner.interop.*`)

For non-type-safe callers (command-oriented protocol):

- `cliRunner.interop.getCapabilities`
- `cliRunner.interop.listToolActions`
- `cliRunner.interop.listRestActions`
- `cliRunner.interop.runToolActionById`
- `cliRunner.interop.runRestActionById`
- `cliRunner.interop.executeProcess`
- `cliRunner.interop.executeRest`
- `cliRunner.interop.callExtensionApi`
- `cliRunner.interop.registerToolDefinitions`
- `cliRunner.interop.registerRestActions`
- `cliRunner.interop.unregister` (token returned by register commands)

Command-based registration example:

```ts
const token = await vscode.commands.executeCommand<string>(
  'cliRunner.interop.registerRestActions',
  [{
    id: 'myext.health',
    group: 'My Extension',
    label: 'Health',
    description: 'Check backend health',
    method: 'GET',
    endpointTemplate: 'https://example.com/health'
  }]
);

// ... later
await vscode.commands.executeCommand('cliRunner.interop.unregister', token);
```

## 5. Dynamic Action Registration

### 5.1 Tool Definitions

Use `registerToolDefinitions(defs)` (API) or command equivalent.

Requirements:

- Each `ToolDef.id` must be unique.
- Each `ToolAction.id` should be globally unique.
- Duplicate IDs are skipped and logged.

### 5.2 REST Actions

Use `registerRestActions(actions)` (API) or command equivalent.

Requirements:

- `RestAction.id` must be unique.
- `endpointTemplate` supports CLI Runner template variables.

## 6. Event Stream

Subscribe via `onDidRun(listener)`.

Event shape:

- `type`: `tool` | `rest` | `process` | `extensionApi`
- `id`: action ID / command ID / registration token
- `success`: boolean
- `timestamp`: ISO string
- `detail` (optional)

## 7. Cross-extension API Bridge

Use `callExtensionApi` to call APIs from another extension:

```ts
await api.callExtensionApi({
  extensionId: 'publisher.other-extension',
  method: 'runHealthCheck',
  args: ['foo']
});
```

Behavior:

- Activates target extension if needed.
- Throws if extension/method is missing.
- Emits interop event for success/failure.

## 8. Safety And Design Notes

- Prefer explicit action IDs over hard-coded labels.
- Use disposable unregistration for lifecycle safety.
- Avoid invoking destructive commands without user confirmation.
- Keep integrations resilient to missing optional capabilities by checking `getCapabilities()`.
