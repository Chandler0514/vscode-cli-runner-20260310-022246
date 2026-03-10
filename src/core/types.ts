export type StreamName = 'stdout' | 'stderr';
export type ToolDomain = 'SCM' | 'ALM' | 'Embedded';
export type RestTarget = 'resource' | 'alm';
export type HttpMethod = 'GET' | 'POST';
export type ToolActionKind = 'cli' | 'rest' | 'workflow';
export type WorkflowActionId =
  | 'automotive.selectScenario'
  | 'automotive.runPipeline'
  | 'automotive.runVariantMatrix'
  | 'automotive.analyzeMap';

export interface ParsedCliCommand {
  readonly command: string;
  readonly description: string;
}

export interface ExecutableEntry {
  readonly path: string;
  readonly name: string;
  readonly commands: ParsedCliCommand[];
  readonly helpError?: string;
}

export interface CliRunnerConfig {
  readonly executableNames: string[];
  readonly helpArgs: string[];
  readonly searchExcludeGlob: string;
  readonly maxExecutables: number;
  readonly helpTimeoutMs: number;
}

export interface IntegrationConfig {
  readonly toolExecutables: Record<string, string>;
  readonly restBaseUrl: string;
  readonly restToken: string;
  readonly almRestBaseUrl: string;
  readonly almRestToken: string;
  readonly restTimeoutMs: number;
  readonly restExtraHeaders: Record<string, string>;
  readonly automotive: AutomotiveConfig;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface CapturedLine {
  readonly stream: StreamName;
  readonly text: string;
}

export interface ProcessRunViewModel {
  readonly title: string;
  readonly displayCommand: string;
  readonly result: ProcessResult;
  readonly lines: CapturedLine[];
  readonly keyLines: CapturedLine[];
  readonly totalLines: number;
  readonly diagnosticSummary?: DiagnosticSummary;
  readonly qualityGate?: QualityGateResult;
}

export interface RestResult {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly durationMs: number;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

export interface RestRunViewModel {
  readonly title: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody?: string;
  readonly result: RestResult;
}

export interface ActionPrompt {
  readonly variable: string;
  readonly title: string;
  readonly prompt: string;
}

export interface ToolAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: ToolActionKind;
  readonly argsTemplate?: string[];
  readonly endpointTemplate?: string;
  readonly method?: HttpMethod;
  readonly prompt?: ActionPrompt;
  readonly requiresActiveFile?: boolean;
  readonly requiresSelection?: boolean;
  readonly restTarget?: RestTarget;
  readonly requiredEnvVars?: string[];
  readonly workflowId?: WorkflowActionId;
  readonly mapPathTemplate?: string;
}

export interface ToolDef {
  readonly id: string;
  readonly label: string;
  readonly domain: ToolDomain;
  readonly executableKey?: string;
  readonly defaultExecutable?: string;
  readonly actions: ToolAction[];
}

export interface RestAction {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly method: HttpMethod;
  readonly endpointTemplate: string;
  readonly prompt?: ActionPrompt;
  readonly requiresActiveFile?: boolean;
  readonly requiresSelection?: boolean;
  readonly restTarget?: RestTarget;
  readonly requiredEnvVars?: string[];
}

export interface RuntimeContext {
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly activeFilePath: string;
  readonly activeRelativePath: string;
  readonly activeRelativePathEncoded: string;
  readonly selectionText: string;
  readonly selectionTextEncoded: string;
  readonly userName: string;
  readonly input: string;
  readonly inputEncoded: string;
  readonly values: Record<string, string>;
}

export interface AutomotivePipelineStep {
  readonly name: string;
  readonly executableKey: string;
  readonly argsTemplate: string[];
  readonly continueOnError: boolean;
  readonly requiredEnvVars: string[];
}

export interface AutomotiveConfig {
  readonly activeScenario: string;
  readonly scenarios: Record<string, Record<string, string>>;
  readonly variantMatrix: Record<string, Record<string, string>>;
  readonly pipelineSteps: AutomotivePipelineStep[];
  readonly preflightRequiredEnvVars: string[];
  readonly qualityGateMaxWarnings: number;
  readonly qualityGateMaxErrors: number;
  readonly auditLogFile: string;
  readonly enableDiagnostics: boolean;
}

export interface ParsedDiagnostic {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly source: string;
  readonly message: string;
}

export interface DiagnosticSummary {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly totalCount: number;
}

export interface QualityGateResult {
  readonly passed: boolean;
  readonly maxErrors: number;
  readonly maxWarnings: number;
  readonly summary: DiagnosticSummary;
  readonly reason?: string;
}
