import * as vscode from 'vscode';
import { AutomotiveConfig, AutomotivePipelineStep, CliRunnerConfig, IntegrationConfig } from './types';

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
  const automotive = readAutomotiveConfig(config);
  return {
    toolExecutables: normalizeStringMap(config.get<unknown>('toolExecutables', {})),
    restBaseUrl: (config.get<string>('restBaseUrl', '') ?? '').trim(),
    restToken: (config.get<string>('restToken', '') ?? '').trim(),
    almRestBaseUrl: (config.get<string>('almRestBaseUrl', '') ?? '').trim(),
    almRestToken: (config.get<string>('almRestToken', '') ?? '').trim(),
    restTimeoutMs: config.get<number>('restTimeoutMs', 15000) ?? 15000,
    restExtraHeaders: normalizeStringMap(config.get<unknown>('restExtraHeaders', {})),
    automotive
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

function readAutomotiveConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig {
  const scenarios = normalizeNestedStringMap(config.get<unknown>('scenarios', {}));
  const activeScenario = (config.get<string>('activeScenario', '') ?? '').trim();

  return {
    activeScenario,
    scenarios,
    variantMatrix: normalizeNestedStringMap(config.get<unknown>('variantMatrix', {})),
    pipelineSteps: normalizePipelineSteps(config.get<unknown>('pipelineSteps', defaultPipelineSteps())),
    preflightRequiredEnvVars: toTrimmedStringArray(config.get<string[]>('preflightRequiredEnvVars', [])),
    qualityGateMaxWarnings: normalizeNonNegativeNumber(config.get<number>('qualityGateMaxWarnings', 0), 0),
    qualityGateMaxErrors: normalizeNonNegativeNumber(config.get<number>('qualityGateMaxErrors', 0), 0),
    auditLogFile: (config.get<string>('auditLogFile', '.cli-runner/audit-log.jsonl') ?? '.cli-runner/audit-log.jsonl').trim() || '.cli-runner/audit-log.jsonl',
    enableDiagnostics: config.get<boolean>('enableDiagnostics', true) ?? true
  };
}

function normalizeNestedStringMap(input: unknown): Record<string, Record<string, string>> {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const out: Record<string, Record<string, string>> = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    const inner = normalizeStringMap(value);
    if (Object.keys(inner).length > 0) {
      out[key] = inner;
    }
  });
  return out;
}

function normalizePipelineSteps(input: unknown): AutomotivePipelineStep[] {
  if (!Array.isArray(input)) {
    return defaultPipelineSteps();
  }

  const steps: AutomotivePipelineStep[] = [];
  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const source = item as Record<string, unknown>;
    const name = typeof source.name === 'string' && source.name.trim().length > 0
      ? source.name.trim()
      : `Step ${index + 1}`;
    const executableKey = typeof source.executableKey === 'string'
      ? source.executableKey.trim()
      : '';
    if (!executableKey) {
      return;
    }

    const argsTemplate = Array.isArray(source.argsTemplate)
      ? source.argsTemplate.filter((arg): arg is string => typeof arg === 'string').map((arg) => arg.trim()).filter((arg) => arg.length > 0)
      : [];

    steps.push({
      name,
      executableKey,
      argsTemplate,
      continueOnError: source.continueOnError === true,
      requiredEnvVars: Array.isArray(source.requiredEnvVars)
        ? source.requiredEnvVars.filter((env): env is string => typeof env === 'string').map((env) => env.trim()).filter((env) => env.length > 0)
        : []
    });
  });

  return steps.length > 0 ? steps : defaultPipelineSteps();
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    return fallback;
  }
  return value;
}

function defaultPipelineSteps(): AutomotivePipelineStep[] {
  return [
    {
      name: 'Configure (CMake)',
      executableKey: 'cmake',
      argsTemplate: [
        '-S',
        '${workspacePath}',
        '-B',
        '${workspacePath}/build/${variantName}',
        '-DCMAKE_BUILD_TYPE=${buildType}'
      ],
      continueOnError: false,
      requiredEnvVars: []
    },
    {
      name: 'Build (CMake)',
      executableKey: 'cmake',
      argsTemplate: [
        '--build',
        '${workspacePath}/build/${variantName}'
      ],
      continueOnError: false,
      requiredEnvVars: []
    },
    {
      name: 'Static Analysis (cppcheck)',
      executableKey: 'cppcheck',
      argsTemplate: [
        '--enable=warning,style,performance,portability',
        '${workspacePath}'
      ],
      continueOnError: true,
      requiredEnvVars: []
    }
  ];
}
