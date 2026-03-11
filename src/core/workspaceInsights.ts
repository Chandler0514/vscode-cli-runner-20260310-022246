import * as path from 'path';
import { promises as fs } from 'fs';

export interface DbcSignalMatch {
  readonly filePath: string;
  readonly messageName: string;
  readonly messageId: string;
  readonly signalName: string;
  readonly startBit: string;
  readonly bitLength: string;
  readonly factor: string;
  readonly offset: string;
  readonly minValue: string;
  readonly maxValue: string;
  readonly unit: string;
  readonly receivers: string;
}

export async function scanWorkspaceFiles(
  roots: string[],
  options: {
    readonly extensions: string[];
    readonly maxFiles: number;
    readonly maxDepth: number;
  }
): Promise<string[]> {
  const files: string[] = [];
  for (const rootPath of roots) {
    await walk(rootPath, 0);
    if (files.length >= options.maxFiles) {
      break;
    }
  }
  return files;

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > options.maxDepth || files.length >= options.maxFiles) {
      return;
    }

    let entries: Array<{ readonly name: string; readonly isDirectory: boolean; readonly isFile: boolean }> = [];
    try {
      const dirEntries = await fs.readdir(current, { withFileTypes: true });
      entries = dirEntries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }));
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= options.maxFiles) {
        return;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory) {
        if (isIgnoredFolder(entry.name)) {
          continue;
        }
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (options.extensions.includes(ext)) {
        files.push(fullPath);
      }
    }
  }
}

export async function readLastLines(filePath: string, maxLines: number): Promise<string[]> {
  const safeMax = Math.max(1, maxLines);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines.length <= safeMax) {
      return lines;
    }
    return lines.slice(lines.length - safeMax);
  } catch {
    return [];
  }
}

export function parseDbcSignals(content: string): DbcSignalMatch[] {
  const lines = content.split(/\r?\n/);
  let currentMessageName = '';
  let currentMessageId = '';
  const matches: DbcSignalMatch[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const messageMatch = /^BO_\s+(\d+)\s+([^:]+):/.exec(line);
    if (messageMatch) {
      currentMessageId = messageMatch[1].trim();
      currentMessageName = messageMatch[2].trim();
      continue;
    }

    const signalMatch = /^SG_\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\|(\d+)@[01][+-]\s+\(([-0-9.eE]+),([-0-9.eE]+)\)\s+\[([-0-9.eE]+)\|([-0-9.eE]+)\]\s+"([^"]*)"\s*(.*)$/.exec(line);
    if (!signalMatch) {
      continue;
    }

    matches.push({
      filePath: '',
      messageName: currentMessageName || '(unknown)',
      messageId: currentMessageId || '(unknown)',
      signalName: signalMatch[1].trim(),
      startBit: signalMatch[2].trim(),
      bitLength: signalMatch[3].trim(),
      factor: signalMatch[4].trim(),
      offset: signalMatch[5].trim(),
      minValue: signalMatch[6].trim(),
      maxValue: signalMatch[7].trim(),
      unit: signalMatch[8].trim(),
      receivers: signalMatch[9].trim()
    });
  }

  return matches;
}

function isIgnoredFolder(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.git'
    || lower === 'node_modules'
    || lower === 'dist'
    || lower === 'build'
    || lower === 'out'
    || lower === '.idea'
    || lower === '.vscode';
}
