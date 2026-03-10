import * as vscode from 'vscode';
import { readIntegrationConfig } from './config';
import { executeProcessRaw, executeRestRaw } from './exec';
import {
  CliRunnerActionSummary,
  CliRunnerCallExtensionApiRequest,
  CliRunnerCapabilities,
  CliRunnerExecuteProcessRequest,
  CliRunnerExecuteRestRequest,
  CliRunnerExtensionApi,
  CliRunnerInteropEvent
} from './interopApi';
import { ProcessResult, RestResult } from './types';
import { QuickstartGuide } from './quickstart';
import { UpdateChecker } from './updateChecker';
import { CliModule } from '../modules/cliModule';
import { RestModule } from '../modules/restModule';
import { ToolModule } from '../modules/toolModule';
import { RestAction, ToolDef } from './types';

const API_VERSION = '1.0.0';

export class InteropHub {
  private readonly emitter = new vscode.EventEmitter<CliRunnerInteropEvent>();
  private playgroundPanel: vscode.WebviewPanel | undefined;
  private readonly registrationDisposables = new Map<string, vscode.Disposable>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly quickstart: QuickstartGuide,
    private readonly updater: UpdateChecker,
    private readonly cliModule: CliModule,
    private readonly toolModule: ToolModule,
    private readonly restModule: RestModule
  ) {
    this.context.subscriptions.push(this.emitter);
  }

  public registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.getCapabilities', () => this.getCapabilities())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.listToolActions', () => this.listToolActions())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.listRestActions', () => this.listRestActions())
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.runToolActionById', async (actionId?: string) => {
        if (!actionId) {
          throw new Error('actionId is required.');
        }
        return this.runToolActionById(actionId);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.runRestActionById', async (actionId?: string) => {
        if (!actionId) {
          throw new Error('actionId is required.');
        }
        return this.runRestActionById(actionId);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.executeProcess', async (request?: CliRunnerExecuteProcessRequest) => {
        if (!request) {
          throw new Error('process request is required.');
        }
        return this.executeProcess(request);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.executeRest', async (request?: CliRunnerExecuteRestRequest) => {
        if (!request) {
          throw new Error('rest request is required.');
        }
        return this.executeRest(request);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.callExtensionApi', async (request?: CliRunnerCallExtensionApiRequest) => {
        if (!request) {
          throw new Error('request is required.');
        }
        return this.callExtensionApi(request);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.registerToolDefinitions', async (defs?: readonly ToolDef[]) => {
        if (!defs || defs.length === 0) {
          throw new Error('tool definitions are required.');
        }
        return this.registerToolDefinitions(defs);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.registerRestActions', async (actions?: readonly RestAction[]) => {
        if (!actions || actions.length === 0) {
          throw new Error('rest actions are required.');
        }
        return this.registerRestActions(actions);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.interop.unregister', async (token?: string) => {
        if (!token) {
          throw new Error('registration token is required.');
        }
        return this.unregister(token);
      })
    );

    this.context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.openInteropPlayground', async () => {
        this.openPlayground();
      })
    );
  }

  public getApi(): CliRunnerExtensionApi {
    return {
      apiVersion: API_VERSION,
      getCapabilities: () => this.getCapabilities(),
      listToolActions: () => this.listToolActions(),
      listRestActions: () => this.listRestActions(),
      runToolActionById: (actionId) => this.runToolActionById(actionId),
      runRestActionById: (actionId) => this.runRestActionById(actionId),
      runCliCommandByRef: (options) => this.runCliCommandByRef(options),
      executeProcess: (request) => this.executeProcess(request),
      executeRest: (request) => this.executeRest(request),
      registerToolDefinitions: (defs) => this.toolModule.registerExternalToolDefs(defs),
      registerRestActions: (actions) => this.restModule.registerExternalActions(actions),
      openQuickstart: () => this.quickstart.open(),
      checkForUpdates: (interactive = true) => this.updater.check(interactive),
      callExtensionApi: (request) => this.callExtensionApi(request),
      onDidRun: (listener) => this.emitter.event(listener)
    };
  }

  public getCapabilities(): CliRunnerCapabilities {
    return {
      apiVersion: API_VERSION,
      features: [
        'toolActionExecutionById',
        'restActionExecutionById',
        'dynamicToolRegistration',
        'dynamicRestRegistration',
        'commandProtocolRegistration',
        'rawProcessExecution',
        'rawRestExecution',
        'crossExtensionApiCall',
        'interopEvents'
      ]
    };
  }

  public listToolActions(): CliRunnerActionSummary[] {
    return this.toolModule.listActionSummaries().map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      kind: item.kind,
      group: item.toolLabel,
      domain: item.domain,
      source: item.source
    }));
  }

  public listRestActions(): CliRunnerActionSummary[] {
    return this.restModule.listActionSummaries().map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      kind: 'restOnly',
      group: item.group,
      source: item.source
    }));
  }

  public async runToolActionById(actionId: string): Promise<boolean> {
    const ok = await this.toolModule.runActionById(actionId);
    this.emit({
      type: 'tool',
      id: actionId,
      success: ok,
      detail: ok ? undefined : 'Action id not found'
    });
    return ok;
  }

  public async runRestActionById(actionId: string): Promise<boolean> {
    const ok = await this.restModule.runActionById(actionId);
    this.emit({
      type: 'rest',
      id: actionId,
      success: ok,
      detail: ok ? undefined : 'Action id not found'
    });
    return ok;
  }

  public async runCliCommandByRef(options: {
    readonly executablePath: string;
    readonly command: string;
    readonly title?: string;
    readonly cwd?: string;
  }): Promise<boolean> {
    const ok = await this.cliModule.runCommandByRef(options);
    this.emit({
      type: 'process',
      id: `${options.executablePath} ${options.command}`.trim(),
      success: ok
    });
    return ok;
  }

  public async executeProcess(request: CliRunnerExecuteProcessRequest): Promise<ProcessResult> {
    const executable = request.executable?.trim();
    if (!executable) {
      throw new Error('executeProcess requires executable.');
    }
    const args = request.args ?? [];
    const cwd = request.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cts = new vscode.CancellationTokenSource();
    try {
      const result = await executeProcessRaw(
        executable,
        args,
        cwd,
        cts.token,
        () => undefined
      );
      this.emit({
        type: 'process',
        id: [executable, ...args].join(' '),
        success: !result.cancelled && result.exitCode === 0,
        detail: `exitCode=${result.exitCode}`
      });
      return result;
    } finally {
      cts.dispose();
    }
  }

  public registerToolDefinitions(defs: readonly ToolDef[]): string {
    const disposable = this.toolModule.registerExternalToolDefs(defs);
    const token = createRegistrationToken('tool');
    this.registrationDisposables.set(token, disposable);
    this.emit({
      type: 'tool',
      id: token,
      success: true,
      detail: `registered ${defs.length} tool definition(s)`
    });
    return token;
  }

  public registerRestActions(actions: readonly RestAction[]): string {
    const disposable = this.restModule.registerExternalActions(actions);
    const token = createRegistrationToken('rest');
    this.registrationDisposables.set(token, disposable);
    this.emit({
      type: 'rest',
      id: token,
      success: true,
      detail: `registered ${actions.length} rest action(s)`
    });
    return token;
  }

  public unregister(token: string): boolean {
    const disposable = this.registrationDisposables.get(token);
    if (!disposable) {
      this.emit({
        type: 'extensionApi',
        id: token,
        success: false,
        detail: 'registration token not found'
      });
      return false;
    }
    this.registrationDisposables.delete(token);
    disposable.dispose();
    this.emit({
      type: 'extensionApi',
      id: token,
      success: true,
      detail: 'registration disposed'
    });
    return true;
  }

  public async executeRest(request: CliRunnerExecuteRestRequest): Promise<RestResult> {
    const method = request.method;
    const url = request.url?.trim();
    if (!url) {
      throw new Error('executeRest requires url.');
    }
    const timeoutMs = request.timeoutMs ?? readIntegrationConfig().restTimeoutMs;
    const cts = new vscode.CancellationTokenSource();
    try {
      const result = await executeRestRaw(
        method,
        url,
        request.headers ?? {},
        request.body,
        timeoutMs,
        cts.token
      );
      this.emit({
        type: 'rest',
        id: `${method} ${url}`,
        success: !result.cancelled && result.ok,
        detail: `${result.status} ${result.statusText}`
      });
      return result;
    } finally {
      cts.dispose();
    }
  }

  public async callExtensionApi(request: CliRunnerCallExtensionApiRequest): Promise<unknown> {
    const extensionId = request.extensionId?.trim();
    const method = request.method?.trim();
    if (!extensionId || !method) {
      throw new Error('callExtensionApi requires extensionId and method.');
    }

    const extension = vscode.extensions.getExtension(extensionId);
    if (!extension) {
      throw new Error(`Extension "${extensionId}" not found.`);
    }

    const api = await extension.activate() as Record<string, unknown>;
    const fn = api[method];
    if (typeof fn !== 'function') {
      throw new Error(`Method "${method}" was not found in extension API.`);
    }

    try {
      const result = await (fn as (...args: unknown[]) => unknown)(...(request.args ?? []));
      this.emit({
        type: 'extensionApi',
        id: `${extensionId}.${method}`,
        success: true
      });
      return result;
    } catch (error) {
      this.emit({
        type: 'extensionApi',
        id: `${extensionId}.${method}`,
        success: false,
        detail: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public openPlayground(): void {
    if (!this.playgroundPanel) {
      this.playgroundPanel = vscode.window.createWebviewPanel(
        'cliRunner.interop.playground',
        'CLI Runner Interop Playground',
        vscode.ViewColumn.Active,
        { enableCommandUris: true, retainContextWhenHidden: true }
      );
      this.playgroundPanel.onDidDispose(() => {
        this.playgroundPanel = undefined;
      });
    }

    this.playgroundPanel.webview.html = this.buildPlaygroundHtml();
    this.playgroundPanel.reveal(vscode.ViewColumn.Active, true);
  }

  private emit(event: Omit<CliRunnerInteropEvent, 'timestamp'>): void {
    const payload: CliRunnerInteropEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };
    this.output.appendLine(`[interop] ${payload.type} ${payload.id} -> ${payload.success ? 'ok' : 'fail'}${payload.detail ? ` (${payload.detail})` : ''}`);
    this.emitter.fire(payload);
  }

  private buildPlaygroundHtml(): string {
    const extensionId = `${this.context.extension.packageJSON.publisher}.${this.context.extension.packageJSON.name}`;
    const code = `import * as vscode from 'vscode';

export async function callCliRunner() {
  const ext = vscode.extensions.getExtension('${extensionId}');
  if (!ext) { throw new Error('CLI Runner extension not found'); }
  const api = await ext.activate();

  const caps = api.getCapabilities();
  console.log('caps', caps);

  const toolActions = api.listToolActions();
  console.log('tool actions', toolActions);

  await api.runToolActionById('automotive.pipeline');

  const disposable = api.registerRestActions([
    {
      id: 'myext.health',
      group: 'My Extension',
      label: 'Health',
      description: 'Check service health',
      method: 'GET',
      endpointTemplate: 'https://example.com/health'
    }
  ]);

  // when no longer needed:
  // disposable.dispose();
}`;

    const commandSample = `const token = await vscode.commands.executeCommand(
  'cliRunner.interop.registerRestActions',
  [{
    id: 'myext.health',
    group: 'My Extension',
    label: 'Health',
    description: 'Check service health',
    method: 'GET',
    endpointTemplate: 'https://example.com/health'
  }]
);

await vscode.commands.executeCommand(
  'cliRunner.interop.executeProcess',
  { executable: 'cmake', args: ['--version'] }
);

await vscode.commands.executeCommand('cliRunner.interop.unregister', token);`;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Interop Playground</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      margin: 0;
      padding: 14px;
      line-height: 1.5;
    }
    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-border) 8%);
    }
    h1 { margin: 0 0 8px 0; font-size: 18px; }
    h2 { margin: 0 0 8px 0; font-size: 14px; }
    pre {
      margin: 0;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, black 14%);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .btn {
      text-decoration: none;
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 8px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, transparent);
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>CLI Runner Interop Playground</h1>
    <p>Build plugin-to-plugin integrations quickly using public API + command protocol.</p>
    <div class="actions">
      <a class="btn" href="command:cliRunner.interop.getCapabilities">Get Capabilities</a>
      <a class="btn" href="command:cliRunner.openQuickstart">Open Quickstart</a>
    </div>
  </div>

  <div class="card">
    <h2>Public API Example (Type-safe)</h2>
    <pre>${escapeHtml(code)}</pre>
  </div>

  <div class="card">
    <h2>Command Protocol Example</h2>
    <pre>${escapeHtml(commandSample)}</pre>
  </div>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createRegistrationToken(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}
