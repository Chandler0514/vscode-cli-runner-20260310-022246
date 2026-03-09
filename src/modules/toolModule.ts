import * as vscode from 'vscode';
import { readIntegrationConfig, setToolExecutable } from '../core/config';
import { buildRuntimeContext, applyTemplate } from '../core/context';
import { runProcessWithProgress, runRestWithProgress } from '../core/exec';
import { ResultPresenter } from '../core/resultPresenter';
import { RestAction, ToolAction, ToolDef, ToolDomain } from '../core/types';
import { InfoNode } from '../core/treeNodes';

type ToolTreeNode = InfoNode | ToolDomainNode | ToolNode | ToolActionNode;

const TOOL_DEFS: ToolDef[] = [
  {
    id: 'scm.svn',
    label: 'SVN',
    domain: 'SCM',
    executableKey: 'svn',
    defaultExecutable: 'svn',
    actions: [
      { id: 'svn.status', label: 'Status (Workspace)', description: 'Check workspace status', kind: 'cli', argsTemplate: ['status', '${workspacePath}'] },
      { id: 'svn.update', label: 'Update (Workspace)', description: 'Update workspace', kind: 'cli', argsTemplate: ['update', '${workspacePath}'] },
      { id: 'svn.log', label: 'Log (Active File)', description: 'Show active file history', kind: 'cli', argsTemplate: ['log', '${activeFilePath}'], requiresActiveFile: true }
    ]
  },
  {
    id: 'scm.integrity',
    label: 'Integrity SCM',
    domain: 'SCM',
    executableKey: 'si',
    defaultExecutable: 'si',
    actions: [
      { id: 'si.viewsandbox', label: 'View Sandbox', description: 'Inspect sandbox', kind: 'cli', argsTemplate: ['viewsandbox'] },
      { id: 'si.viewproject', label: 'View Project', description: 'Inspect project', kind: 'cli', argsTemplate: ['viewproject'] }
    ]
  },
  {
    id: 'scm.clearcase',
    label: 'ClearCase',
    domain: 'SCM',
    executableKey: 'cleartool',
    defaultExecutable: 'cleartool',
    actions: [
      { id: 'cc.lscheckout', label: 'List Checkouts', description: 'List checked-out files', kind: 'cli', argsTemplate: ['lscheckout', '-cview', '-me'] },
      { id: 'cc.history', label: 'History (Active File)', description: 'Show file history', kind: 'cli', argsTemplate: ['lshistory', '${activeFilePath}'], requiresActiveFile: true }
    ]
  },
  {
    id: 'alm.integrity',
    label: 'Integrity ALM',
    domain: 'ALM',
    executableKey: 'im',
    defaultExecutable: 'im',
    actions: [
      { id: 'im.my', label: 'My Open Items', description: 'Query my open items', kind: 'cli', argsTemplate: ['issues', '--queryDefinition=My Open Issues'] },
      {
        id: 'im.item',
        label: 'View Item (By ID)',
        description: 'View one item',
        kind: 'cli',
        argsTemplate: ['viewissue', '--issue=${itemId}'],
        prompt: { variable: 'itemId', title: 'Integrity Item ID', prompt: 'Enter item ID' }
      }
    ]
  },
  {
    id: 'alm.restTool',
    label: 'ALM REST Tool',
    domain: 'ALM',
    actions: [
      { id: 'alm.rest.list', label: 'List Work Items', description: 'Call ALM REST list API', kind: 'rest', method: 'GET', endpointTemplate: '/work-items?project=${workspaceName}', restTarget: 'alm' },
      {
        id: 'alm.rest.item',
        label: 'Get Work Item (By ID)',
        description: 'Call ALM REST detail API',
        kind: 'rest',
        method: 'GET',
        endpointTemplate: '/work-items/${itemId}',
        prompt: { variable: 'itemId', title: 'ALM Item ID', prompt: 'Enter item ID' },
        restTarget: 'alm'
      }
    ]
  },
  {
    id: 'alm.clearquest',
    label: 'ClearQuest',
    domain: 'ALM',
    executableKey: 'cqcmd',
    defaultExecutable: 'cqcmd',
    actions: [
      {
        id: 'cq.query',
        label: 'Run Query (By Name)',
        description: 'Run a named query',
        kind: 'cli',
        argsTemplate: ['query', '-name', '${queryName}'],
        prompt: { variable: 'queryName', title: 'ClearQuest Query Name', prompt: 'Enter query name' }
      }
    ]
  }
];

class ToolDomainNode extends vscode.TreeItem {
  public constructor(public readonly domain: ToolDomain) {
    super(domain, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(domain === 'SCM' ? 'source-control' : 'organization');
  }
}

class ToolNode extends vscode.TreeItem {
  public constructor(public readonly tool: ToolDef) {
    super(tool.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('tools');
  }
}

class ToolActionNode extends vscode.TreeItem {
  public constructor(public readonly tool: ToolDef, public readonly action: ToolAction) {
    super(action.label, vscode.TreeItemCollapsibleState.None);
    this.description = action.description;
    this.iconPath = new vscode.ThemeIcon(action.kind === 'rest' ? 'globe' : 'play-circle');
    this.command = {
      command: 'cliRunner.runToolAction',
      title: 'Run Tool Action',
      arguments: [this]
    };
  }
}

class ToolProvider implements vscode.TreeDataProvider<ToolTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ToolTreeNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public refresh(): void {
    this.emitter.fire();
  }

  public getAllActionNodes(): ToolActionNode[] {
    return TOOL_DEFS.flatMap((tool) => tool.actions.map((action) => new ToolActionNode(tool, action)));
  }

