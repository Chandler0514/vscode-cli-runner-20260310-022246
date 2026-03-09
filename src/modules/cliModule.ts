import * as vscode from 'vscode';
import { readCliConfig } from '../core/config';
import { buildExecutableEntry, discoverExecutables, splitArgs } from '../core/cliDiscovery';
import { runProcessWithProgress } from '../core/exec';
import { ResultPresenter } from '../core/resultPresenter';
import { ExecutableEntry, ParsedCliCommand } from '../core/types';
import { InfoNode } from '../core/treeNodes';

type CliTreeNode = InfoNode | ExecutableNode | CliCommandNode;

class ExecutableNode extends vscode.TreeItem {
  public constructor(public readonly entry: ExecutableEntry) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = vscode.workspace.asRelativePath(entry.path, false);
    this.tooltip = `${entry.path}\nCommands: ${entry.commands.length}`;
    this.iconPath = new vscode.ThemeIcon('terminal-bash');
  }
}

class CliCommandNode extends vscode.TreeItem {
  public constructor(public readonly entry: ExecutableEntry, public readonly commandDef: ParsedCliCommand) {
    super(commandDef.command || '(run executable)', vscode.TreeItemCollapsibleState.None);
    this.description = commandDef.description;
    this.tooltip = `${commandDef.command || '(run executable)'}${commandDef.description ? `\n${commandDef.description}` : ''}`;
    this.iconPath = new vscode.ThemeIcon('play-circle');
    this.command = {
      command: 'cliRunner.runCommand',
      title: 'Run CLI Command',
      arguments: [this]
    };
  }
}

class CliProvider implements vscode.TreeDataProvider<CliTreeNode> {
  private readonly emitter = new vscode.EventEmitter<CliTreeNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private loading = false;
  private entries: ExecutableEntry[] = [];
  private scanError?: string;

  public getTreeItem(element: CliTreeNode): vscode.TreeItem {
    return element;
  }

  public getEntries(): readonly ExecutableEntry[] {
    return this.entries;
  }

  public async refresh(): Promise<void> {
    this.loading = true;
    this.scanError = undefined;
    this.emitter.fire();

    try {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        this.entries = [];
        return;
      }

      const config = readCliConfig();
      const executablePaths = await discoverExecutables(workspace, config);
      const loaded = await Promise.all(executablePaths.map((exePath) => buildExecutableEntry(exePath, workspace.uri.fsPath, config)));
      this.entries = loaded.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      this.entries = [];
      this.scanError = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.emitter.fire();
    }
  }

  public async getChildren(element?: CliTreeNode): Promise<CliTreeNode[]> {
    if (element instanceof ExecutableNode) {
      const children: CliTreeNode[] = [];
      if (element.entry.helpError) {
        children.push(new InfoNode('Help parsing warning', element.entry.helpError));
      }
      if (element.entry.commands.length === 0) {
        children.push(new CliCommandNode(element.entry, {
          command: '',
          description: 'No subcommands parsed from -h. Run executable directly.'
        }));
        return children;
      }
      return element.entry.commands.map((cmd) => new CliCommandNode(element.entry, cmd));
    }

    if (element instanceof CliCommandNode) {
      return [];
    }

    if (!vscode.workspace.workspaceFolders?.length) {
      return [new InfoNode('Open a workspace folder to start')];
    }

    if (this.loading) {
      return [new InfoNode('Scanning executables...')];
    }

    if (this.scanError) {
      return [new InfoNode('Scan failed', this.scanError)];
    }

    if (this.entries.length === 0) {
      const cfg = readCliConfig();
      return cfg.executableNames.length === 0
        ? [new InfoNode('No executable configured', 'Use CLI Runner: Add Executable Name')]
        : [new InfoNode('No executable found', 'Check settings and refresh')];
    }

    return this.entries.map((entry) => new ExecutableNode(entry));
  }
}

export class CliModule {
  private readonly provider = new CliProvider();

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly presenter: ResultPresenter
  ) {}

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('cliRunner.modules.commands', this.provider)
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.pickExecutable', async () => {
        const input = await vscode.window.showInputBox({
          title: 'Add executable name or relative path',
          prompt: 'Example: mytool.exe or tools/mytool.cmd',
          ignoreFocusOut: true,
          validateInput: (value) => value.trim().length === 0 ? 'Value is required.' : undefined
        });
        if (!input) {
          return;
        }

        const value = input.trim();
        const config = readCliConfig();
        if (config.executableNames.includes(value)) {
          return;
        }

        await vscode.workspace.getConfiguration('cliRunner').update(
          'executableNames',
          [...config.executableNames, value],
          vscode.ConfigurationTarget.Workspace
        );
        await this.refresh();
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.runCommand', async (node?: CliCommandNode) => {
        const target = node ?? await this.pickCommand();
        if (!target) {
          return;
        }
        await this.runCommand(target);
      })
    );
  }

  public async refresh(): Promise<void> {
    await this.provider.refresh();
  }

  private async pickCommand(): Promise<CliCommandNode | undefined> {
    if (this.provider.getEntries().length === 0) {
      await this.provider.refresh();
    }
    const entries = this.provider.getEntries();
    const nodes = entries.flatMap((entry) => {
      const commands = entry.commands.length > 0 ? entry.commands : [{ command: '', description: 'Run executable directly.' }];
      return commands.map((commandDef) => new CliCommandNode(entry, commandDef));
    });

    const picked = await vscode.window.showQuickPick(
      nodes.map((node) => ({
        label: `${node.entry.name} ${node.commandDef.command || '(run)'}`.trim(),
        description: node.commandDef.description,
        detail: node.entry.path,
        node
      })),
      {
        title: 'Choose CLI command',
        matchOnDescription: true,
        matchOnDetail: true
      }
    );

    return picked?.node;
  }

  private async runCommand(node: CliCommandNode): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const model = await runProcessWithProgress({
      title: `${node.entry.name} ${node.commandDef.command}`.trim(),
      executable: node.entry.path,
      args: splitArgs(node.commandDef.command),
      cwd: workspace.uri.fsPath,
      output: this.output
    });

    this.presenter.showProcess(model);
    notifyProcess(model.result);
  }
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
