import * as vscode from 'vscode';
import { appendAuditRecord } from '../core/audit';
import { evaluateQualityGate, getScenarioValues } from '../core/automotive';
import { readCliConfig, readIntegrationConfig } from '../core/config';
import { buildExecutableEntry, discoverExecutables, splitArgs } from '../core/cliDiscovery';
import { parseDiagnostics, publishDiagnostics } from '../core/diagnostics';
import { runProcessWithProgress } from '../core/exec';
import { ResultPresenter } from '../core/resultPresenter';
import { IntegrationConfig, ExecutableEntry, ParsedCliCommand, ProcessRunViewModel } from '../core/types';
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
    const display = formatParsedCommandForDisplay(commandDef);
    super(display || '(run executable)', vscode.TreeItemCollapsibleState.None);
    this.description = commandDef.description;
    this.tooltip = `${display || '(run executable)'}${commandDef.description ? `\n${commandDef.description}` : ''}`;
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
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('cliRunner.cli');

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly presenter: ResultPresenter
  ) {}

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.diagnostics);
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

  public listCommandSummaries(): Array<{
    readonly executablePath: string;
    readonly executableName: string;
    readonly command: string;
    readonly description: string;
  }> {
    return this.provider.getEntries().flatMap((entry) => {
      const commands = entry.commands.length > 0 ? entry.commands : [{ command: '', description: 'Run executable directly.' }];
      return commands.map((commandDef) => ({
        executablePath: entry.path,
        executableName: entry.name,
        command: commandDef.command,
        description: commandDef.description
      }));
    });
  }

  public async runCommandByRef(options: {
    readonly executablePath: string;
    readonly command: string;
    readonly title?: string;
    readonly cwd?: string;
  }): Promise<boolean> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const cwd = options.cwd ?? workspace?.uri.fsPath;
    if (!cwd) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return false;
    }

    const integration = readIntegrationConfig();
    const scenario = getScenarioValues(integration.automotive);
    const baseModel = await runProcessWithProgress({
      title: options.title ?? `${pathBaseName(options.executablePath)} ${options.command}`.trim(),
      executable: options.executablePath,
      args: splitArgs(options.command),
      cwd,
      output: this.output
    });

    const model = this.enrichModel(baseModel, cwd, integration);
    this.presenter.showProcess(model);
    notifyProcess(model.result);

    try {
      await appendAuditRecord(cwd, integration.automotive.auditLogFile, {
        timestamp: new Date().toISOString(),
        kind: 'process',
        title: model.title,
        scenarioName: scenario.scenarioName,
        success: !model.result.cancelled && model.result.exitCode === 0,
        durationMs: model.result.durationMs,
        exitCode: model.result.exitCode,
        detail: model.displayCommand
      });
    } catch (error) {
      this.output.appendLine(`[audit] Failed to append record: ${error instanceof Error ? error.message : String(error)}`);
    }

    return true;
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
        label: `${node.entry.name} ${formatParsedCommandForDisplay(node.commandDef) || '(run)'}`.trim(),
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

    const integration = readIntegrationConfig();
    const scenario = getScenarioValues(integration.automotive);
    const commandArgs = await this.collectCommandArgs(node.entry.name, node.commandDef);
    if (!commandArgs) {
      return;
    }

    const baseModel = await runProcessWithProgress({
      title: `${node.entry.name} ${formatParsedCommandForDisplay(node.commandDef)}`.trim(),
      executable: node.entry.path,
      args: commandArgs,
      cwd: workspace.uri.fsPath,
      output: this.output
    });

    const model = this.enrichModel(baseModel, workspace.uri.fsPath, integration);
    this.presenter.showProcess(model);
    notifyProcess(model.result);

    try {
      await appendAuditRecord(workspace.uri.fsPath, integration.automotive.auditLogFile, {
        timestamp: new Date().toISOString(),
        kind: 'process',
        title: model.title,
        scenarioName: scenario.scenarioName,
        success: !model.result.cancelled && model.result.exitCode === 0,
        durationMs: model.result.durationMs,
        exitCode: model.result.exitCode,
        detail: model.displayCommand
      });
    } catch (error) {
      this.output.appendLine(`[audit] Failed to append record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async collectCommandArgs(executableName: string, commandDef: ParsedCliCommand): Promise<string[] | undefined> {
    const baseArgs = splitArgs(commandDef.command);
    const specs = commandDef.argsSpec ?? [];
    if (specs.length === 0) {
      return baseArgs;
    }

    const collected: string[] = [];
    for (const spec of specs) {
      const tokenLabel = spec.required
        ? `<${spec.name}${spec.variadic ? '...' : ''}>`
        : `[${spec.name}${spec.variadic ? '...' : ''}]`;
      const value = await vscode.window.showInputBox({
        title: `${executableName} ${commandDef.command}`.trim(),
        prompt: spec.variadic
          ? `Enter ${spec.required ? 'one or more' : 'zero or more'} values for ${tokenLabel} (space-separated).`
          : `Enter value for ${tokenLabel}${spec.required ? '' : ' (optional)'}.`,
        ignoreFocusOut: true,
        validateInput: (input) => {
          const trimmed = input.trim();
          if (!spec.required) {
            return undefined;
          }
          if (!trimmed) {
            return `Value is required for ${tokenLabel}.`;
          }
          if (spec.variadic && splitArgs(trimmed).length === 0) {
            return `At least one value is required for ${tokenLabel}.`;
          }
          return undefined;
        }
      });

      if (value === undefined) {
        return undefined;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }

      if (spec.variadic) {
        collected.push(...splitArgs(trimmed));
      } else {
        collected.push(trimmed);
      }
    }

    return [...baseArgs, ...collected];
  }

  private enrichModel(
    model: ProcessRunViewModel,
    workspacePath: string,
    integration: IntegrationConfig
  ): ProcessRunViewModel {
    if (!integration.automotive.enableDiagnostics) {
      this.diagnostics.clear();
      return model;
    }

    const diagnostics = parseDiagnostics(model.lines, workspacePath);
    const summary = publishDiagnostics(this.diagnostics, diagnostics);
    const qualityGate = evaluateQualityGate(summary, integration.automotive);

    return {
      ...model,
      diagnosticSummary: summary,
      qualityGate
    };
  }
}

function pathBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? filePath;
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

function formatParsedCommandForDisplay(commandDef: ParsedCliCommand): string {
  if (!commandDef.command) {
    return '';
  }
  const args = commandDef.argsSpec ?? [];
  if (args.length === 0) {
    return commandDef.command;
  }
  const suffix = args
    .map((arg) => arg.required
      ? `<${arg.name}${arg.variadic ? '...' : ''}>`
      : `[${arg.name}${arg.variadic ? '...' : ''}]`)
    .join(' ');
  return `${commandDef.command} ${suffix}`.trim();
}
