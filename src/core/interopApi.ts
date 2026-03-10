import * as vscode from 'vscode';
import { HttpMethod, ProcessResult, RestAction, RestResult, ToolDef } from './types';

export interface CliRunnerActionSummary {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: 'cli' | 'rest' | 'workflow' | 'restOnly';
  readonly group: string;
  readonly domain?: string;
  readonly source: 'builtin' | 'external';
}

export interface CliRunnerCapabilities {
  readonly apiVersion: string;
  readonly features: readonly string[];
}

export interface CliRunnerInteropEvent {
  readonly type: 'tool' | 'rest' | 'process' | 'extensionApi';
  readonly id: string;
  readonly success: boolean;
  readonly timestamp: string;
  readonly detail?: string;
}

export interface CliRunnerExecuteProcessRequest {
  readonly executable: string;
  readonly args?: string[];
  readonly cwd?: string;
}

export interface CliRunnerExecuteRestRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface CliRunnerCallExtensionApiRequest {
  readonly extensionId: string;
  readonly method: string;
  readonly args?: unknown[];
}

export interface CliRunnerExtensionApi {
  readonly apiVersion: string;
  getCapabilities(): CliRunnerCapabilities;
  listToolActions(): CliRunnerActionSummary[];
  listRestActions(): CliRunnerActionSummary[];
  runToolActionById(actionId: string): Promise<boolean>;
  runRestActionById(actionId: string): Promise<boolean>;
  runCliCommandByRef(options: {
    readonly executablePath: string;
    readonly command: string;
    readonly title?: string;
    readonly cwd?: string;
  }): Promise<boolean>;
  executeProcess(request: CliRunnerExecuteProcessRequest): Promise<ProcessResult>;
  executeRest(request: CliRunnerExecuteRestRequest): Promise<RestResult>;
  registerToolDefinitions(defs: readonly ToolDef[]): vscode.Disposable;
  registerRestActions(actions: readonly RestAction[]): vscode.Disposable;
  openQuickstart(): Promise<void>;
  checkForUpdates(interactive?: boolean): Promise<void>;
  callExtensionApi(request: CliRunnerCallExtensionApiRequest): Promise<unknown>;
  onDidRun(listener: (event: CliRunnerInteropEvent) => void): vscode.Disposable;
}
