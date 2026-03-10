import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { readIntegrationConfig } from './core/config';
import { ResultPresenter } from './core/resultPresenter';
import { QuickstartGuide } from './core/quickstart';
import { CliModule } from './modules/cliModule';
import { ToolModule } from './modules/toolModule';
import { RestModule } from './modules/restModule';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CLI Runner');
  const presenter = new ResultPresenter();
  const quickstart = new QuickstartGuide(context);

  const cliModule = new CliModule(output, presenter);
  const toolModule = new ToolModule(output, presenter);
  const restModule = new RestModule(output, presenter);

  context.subscriptions.push(output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(terminal) CLI Runner';
  statusBar.tooltip = 'Open CLI Runner';
  statusBar.command = 'cliRunner.openView';
  statusBar.show();
  context.subscriptions.push(statusBar);

  cliModule.register(context);
  toolModule.register(context);
  restModule.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('cliRunner.openView', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.cliRunnerWorkbench');
      } catch {
        await vscode.commands.executeCommand('workbench.view.explorer');
      }
      await vscode.commands.executeCommand('cliRunner.modules.commands.focus');
      await refreshAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cliRunner.refresh', async () => {
      await refreshAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cliRunner.openQuickstart', async () => {
      await quickstart.open();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cliRunner.openAuditLog', async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0];
      if (!workspace) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }

      const integration = readIntegrationConfig();
      const configuredPath = integration.automotive.auditLogFile;
      const filePath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(workspace.uri.fsPath, configuredPath);

      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, '', 'utf8');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to prepare audit log file: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('cliRunner')) {
        await refreshAll();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await refreshAll();
    })
  );

  void refreshAll();
  void quickstart.maybeShowOnFirstRun();

  async function refreshAll(): Promise<void> {
    await cliModule.refresh();
    toolModule.refresh();
    restModule.refresh();
  }
}

export function deactivate(): void {}
