import * as vscode from 'vscode';
import { readIntegrationConfig } from '../core/config';
import { buildRuntimeContext, applyTemplate } from '../core/context';
import { runRestWithProgress } from '../core/exec';
import { ResultPresenter } from '../core/resultPresenter';
import { RestAction } from '../core/types';
import { InfoNode } from '../core/treeNodes';

type RestTreeNode = InfoNode | RestGroupNode | RestActionNode;

const REST_ACTIONS: RestAction[] = [
  {
    id: 'rest.resources',
    group: 'Project Resources',
    label: 'Fetch Project Resources',
    description: 'Get resources by workspace name',
    method: 'GET',
    endpointTemplate: '/projects/${workspaceName}/resources',
    restTarget: 'resource'
  },
  {
    id: 'rest.fileMeta',
    group: 'Project Resources',
    label: 'Fetch Active File Metadata',
    description: 'Get active file resource metadata',
    method: 'GET',
    endpointTemplate: '/projects/${workspaceName}/files/metadata?path=${activeRelativePathEncoded}',
    requiresActiveFile: true,
    restTarget: 'resource'
  },
  {
    id: 'rest.search',
    group: 'Project Resources',
    label: 'Search Project Resources',
    description: 'Search project resources',
    method: 'GET',
    endpointTemplate: '/projects/${workspaceName}/search?q=${keywordEncoded}',
    prompt: {
      variable: 'keyword',
      title: 'Resource Keyword',
      prompt: 'Enter search keyword'
    },
    restTarget: 'resource'
  },
  {
    id: 'rest.buildSummary',
    group: 'Repository Intelligence',
    label: 'Fetch Latest Build Summary',
    description: 'Get latest build summary',
    method: 'GET',
    endpointTemplate: '/projects/${workspaceName}/builds/latest',
    restTarget: 'resource'
  }
];

class RestGroupNode extends vscode.TreeItem {
  public constructor(public readonly group: string) {
    super(group, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('cloud');
  }
}

class RestActionNode extends vscode.TreeItem {
  public constructor(public readonly action: RestAction) {
    super(action.label, vscode.TreeItemCollapsibleState.None);
    this.description = action.description;
    this.iconPath = new vscode.ThemeIcon('globe');
    this.command = {
      command: 'cliRunner.runRestAction',
      title: 'Run REST Action',
      arguments: [this]
    };
  }
}

class RestProvider implements vscode.TreeDataProvider<RestTreeNode> {
  private readonly emitter = new vscode.EventEmitter<RestTreeNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public refresh(): void {
    this.emitter.fire();
  }

  public getAllActionNodes(): RestActionNode[] {
    return REST_ACTIONS.map((action) => new RestActionNode(action));
  }

  public getTreeItem(element: RestTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: RestTreeNode): Promise<RestTreeNode[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [new InfoNode('Open a workspace folder to use REST Services')];
    }
    if (!element) {
      return Array.from(new Set(REST_ACTIONS.map((action) => action.group))).map((group) => new RestGroupNode(group));
    }
    if (element instanceof RestGroupNode) {
      return REST_ACTIONS.filter((action) => action.group === element.group).map((action) => new RestActionNode(action));
    }
    return [];
  }
}

export class RestModule {
  private readonly provider = new RestProvider();

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly presenter: ResultPresenter
  ) {}

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('cliRunner.modules.rest', this.provider)
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.runRestAction', async (node?: RestActionNode) => {
        const target = node ?? await this.pickAction();
        if (!target) {
          return;
        }
        await this.runAction(target.action);
      })
    );
  }

  public refresh(): void {
    this.provider.refresh();
  }

  private async pickAction(): Promise<RestActionNode | undefined> {
    const nodes = this.provider.getAllActionNodes();
    const picked = await vscode.window.showQuickPick(
      nodes.map((node) => ({
        label: `${node.action.group}: ${node.action.label}`,
        description: node.action.description,
        detail: node.action.endpointTemplate,
        node
      })),
      {
        title: 'Choose REST action',
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    return picked?.node;
  }

  private async runAction(action: RestAction): Promise<void> {
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
    const target = action.restTarget ?? 'resource';
    const baseUrl = target === 'alm' ? config.almRestBaseUrl : config.restBaseUrl;
    const token = target === 'alm' ? config.almRestToken : config.restToken;
    if (!baseUrl) {
      vscode.window.showWarningMessage(`Set ${target === 'alm' ? 'cliRunner.almRestBaseUrl' : 'cliRunner.restBaseUrl'} first.`);
      return;
    }

    const endpoint = applyTemplate(action.endpointTemplate, runtime.values);
    const url = /^https?:\/\//i.test(endpoint) ? endpoint : `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...config.restExtraHeaders };
    if (token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }

    const model = await runRestWithProgress({
      title: `REST Services: ${action.label}`,
      method: action.method,
      url,
      headers,
      timeoutMs: config.restTimeoutMs,
      output: this.output
    });

    this.presenter.showRest(model);
    notifyRest(model.result);
  }
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
