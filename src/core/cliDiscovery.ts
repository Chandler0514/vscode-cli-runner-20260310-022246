import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { CliArgSpec, CliRunnerConfig, ExecutableEntry, ParsedCliCommand } from './types';
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
  const ignore = new Set(['usage', 'usages', 'option', 'options', 'argument', 'arguments', 'example', 'examples', 'command', 'commands', 'flag', 'flags']);

  for (const line of lines) {
    const split = splitHelpLine(line);
    if (!split) {
      continue;
    }

    const entries = parseSignatureEntries(split.signature, split.description);
    for (const entry of entries) {
      const key = entry.command.trim().toLowerCase();
      if (!key) {
        continue;
      }
      if (ignore.has(key) || seen.has(key)) {
        continue;
      }
      if (ignore.has(key.replace(/:$/, ''))) {
        continue;
      }
      seen.add(key);
      parsed.push(entry);
    }
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

function splitHelpLine(line: string): { readonly signature: string; readonly description: string } | undefined {
  const normalized = line.replace(/\t/g, '    ').trim();
  if (!normalized) {
    return undefined;
  }

  const withoutBullet = normalized.replace(/^[*•]\s+/, '');
  const match =
    /^(.+?)\s{2,}(.+)$/.exec(withoutBullet) ??
    /^(.+?)\s+:\s+(.+)$/.exec(withoutBullet) ??
    /^(.+?)\s+-\s+(.+)$/.exec(withoutBullet);
  if (!match) {
    return undefined;
  }

  const signature = match[1].trim();
  const description = match[2].trim();
  if (!signature || !description) {
    return undefined;
  }

  return { signature, description };
}

function parseSignatureEntries(signature: string, description: string): ParsedCliCommand[] {
  const trimmed = signature.trim();
  if (!trimmed) {
    return [];
  }

  const startsLikeOption = /^(\[)?--?[A-Za-z0-9]/.test(trimmed);
  if (startsLikeOption) {
    const aliases = extractOptionAliases(trimmed);
    if (aliases.length > 0) {
      const argsSpec = parseArgumentSpecs(extractOptionArgsText(trimmed));
      return aliases.map((alias) => ({
        command: alias,
        description,
        argsSpec: argsSpec.length > 0 ? argsSpec : undefined
      }));
    }
  }

  const commandParse = parseCommandSignature(trimmed);
  if (!commandParse.command) {
    return [];
  }

  return [{
    command: commandParse.command,
    description,
    argsSpec: commandParse.argsSpec.length > 0 ? commandParse.argsSpec : undefined
  }];
}

function extractOptionAliases(signature: string): string[] {
  const matches = signature.match(/--?[A-Za-z0-9][\w-]*/g) ?? [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  matches.forEach((item) => {
    const key = item.trim();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    aliases.push(key);
  });
  return aliases;
}

function extractOptionArgsText(signature: string): string {
  return signature
    .replace(/(^|[,|/]\s*|\bor\s+)--?[A-Za-z0-9][\w-]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCommandSignature(signature: string): { readonly command: string; readonly argsSpec: CliArgSpec[] } {
  const tokens = signature.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { command: '', argsSpec: [] };
  }

  let index = 0;
  while (index < tokens.length && !isArgumentLikeToken(tokens[index])) {
    index += 1;
  }

  const command = tokens.slice(0, index).join(' ').trim();
  const argsText = tokens.slice(index).join(' ').trim();
  return {
    command,
    argsSpec: parseArgumentSpecs(argsText)
  };
}

function isArgumentLikeToken(token: string): boolean {
  return /^<[^>]+>$/.test(token)
    || /^\[[^\]]+\]$/.test(token)
    || token === '...'
    || /^\S+\.\.\.$/.test(token);
}

function parseArgumentSpecs(text: string): CliArgSpec[] {
  if (!text) {
    return [];
  }

  const tokens = text.match(/<[^>]+>|\[[^\]]+\]|\.{3}|[^\s]+/g) ?? [];
  const specs: CliArgSpec[] = [];
  tokens.forEach((token) => {
    if (token === '...') {
      const last = specs[specs.length - 1];
      if (last) {
        specs[specs.length - 1] = { ...last, variadic: true };
      }
      return;
    }

    const parsed = parseArgumentToken(token, specs.length);
    if (!parsed) {
      return;
    }

    const last = specs[specs.length - 1];
    if (last && last.name === parsed.name) {
      specs[specs.length - 1] = {
        name: last.name,
        required: last.required || parsed.required,
        variadic: last.variadic || parsed.variadic
      };
      return;
    }

    specs.push(parsed);
  });
  return specs;
}

function parseArgumentToken(token: string, index: number): CliArgSpec | undefined {
  const wrapped = /^<(.+)>$/.exec(token) ?? /^\[(.+)\]$/.exec(token);
  if (!wrapped) {
    return undefined;
  }

  const required = token.startsWith('<');
  let inner = wrapped[1].trim();
  let variadic = false;

  if (inner.includes('...')) {
    variadic = true;
    inner = inner.replace(/\.\.\./g, ' ').trim();
  }

  const parts = inner.split(/\s+/).filter((part) => part.length > 0 && part !== '...');
  if (parts.length === 0) {
    return undefined;
  }

  let name = parts[0];
  if (/^--?[A-Za-z0-9][\w-]*$/.test(name)) {
    return undefined;
  }
  name = name.replace(/[,|/:=].*$/, '');
  name = name.replace(/[^A-Za-z0-9_-]/g, '');
  if (!name) {
    name = `arg${index + 1}`;
  }

  return {
    name,
    required,
    variadic
  };
}
