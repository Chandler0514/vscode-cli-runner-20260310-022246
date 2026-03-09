import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CliRunnerConfig, ExecutableEntry, ParsedCliCommand } from './types';
import { executeProcessRaw } from './exec';

export async function discoverExecutables(
  workspace: vscode.WorkspaceFolder,
  config: CliRunnerConfig
): Promise<string[]> {
  const found = new Set<string>();

  for (const executableName of config.executableNames) {
    if (found.size >= config.maxExecutables) {
      break;
    }

    const normalized = executableName.replace(/\\/g, '/').trim();
    if (!normalized) {
      continue;
    }

    if (normalized.includes('/')) {
      const fsPath = vscode.Uri.joinPath(workspace.uri, normalized).fsPath;
      if (await isExecutableFile(fsPath)) {
        found.add(fsPath);
      }
      continue;
    }

    const max = Math.max(1, config.maxExecutables - found.size);
    const pattern = new vscode.RelativePattern(workspace, `**/${normalized}`);
    const matches = await vscode.workspace.findFiles(pattern, config.searchExcludeGlob, max);
    for (const match of matches) {
      if (await isExecutableFile(match.fsPath)) {
        found.add(match.fsPath);
      }
      if (found.size >= config.maxExecutables) {
        break;
      }
    }
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

export async function buildExecutableEntry(
  executablePath: string,
  cwd: string,
  config: CliRunnerConfig
): Promise<ExecutableEntry> {
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), config.helpTimeoutMs);
  try {
    const result = await executeProcessRaw(executablePath, config.helpArgs, cwd, cts.token, () => undefined);
    const helpText = [result.stdout, result.stderr].filter((text) => text.trim().length > 0).join('\n');
    return {
      path: executablePath,
      name: path.basename(executablePath),
      commands: parseHelpCommands(helpText),
      helpError: result.cancelled ? `help timed out after ${config.helpTimeoutMs}ms` : undefined
    };
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

export function parseHelpCommands(helpText: string): ParsedCliCommand[] {
  if (!helpText.trim()) {
    return [];
  }

  const lines = helpText.split(/\r?\n/);
  const seen = new Set<string>();
  const parsed: ParsedCliCommand[] = [];
  const ignore = new Set(['usage', 'options', 'arguments', 'examples', 'commands', 'flags']);

  for (const line of lines) {
    const match =
      /^\s*[*-]?\s*([a-zA-Z][\w:-]*(?:\s+[a-zA-Z][\w:-]*){0,2})\s{2,}(.+)$/.exec(line) ??
      /^\s*[*-]?\s*([a-zA-Z][\w:-]*(?:\s+[a-zA-Z][\w:-]*){0,2})\s+-\s+(.+)$/.exec(line) ??
      /^\s*([a-zA-Z][\w:-]*(?:\s+[a-zA-Z][\w:-]*){0,2})\s*:\s+(.+)$/.exec(line);

    if (!match) {
      continue;
    }

    const command = match[1].trim();
    const key = command.toLowerCase();
    if (ignore.has(key) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    parsed.push({
      command,
      description: match[2].trim()
    });
  }

  return parsed;
}

export function splitArgs(text: string): string[] {
  const source = text.trim();
  if (!source) {
    return [];
  }

  const args: string[] = [];
  const matcher = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    if (typeof match[1] === 'string') {
      args.push(match[1]);
    } else if (typeof match[2] === 'string') {
      args.push(match[2]);
    } else {
      args.push(match[0]);
    }
  }
  return args;
}

export function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ');
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }

    if (process.platform === 'win32') {
      const ext = path.extname(filePath).toLowerCase();
      return ['.exe', '.cmd', '.bat', '.ps1', '.com', '.sh'].includes(ext);
    }

    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
