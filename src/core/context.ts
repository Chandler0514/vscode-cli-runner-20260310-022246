import * as vscode from 'vscode';
import * as os from 'os';
import { ActionPrompt, RuntimeContext } from './types';

export async function buildRuntimeContext(options: {
  readonly prompt?: ActionPrompt;
  readonly requiresActiveFile?: boolean;
  readonly requiresSelection?: boolean;
} = {}): Promise<RuntimeContext | undefined> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const editor = vscode.window.activeTextEditor;

  const activeFilePath = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : '';
  const activeRelativePath = activeFilePath ? vscode.workspace.asRelativePath(activeFilePath, false) : '';
  let selectionText = editor ? editor.document.getText(editor.selection).trim() : '';
  if (selectionText.length > 2000) {
    selectionText = selectionText.slice(0, 2000);
  }

  if (options.requiresActiveFile && !activeFilePath) {
    vscode.window.showWarningMessage('This action requires an active editor file.');
    return undefined;
  }

  if (options.requiresSelection && !selectionText) {
    vscode.window.showWarningMessage('This action requires selected text in editor.');
    return undefined;
  }

  let input = '';
  if (options.prompt) {
    const value = await vscode.window.showInputBox({
      title: options.prompt.title,
      prompt: options.prompt.prompt,
      ignoreFocusOut: true,
      validateInput: (v) => v.trim().length === 0 ? 'Value is required.' : undefined
    });
    if (!value) {
      return undefined;
    }
    input = value.trim();
  }

  const userName = safeUserName();
  const values: Record<string, string> = {
    workspacePath: workspace?.uri.fsPath ?? '',
    workspaceName: workspace?.name ?? '',
    activeFilePath,
    activeRelativePath,
    activeRelativePathEncoded: encodeURIComponent(activeRelativePath),
    selectionText,
    selectionTextEncoded: encodeURIComponent(selectionText),
    userName,
    input,
    inputEncoded: encodeURIComponent(input)
  };

  if (options.prompt) {
    values[options.prompt.variable] = input;
    values[`${options.prompt.variable}Encoded`] = encodeURIComponent(input);
  }

  return {
    workspacePath: values.workspacePath,
    workspaceName: values.workspaceName,
    activeFilePath: values.activeFilePath,
    activeRelativePath: values.activeRelativePath,
    activeRelativePathEncoded: values.activeRelativePathEncoded,
    selectionText: values.selectionText,
    selectionTextEncoded: values.selectionTextEncoded,
    userName: values.userName,
    input: values.input,
    inputEncoded: values.inputEncoded,
    values
  };
}

export function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_whole, key: string) => values[key] ?? '').trim();
}

function safeUserName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? 'user';
  }
}
