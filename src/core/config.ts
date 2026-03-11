import * as vscode from 'vscode';
import { AutomotiveConfig, AutomotivePipelineStep, CliRunnerConfig, HilSilJob, IntegrationConfig } from './types';

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
    windowsOutputEncoding: readWindowsOutputEncoding(config),
    update: readUpdateConfig(config),
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
    enableDiagnostics: config.get<boolean>('enableDiagnostics', true) ?? true,
    environmentDoctor: readEnvironmentDoctorConfig(config),
    sizeRegression: readSizeRegressionConfig(config),
    flashSmoke: readFlashSmokeConfig(config),
    udsDiagnostics: readUdsDiagnosticsConfig(config),
    dbcSearchRoots: toTrimmedStringArray(config.get<string[]>('dbcSearchRoots', ['dbc', 'network', '.'])),
    hilSilJobs: normalizeHilSilJobs(config.get<unknown>('hilSilJobs', defaultHilSilJobs())),
    traceability: readTraceabilityConfig(config),
    postmortem: readPostmortemConfig(config)
  };
}

function readWindowsOutputEncoding(config: vscode.WorkspaceConfiguration): 'auto' | 'utf8' | 'gb18030' {
  const value = (config.get<string>('windowsOutputEncoding', 'auto') ?? 'auto').trim().toLowerCase();
  if (value === 'utf8' || value === 'gb18030') {
    return value;
  }
  return 'auto';
}

function readUpdateConfig(config: vscode.WorkspaceConfiguration): IntegrationConfig['update'] {
  const intervalHours = config.get<number>('updateCheckIntervalHours', 24) ?? 24;
  return {
    enabled: config.get<boolean>('updateCheckEnabled', true) ?? true,
    intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 24,
    feedUrl: (config.get<string>('updateFeedUrl', 'https://api.github.com/repos/Chandler0514/vscode-cli-runner-20260310-022246/releases/latest') ?? 'https://api.github.com/repos/Chandler0514/vscode-cli-runner-20260310-022246/releases/latest').trim()
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

function normalizeHilSilJobs(input: unknown): HilSilJob[] {
  if (!Array.isArray(input)) {
    return defaultHilSilJobs();
  }

  const jobs: HilSilJob[] = [];
  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const source = item as Record<string, unknown>;
    const name = typeof source.name === 'string' && source.name.trim().length > 0
      ? source.name.trim()
      : `Job ${index + 1}`;
    const kind = source.kind === 'rest' ? 'rest' : 'cli';
    const executableKey = typeof source.executableKey === 'string' ? source.executableKey.trim() : '';
    const method = source.method === 'POST' ? 'POST' : 'GET';
    const endpointTemplate = typeof source.endpointTemplate === 'string' && source.endpointTemplate.trim().length > 0
      ? source.endpointTemplate.trim()
      : '/';
    const restTarget = source.restTarget === 'alm' ? 'alm' : 'resource';
    const argsTemplate = Array.isArray(source.argsTemplate)
      ? source.argsTemplate
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
      : [];

    if (kind === 'cli' && executableKey.length === 0) {
      return;
    }

    jobs.push({
      name,
      kind,
      executableKey,
      argsTemplate,
      method,
      endpointTemplate,
      restTarget,
      continueOnError: source.continueOnError === true,
      requiredEnvVars: Array.isArray(source.requiredEnvVars)
        ? source.requiredEnvVars
          .filter((env): env is string => typeof env === 'string')
          .map((env) => env.trim())
          .filter((env) => env.length > 0)
        : []
    });
  });

  return jobs.length > 0 ? jobs : defaultHilSilJobs();
}

function readEnvironmentDoctorConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig['environmentDoctor'] {
  return {
    requiredEnvVars: toTrimmedStringArray(config.get<string[]>('environmentRequiredEnvVars', [])),
    requiredFiles: toTrimmedStringArray(config.get<string[]>('environmentRequiredFiles', [])),
    requiredExecutables: toTrimmedStringArray(config.get<string[]>('environmentRequiredExecutables', ['cmake', 'cppcheck', 'openocd', 'ctest']))
  };
}

function readSizeRegressionConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig['sizeRegression'] {
  return {
    baselineMapPath: (config.get<string>('sizeBaselineMapPath', '') ?? '').trim(),
    budgetTotalBytes: normalizeNonNegativeNumber(config.get<number>('sizeBudgetTotalBytes', 0), 0),
    budgetTextBytes: normalizeNonNegativeNumber(config.get<number>('sizeBudgetTextBytes', 0), 0),
    budgetDataBytes: normalizeNonNegativeNumber(config.get<number>('sizeBudgetDataBytes', 0), 0),
    budgetBssBytes: normalizeNonNegativeNumber(config.get<number>('sizeBudgetBssBytes', 0), 0)
  };
}

function readFlashSmokeConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig['flashSmoke'] {
  return {
    flashExecutableKey: (config.get<string>('flashToolKey', 'openocd') ?? 'openocd').trim() || 'openocd',
    flashArgsTemplate: toTrimmedStringArray(config.get<string[]>('flashArgsTemplate', [
      '-f',
      'interface/${debugInterface}.cfg',
      '-f',
      'target/${mcu}.cfg',
      '-c',
      'program ${imagePath} verify reset exit'
    ])),
    smokeExecutableKey: (config.get<string>('smokeToolKey', 'ctest') ?? 'ctest').trim() || 'ctest',
    smokeArgsTemplate: toTrimmedStringArray(config.get<string[]>('smokeArgsTemplate', [
      '--test-dir',
      '${workspacePath}/build/${scenarioName}',
      '-L',
      'smoke',
      '--output-on-failure'
    ]))
  };
}

function readUdsDiagnosticsConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig['udsDiagnostics'] {
  const transportRaw = (config.get<string>('udsTransport', 'rest') ?? 'rest').trim().toLowerCase();
  return {
    transport: transportRaw === 'cli' ? 'cli' : 'rest',
    restBaseUrl: (config.get<string>('udsRestBaseUrl', '') ?? '').trim(),
    restToken: (config.get<string>('udsRestToken', '') ?? '').trim(),
    executableKey: (config.get<string>('udsExecutableKey', 'uds-cli') ?? 'uds-cli').trim() || 'uds-cli',
    ecuAddress: (config.get<string>('udsDefaultEcuAddress', '0x7E0') ?? '0x7E0').trim() || '0x7E0',
    readDtcEndpointTemplate: (config.get<string>('udsReadDtcEndpointTemplate', '/uds/${ecuAddress}/dtc') ?? '/uds/${ecuAddress}/dtc').trim() || '/uds/${ecuAddress}/dtc',
    clearDtcEndpointTemplate: (config.get<string>('udsClearDtcEndpointTemplate', '/uds/${ecuAddress}/dtc/clear') ?? '/uds/${ecuAddress}/dtc/clear').trim() || '/uds/${ecuAddress}/dtc/clear',
    readDidEndpointTemplate: (config.get<string>('udsReadDidEndpointTemplate', '/uds/${ecuAddress}/did/${did}') ?? '/uds/${ecuAddress}/did/${did}').trim() || '/uds/${ecuAddress}/did/${did}',
    readDtcArgsTemplate: toTrimmedStringArray(config.get<string[]>('udsReadDtcArgsTemplate', ['read-dtc', '--ecu', '${ecuAddress}'])),
    clearDtcArgsTemplate: toTrimmedStringArray(config.get<string[]>('udsClearDtcArgsTemplate', ['clear-dtc', '--ecu', '${ecuAddress}'])),
    readDidArgsTemplate: toTrimmedStringArray(config.get<string[]>('udsReadDidArgsTemplate', ['read-did', '--ecu', '${ecuAddress}', '--did', '${did}']))
  };
}

function readTraceabilityConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig['traceability'] {
  return {
    requirementPattern: (config.get<string>('requirementIdPattern', '[A-Z]{2,}-\\d+') ?? '[A-Z]{2,}-\\d+').trim() || '[A-Z]{2,}-\\d+',
    lookbackCommits: normalizeRangeNumber(config.get<number>('traceabilityLookbackCommits', 120), 120, 20, 1000)
  };
}

function readPostmortemConfig(config: vscode.WorkspaceConfiguration): AutomotiveConfig['postmortem'] {
  return {
    reportDir: (config.get<string>('postmortemReportDir', '.cli-runner/reports') ?? '.cli-runner/reports').trim() || '.cli-runner/reports',
    logFiles: toTrimmedStringArray(config.get<string[]>('postmortemLogFiles', [])),
    maxLogLines: normalizeRangeNumber(config.get<number>('postmortemMaxLogLines', 200), 200, 20, 2000)
  };
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizeRangeNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
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

function defaultHilSilJobs(): HilSilJob[] {
  return [
    {
      name: 'HIL REST Health',
      kind: 'rest',
      executableKey: '',
      argsTemplate: [],
      method: 'GET',
      endpointTemplate: '/validation/projects/${project}/latest?ecu=${ecu}',
      restTarget: 'resource',
      continueOnError: true,
      requiredEnvVars: []
    },
    {
      name: 'SIL Smoke (CTest)',
      kind: 'cli',
      executableKey: 'ctest',
      argsTemplate: [
        '--test-dir',
        '${workspacePath}/build/${scenarioName}',
        '-L',
        'smoke',
        '--output-on-failure'
      ],
      method: 'GET',
      endpointTemplate: '/',
      restTarget: 'resource',
      continueOnError: false,
      requiredEnvVars: []
    }
  ];
}