  public getTreeItem(element: ToolTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ToolTreeNode): Promise<ToolTreeNode[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [new InfoNode('Open a workspace folder to use Tool Wrappers')];
    }
    if (!element) {
      return [new ToolDomainNode('SCM'), new ToolDomainNode('ALM')];
    }
    if (element instanceof ToolDomainNode) {
      return TOOL_DEFS.filter((tool) => tool.domain === element.domain).map((tool) => new ToolNode(tool));
    }
    if (element instanceof ToolNode) {
      return element.tool.actions.map((action) => new ToolActionNode(element.tool, action));
    }
    return [];
  }
}

export class ToolModule {
  private readonly provider = new ToolProvider();

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly presenter: ResultPresenter
  ) {}

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('cliRunner.modules.tools', this.provider)
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.runToolAction', async (node?: ToolActionNode) => {
        const target = node ?? await this.pickAction();
        if (!target) {
          return;
        }
        await this.runAction(target);
      })
    );
  }

  public refresh(): void {
    this.provider.refresh();
  }

  private async pickAction(): Promise<ToolActionNode | undefined> {
    const nodes = this.provider.getAllActionNodes();
    const picked = await vscode.window.showQuickPick(
      nodes.map((node) => ({
        label: `[${node.tool.domain}] ${node.tool.label}: ${node.action.label}`,
        description: node.action.description,
        node
      })),
      { title: 'Choose tool action', matchOnDescription: true }
    );
    return picked?.node;
  }

  private async runAction(node: ToolActionNode): Promise<void> {
    if (node.action.kind === 'rest') {
      await this.runRestAction(node);
      return;
    }
    await this.runCliAction(node);
  }

  private async runCliAction(node: ToolActionNode): Promise<void> {
    const runtime = await buildRuntimeContext({
      prompt: node.action.prompt,
      requiresActiveFile: node.action.requiresActiveFile,
      requiresSelection: node.action.requiresSelection
    });
    if (!runtime) {
      return;
    }
    if (!runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const executable = await this.resolveExecutable(node.tool);
    if (!executable) {
      return;
    }

    const args = (node.action.argsTemplate ?? []).map((arg) => applyTemplate(arg, runtime.values)).filter((arg) => arg.length > 0);
    const model = await runProcessWithProgress({
      title: `${node.tool.label}: ${node.action.label}`,
      executable,
      args,
      cwd: runtime.workspacePath,
      output: this.output
    });

    this.presenter.showProcess(model);
    notifyProcess(model.result);
  }

  private async runRestAction(node: ToolActionNode): Promise<void> {
    const action = toRestAction(node.action, node.tool.label);
    const runtime = await buildRuntimeContext({
      prompt: action.prompt,
      requiresActiveFile: action.requiresActiveFile,
      requiresSelection: action.requiresSelection
    });
    if (!runtime) {
      return;
    }
    if (!runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const config = readIntegrationConfig();
    const target = action.restTarget ?? 'alm';
    const baseUrl = target === 'alm' ? config.almRestBaseUrl : config.restBaseUrl;
    const token = target === 'alm' ? config.almRestToken : config.restToken;
    if (!baseUrl) {
      vscode.window.showWarningMessage(`Set ${target === 'alm' ? 'cliRunner.almRestBaseUrl' : 'cliRunner.restBaseUrl'} first.`);
      return;
    }

    const endpoint = applyTemplate(action.endpointTemplate, runtime.values);
    const url = /^https?:\/\//i.test(endpoint) ? endpoint : `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...config.restExtraHeaders };
    if (token && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }

    const model = await runRestWithProgress({
      title: `${node.tool.label}: ${node.action.label}`,
      method: action.method,
      url,
      headers,
      timeoutMs: config.restTimeoutMs,
      output: this.output
    });

    this.presenter.showRest(model);
    notifyRest(model.result);
  }

  private async resolveExecutable(tool: ToolDef): Promise<string | undefined> {
    if (!tool.executableKey) {
      return undefined;
    }
    const config = readIntegrationConfig();
    const existing = config.toolExecutables[tool.executableKey];
    if (existing?.trim()) {
      return existing.trim();
    }

    const input = await vscode.window.showInputBox({
      title: `${tool.label} executable`,
      prompt: `Set command for ${tool.label}`,
      value: tool.defaultExecutable ?? tool.executableKey,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Executable is required.' : undefined
    });
    if (!input) {
      return undefined;
    }
    const executable = input.trim();
    await setToolExecutable(tool.executableKey, executable);
    return executable;
  }
}

function toRestAction(action: ToolAction, group: string): RestAction {
  return {
    id: action.id,
    group,
    label: action.label,
    description: action.description,
    method: action.method ?? 'GET',
    endpointTemplate: action.endpointTemplate ?? '/',
    prompt: action.prompt,
    requiresActiveFile: action.requiresActiveFile,
    requiresSelection: action.requiresSelection,
    restTarget: action.restTarget
  };
}

function notifyProcess(result: { exitCode: number; cancelled: boolean }): void {
  if (result.cancelled) {
    vscode.window.showWarningMessage('Command cancelled.');
    return;
  }
  if (result.exitCode === 0) {
    vscode.window.showInformationMessage('Command finished successfully.');
    return;
  }
  vscode.window.showWarningMessage(`Command finished with exit code ${result.exitCode}.`);
}

function notifyRest(result: { ok: boolean; status: number; statusText: string; cancelled: boolean; timedOut: boolean }): void {
  if (result.cancelled) {
    vscode.window.showWarningMessage(result.timedOut ? 'REST request timed out.' : 'REST request cancelled.');
    return;
  }
  if (result.ok) {
    vscode.window.showInformationMessage(`REST request succeeded (${result.status}).`);
    return;
  }
  vscode.window.showWarningMessage(`REST request failed (${result.status} ${result.statusText}).`);
}
