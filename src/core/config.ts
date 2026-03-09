import * as vscode from 'vscode';
import { CliRunnerConfig, IntegrationConfig } from './types';

export function readCliConfig(): CliRunnerConfig {
  const config = vscode.workspace.getConfiguration('cliRunner');
  return {
    executableNames: toTrimmedStringArray(config.get<string[]>('executableNames', [])),
    helpArgs: toTrimmedStringArray(config.get<string[]>('helpArgs', ['-h'])),
    searchExcludeGlob: config.get<string>('searchExcludeGlob', '**/{.git,node_modules,dist,build,.dart_tool,.idea}/**') ?? '**/{.git,node_modules,dist,build,.dart_tool,.idea}/**',
    maxExecutables: config.get<number>('maxExecutables', 30) ?? 30,
    helpTimeoutMs: config.get<number>('helpTimeoutMs', 12000) ?? 12000
  };
}

export function readIntegrationConfig(): IntegrationConfig {
  const config = vscode.workspace.getConfiguration('cliRunner');
  return {
    toolExecutables: normalizeStringMap(config.get<unknown>('toolExecutables', {})),
    restBaseUrl: (config.get<string>('restBaseUrl', '') ?? '').trim(),
    restToken: (config.get<string>('restToken', '') ?? '').trim(),
    almRestBaseUrl: (config.get<string>('almRestBaseUrl', '') ?? '').trim(),
    almRestToken: (config.get<string>('almRestToken', '') ?? '').trim(),
    restTimeoutMs: config.get<number>('restTimeoutMs', 15000) ?? 15000,
    restExtraHeaders: normalizeStringMap(config.get<unknown>('restExtraHeaders', {}))
  };
}

export async function setToolExecutable(key: string, executable: string): Promise<void> {
  const current = readIntegrationConfig().toolExecutables;
  const next = {
    ...current,
    [key]: executable
  };
  await vscode.workspace.getConfiguration('cliRunner').update(
    'toolExecutables',
    next,
    vscode.ConfigurationTarget.Workspace
  );
}

function toTrimmedStringArray(input: string[] | undefined): string[] {
  return (input ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeStringMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const out: Record<string, string> = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value.trim();
    }
  });
  return out;
}
