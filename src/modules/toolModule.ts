import * as path from 'path';
import * as vscode from 'vscode';
import { appendAuditRecord } from '../core/audit';
import {
  evaluateQualityGate,
  findMissingEnvVars,
  getScenarioValues,
  getVariantValues,
  listScenarioNames,
  listVariantNames,
  mergeValueSources
} from '../core/automotive';
import { readIntegrationConfig, setToolExecutable } from '../core/config';
import { applyTemplate, buildRuntimeContext } from '../core/context';
import { parseDiagnostics, publishDiagnostics } from '../core/diagnostics';
import { runProcessWithProgress, runRestWithProgress } from '../core/exec';
import { analyzeMapFile, formatBytes } from '../core/mapAnalysis';
import { ResultPresenter } from '../core/resultPresenter';
import { ProcessRunViewModel, RestAction, ToolAction, ToolDef, ToolDomain } from '../core/types';
import { InfoNode } from '../core/treeNodes';

type ToolTreeNode = InfoNode | ToolDomainNode | ToolNode | ToolActionNode;

const TOOL_DEFS: ToolDef[] = [
  {
    id: 'scm.svn',
    label: 'SVN',
    domain: 'SCM',
    executableKey: 'svn',
    defaultExecutable: 'svn',
    actions: [
      { id: 'svn.status', label: 'Status (Workspace)', description: 'Check workspace status', kind: 'cli', argsTemplate: ['status', '${workspacePath}'] },
      { id: 'svn.update', label: 'Update (Workspace)', description: 'Update workspace', kind: 'cli', argsTemplate: ['update', '${workspacePath}'] },
      { id: 'svn.log', label: 'Log (Active File)', description: 'Show active file history', kind: 'cli', argsTemplate: ['log', '${activeFilePath}'], requiresActiveFile: true }
    ]
  },
  {
    id: 'scm.integrity',
    label: 'Integrity SCM',
    domain: 'SCM',
    executableKey: 'si',
    defaultExecutable: 'si',
    actions: [
      { id: 'si.viewsandbox', label: 'View Sandbox', description: 'Inspect sandbox', kind: 'cli', argsTemplate: ['viewsandbox'] },
      { id: 'si.viewproject', label: 'View Project', description: 'Inspect project', kind: 'cli', argsTemplate: ['viewproject'] }
    ]
  },
  {
    id: 'scm.clearcase',
    label: 'ClearCase',
    domain: 'SCM',
    executableKey: 'cleartool',
    defaultExecutable: 'cleartool',
    actions: [
      { id: 'cc.lscheckout', label: 'List Checkouts', description: 'List checked-out files', kind: 'cli', argsTemplate: ['lscheckout', '-cview', '-me'] },
      { id: 'cc.history', label: 'History (Active File)', description: 'Show file history', kind: 'cli', argsTemplate: ['lshistory', '${activeFilePath}'], requiresActiveFile: true }
    ]
  },
  {
    id: 'alm.integrity',
    label: 'Integrity ALM',
    domain: 'ALM',
    executableKey: 'im',
    defaultExecutable: 'im',
    actions: [
      { id: 'im.my', label: 'My Open Items', description: 'Query my open items', kind: 'cli', argsTemplate: ['issues', '--queryDefinition=My Open Issues'] },
      {
        id: 'im.item',
        label: 'View Item (By ID)',
        description: 'View one item',
        kind: 'cli',
        argsTemplate: ['viewissue', '--issue=${itemId}'],
        prompt: { variable: 'itemId', title: 'Integrity Item ID', prompt: 'Enter item ID' }
      }
    ]
  },
  {
    id: 'alm.restTool',
    label: 'ALM REST Tool',
    domain: 'ALM',
    actions: [
      { id: 'alm.rest.list', label: 'List Work Items', description: 'Call ALM REST list API', kind: 'rest', method: 'GET', endpointTemplate: '/work-items?project=${workspaceName}', restTarget: 'alm' },
      {
        id: 'alm.rest.item',
        label: 'Get Work Item (By ID)',
        description: 'Call ALM REST detail API',
        kind: 'rest',
        method: 'GET',
        endpointTemplate: '/work-items/${itemId}',
        prompt: { variable: 'itemId', title: 'ALM Item ID', prompt: 'Enter item ID' },
        restTarget: 'alm'
      }
    ]
  },
  {
    id: 'alm.clearquest',
    label: 'ClearQuest',
    domain: 'ALM',
    executableKey: 'cqcmd',
    defaultExecutable: 'cqcmd',
    actions: [
      {
        id: 'cq.query',
        label: 'Run Query (By Name)',
        description: 'Run a named query',
        kind: 'cli',
        argsTemplate: ['query', '-name', '${queryName}'],
        prompt: { variable: 'queryName', title: 'ClearQuest Query Name', prompt: 'Enter query name' }
      }
    ]
  },
  {
    id: 'embedded.cmake',
    label: 'CMake',
    domain: 'Embedded',
    executableKey: 'cmake',
    defaultExecutable: 'cmake',
    actions: [
      {
        id: 'cmake.configure',
        label: 'Configure (Scenario)',
        description: 'Configure build directory using active scenario',
        kind: 'cli',
        argsTemplate: ['-S', '${workspacePath}', '-B', '${workspacePath}/build/${scenarioName}', '-DCMAKE_BUILD_TYPE=${buildType}']
      },
      {
        id: 'cmake.build',
        label: 'Build (Scenario)',
        description: 'Build scenario target',
        kind: 'cli',
        argsTemplate: ['--build', '${workspacePath}/build/${scenarioName}', '--parallel']
      },
      {
        id: 'cmake.test',
        label: 'Run Tests (Scenario)',
        description: 'Build and run test target',
        kind: 'cli',
        argsTemplate: ['--build', '${workspacePath}/build/${scenarioName}', '--target', 'test']
      }
    ]
  },
  {
    id: 'embedded.make',
    label: 'GNU Make',
    domain: 'Embedded',
    executableKey: 'make',
    defaultExecutable: 'make',
    actions: [
      {
        id: 'make.all',
        label: 'Make All',
        description: 'Run make all in workspace',
        kind: 'cli',
        argsTemplate: ['-C', '${workspacePath}', 'all']
      },
      {
        id: 'make.clean',
        label: 'Make Clean',
        description: 'Clean workspace build outputs',
        kind: 'cli',
        argsTemplate: ['-C', '${workspacePath}', 'clean']
      }
    ]
  },
  {
    id: 'embedded.iar',
    label: 'IAR',
    domain: 'Embedded',
    executableKey: 'iarbuild',
    defaultExecutable: 'iarbuild',
    actions: [
      {
        id: 'iar.build',
        label: 'Build Project',
        description: 'Run IAR project build',
        kind: 'cli',
        argsTemplate: ['${projectFile}', '-build', '${buildType}'],
        prompt: { variable: 'projectFile', title: 'IAR Project File', prompt: 'Enter .ewp path' }
      }
    ]
  },
  {
    id: 'embedded.ghs',
    label: 'Green Hills',
    domain: 'Embedded',
    executableKey: 'gbuild',
    defaultExecutable: 'gbuild',
    actions: [
      {
        id: 'ghs.build',
        label: 'Build Project',
        description: 'Run Green Hills project build',
        kind: 'cli',
        argsTemplate: ['${projectFile}'],
        prompt: { variable: 'projectFile', title: 'GHS Project File', prompt: 'Enter .gpj path' }
      }
    ]
  },
  {
    id: 'embedded.tasking',
    label: 'Tasking',
    domain: 'Embedded',
    executableKey: 'ctc',
    defaultExecutable: 'ctc',
    actions: [
      {
        id: 'tasking.version',
        label: 'Show Compiler Version',
        description: 'Verify Tasking compiler is available',
        kind: 'cli',
        argsTemplate: ['-V']
      }
    ]
  },
  {
    id: 'embedded.quality',
    label: 'Code Quality',
    domain: 'Embedded',
    executableKey: 'clang-tidy',
    defaultExecutable: 'clang-tidy',
    actions: [
      {
        id: 'quality.clangTidy',
        label: 'clang-tidy (Active File)',
        description: 'Run clang-tidy on active file',
        kind: 'cli',
        argsTemplate: ['${activeFilePath}', '--'],
        requiresActiveFile: true
      }
    ]
  },
  {
    id: 'embedded.cppcheck',
    label: 'cppcheck',
    domain: 'Embedded',
    executableKey: 'cppcheck',
    defaultExecutable: 'cppcheck',
    actions: [
      {
        id: 'quality.cppcheck',
        label: 'cppcheck (Workspace)',
        description: 'Run cppcheck for workspace',
        kind: 'cli',
        argsTemplate: ['--enable=warning,style,performance,portability', '${workspacePath}']
      }
    ]
  },
  {
    id: 'embedded.pclint',
    label: 'PC-lint',
    domain: 'Embedded',
    executableKey: 'pclint',
    defaultExecutable: 'pclint',
    actions: [
      {
        id: 'quality.pclint',
        label: 'PC-lint (Workspace)',
        description: 'Run PC-lint for workspace',
        kind: 'cli',
        argsTemplate: ['${workspacePath}']
      }
    ]
  },
  {
    id: 'embedded.openocd',
    label: 'OpenOCD',
    domain: 'Embedded',
    executableKey: 'openocd',
    defaultExecutable: 'openocd',
    actions: [
      {
        id: 'flash.openocd',
        label: 'Flash Firmware',
        description: 'Program image using OpenOCD',
        kind: 'cli',
        argsTemplate: ['-f', 'interface/${debugInterface}.cfg', '-f', 'target/${mcu}.cfg', '-c', 'program ${imagePath} verify reset exit'],
        prompt: { variable: 'imagePath', title: 'Firmware Image', prompt: 'Enter image path (elf/hex/bin)' }
      }
    ]
  },
  {
    id: 'embedded.jlink',
    label: 'J-Link',
    domain: 'Embedded',
    executableKey: 'JLinkExe',
    defaultExecutable: 'JLinkExe',
    actions: [
      {
        id: 'flash.jlink',
        label: 'Open J-Link Session',
        description: 'Start J-Link command session',
        kind: 'cli',
        argsTemplate: ['-if', 'SWD', '-speed', '4000', '-device', '${mcu}']
      }
    ]
  },
  {
    id: 'embedded.workflows',
    label: 'Automotive Workflows',
    domain: 'Embedded',
    actions: [
      {
        id: 'automotive.selectScenario',
        label: 'Select Active Scenario',
        description: 'Choose scenario (project/ecu/board/toolchain)',
        kind: 'workflow',
        workflowId: 'automotive.selectScenario'
      },
      {
        id: 'automotive.pipeline',
        label: 'Run One-click Pipeline',
        description: 'Run configured build/analysis/flash pipeline',
        kind: 'workflow',
        workflowId: 'automotive.runPipeline'
      },
      {
        id: 'automotive.variantMatrix',
        label: 'Run Variant Matrix',
        description: 'Run pipeline for all configured variants',
        kind: 'workflow',
        workflowId: 'automotive.runVariantMatrix'
      },
      {
        id: 'automotive.mapAnalysis',
        label: 'Analyze .map Size',
        description: 'Analyze memory usage from linker map file',
        kind: 'workflow',
        workflowId: 'automotive.analyzeMap'
      }
    ]
  }
];

class ToolDomainNode extends vscode.TreeItem {
  public constructor(public readonly domain: ToolDomain) {
    super(domain, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(domain === 'SCM' ? 'source-control' : domain === 'ALM' ? 'organization' : 'chip');
  }
}

class ToolNode extends vscode.TreeItem {
  public constructor(public readonly tool: ToolDef) {
    super(tool.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon('tools');
  }
}

class ToolActionNode extends vscode.TreeItem {
  public constructor(public readonly tool: ToolDef, public readonly action: ToolAction) {
    super(action.label, vscode.TreeItemCollapsibleState.None);
    this.description = action.description;
    this.iconPath = new vscode.ThemeIcon(action.kind === 'rest' ? 'globe' : action.kind === 'workflow' ? 'rocket' : 'play-circle');
    this.command = {
      command: 'cliRunner.runToolAction',
      title: 'Run Tool Action',
      arguments: [this]
    };
  }
}

class ToolProvider implements vscode.TreeDataProvider<ToolTreeNode> {
  private readonly emitter = new vscode.EventEmitter<ToolTreeNode | void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public refresh(): void {
    this.emitter.fire();
  }

  public getAllActionNodes(): ToolActionNode[] {
    return TOOL_DEFS.flatMap((tool) => tool.actions.map((action) => new ToolActionNode(tool, action)));
  }

  public getTreeItem(element: ToolTreeNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ToolTreeNode): Promise<ToolTreeNode[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [new InfoNode('Open a workspace folder to use Tool Wrappers')];
    }
    if (!element) {
      return [new ToolDomainNode('SCM'), new ToolDomainNode('ALM'), new ToolDomainNode('Embedded')];
    }
    if (element instanceof ToolDomainNode) {
      return TOOL_DEFS.filter((tool) => tool.domain === element.domain).map((tool) => new ToolNode(tool));
    }
    if (element instanceof ToolNode) {
      return element.tool.actions.map((action) => new ToolActionNode(element.tool, action));
    }
    return [];
  }
}

interface PipelineStepResult {
  readonly variantName: string;
  readonly stepName: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly qualityGatePassed: boolean;
  readonly qualityGateReason?: string;
}

interface PipelineRunSummary {
  readonly variantName: string;
  readonly passed: boolean;
  readonly steps: PipelineStepResult[];
  readonly totalDurationMs: number;
}

export class ToolModule {
  private readonly provider = new ToolProvider();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('cliRunner.tools');

  public constructor(
    private readonly output: vscode.OutputChannel,
    private readonly presenter: ResultPresenter
  ) {}

  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.diagnostics);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('cliRunner.modules.tools', this.provider)
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.runToolAction', async (node?: ToolActionNode) => {
        const target = node ?? await this.pickAction();
        if (!target) {
          return;
        }
        await this.runAction(target);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.setActiveScenario', async () => {
        await this.selectScenario();
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.runAutomotivePipeline', async () => {
        await this.runPipelineWorkflow();
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('cliRunner.runVariantMatrix', async () => {
        await this.runVariantMatrixWorkflow();
      })
    );
  }

  public refresh(): void {
    this.provider.refresh();
  }

  private async pickAction(): Promise<ToolActionNode | undefined> {
    const nodes = this.provider.getAllActionNodes();
    const picked = await vscode.window.showQuickPick(
      nodes.map((node) => ({
        label: `[${node.tool.domain}] ${node.tool.label}: ${node.action.label}`,
        description: node.action.description,
        node
      })),
      { title: 'Choose tool action', matchOnDescription: true }
    );
    return picked?.node;
  }

  private async runAction(node: ToolActionNode): Promise<void> {
    if (node.action.kind === 'workflow') {
      await this.runWorkflowAction(node.action);
      return;
    }
    if (node.action.kind === 'rest') {
      await this.runRestAction(node);
      return;
    }
    await this.runCliAction(node);
  }

  private async runCliAction(node: ToolActionNode): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      prompt: node.action.prompt,
      requiresActiveFile: node.action.requiresActiveFile,
      requiresSelection: node.action.requiresSelection,
      additionalValues: scenarioValues
    });
    if (!runtime) {
      return;
    }
    if (!runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const preflightVars = [
      ...integration.automotive.preflightRequiredEnvVars,
      ...(node.action.requiredEnvVars ?? [])
    ];
    if (!this.ensurePreflightEnv(preflightVars, `${node.tool.label}: ${node.action.label}`)) {
      return;
    }

    const executable = await this.resolveExecutable(node.tool.executableKey, node.tool.defaultExecutable, node.tool.label);
    if (!executable) {
      return;
    }

    const values = mergeValueSources(runtime.values, scenarioValues);
    const args = (node.action.argsTemplate ?? [])
      .map((arg) => applyTemplate(arg, values))
      .filter((arg) => arg.length > 0);
    const baseModel = await runProcessWithProgress({
      title: `${node.tool.label}: ${node.action.label}`,
      executable,
      args,
      cwd: runtime.workspacePath,
      output: this.output
    });

    const model = this.enrichProcessModel(baseModel, runtime.workspacePath, integration);
    this.presenter.showProcess(model);
    notifyProcess(model.result);

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'process',
      title: `${node.tool.label}: ${node.action.label}`,
      scenarioName: scenarioValues.scenarioName,
      success: !model.result.cancelled && model.result.exitCode === 0,
      durationMs: model.result.durationMs,
      exitCode: model.result.exitCode,
      detail: model.displayCommand
    });
  }

  private async runRestAction(node: ToolActionNode): Promise<void> {
    const action = toRestAction(node.action, node.tool.label);
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      prompt: action.prompt,
      requiresActiveFile: action.requiresActiveFile,
      requiresSelection: action.requiresSelection,
      additionalValues: scenarioValues
    });
    if (!runtime) {
      return;
    }
    if (!runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const preflightVars = [
      ...integration.automotive.preflightRequiredEnvVars,
      ...(action.requiredEnvVars ?? [])
    ];
    if (!this.ensurePreflightEnv(preflightVars, `${node.tool.label}: ${node.action.label}`)) {
      return;
    }

    const target = action.restTarget ?? 'alm';
    const baseUrl = target === 'alm' ? integration.almRestBaseUrl : integration.restBaseUrl;
    const token = target === 'alm' ? integration.almRestToken : integration.restToken;
    if (!baseUrl) {
      vscode.window.showWarningMessage(`Set ${target === 'alm' ? 'cliRunner.almRestBaseUrl' : 'cliRunner.restBaseUrl'} first.`);
      return;
    }

    const values = mergeValueSources(runtime.values, scenarioValues);
    const endpoint = applyTemplate(action.endpointTemplate, values);
    const url = /^https?:\/\//i.test(endpoint) ? endpoint : `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...integration.restExtraHeaders };
    if (token && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }

    const model = await runRestWithProgress({
      title: `${node.tool.label}: ${node.action.label}`,
      method: action.method,
      url,
      headers,
      timeoutMs: integration.restTimeoutMs,
      output: this.output
    });

    this.presenter.showRest(model);
    notifyRest(model.result);

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'rest',
      title: `${node.tool.label}: ${node.action.label}`,
      scenarioName: scenarioValues.scenarioName,
      success: !model.result.cancelled && model.result.ok,
      durationMs: model.result.durationMs,
      status: model.result.status,
      detail: `${action.method} ${url}`
    });
  }

  private async runWorkflowAction(action: ToolAction): Promise<void> {
    switch (action.workflowId) {
      case 'automotive.selectScenario':
        await this.selectScenario();
        return;
      case 'automotive.runPipeline':
        await this.runPipelineWorkflow();
        return;
      case 'automotive.runVariantMatrix':
        await this.runVariantMatrixWorkflow();
        return;
      case 'automotive.analyzeMap':
        await this.runMapAnalysisWorkflow();
        return;
      default:
        vscode.window.showWarningMessage('Workflow action is not implemented.');
    }
  }

  private async selectScenario(): Promise<void> {
    const integration = readIntegrationConfig();
    const names = listScenarioNames(integration.automotive);
    if (names.length === 0) {
      vscode.window.showWarningMessage('No scenarios configured. Set cliRunner.scenarios first.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      names.map((name) => ({
        label: name,
        description: formatScenarioDescription(integration.automotive.scenarios[name] ?? {}),
        value: name
      })),
      {
        title: 'Select active automotive scenario',
        matchOnDescription: true
      }
    );
    if (!picked) {
      return;
    }

    await vscode.workspace.getConfiguration('cliRunner').update(
      'activeScenario',
      picked.value,
      vscode.ConfigurationTarget.Workspace
    );
    this.refresh();
    vscode.window.showInformationMessage(`Active scenario set to "${picked.value}".`);
  }

  private async runPipelineWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const variantName = runtime.values.variantName || scenarioValues.scenarioName || 'default';
    const values = mergeValueSources(runtime.values, scenarioValues, { variantName });
    const summary = await this.executePipeline(runtime.workspacePath, values, variantName, integration);
    this.showPipelineSummary('Automotive Pipeline', [summary]);
    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Automotive Pipeline',
      scenarioName: scenarioValues.scenarioName,
      variantName,
      success: summary.passed,
      durationMs: summary.totalDurationMs,
      detail: summary.steps.map((step) => `${step.stepName}:${step.success ? 'ok' : 'fail'}`).join(', ')
    });

    if (summary.passed) {
      vscode.window.showInformationMessage(`Pipeline passed for variant "${variantName}".`);
    } else {
      vscode.window.showWarningMessage(`Pipeline failed for variant "${variantName}".`);
    }
  }

  private async runVariantMatrixWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const variants = listVariantNames(integration.automotive);
    if (variants.length === 0) {
      vscode.window.showWarningMessage('No variants configured. Set cliRunner.variantMatrix first.');
      return;
    }

    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const summaries: PipelineRunSummary[] = [];
    for (const variantName of variants) {
      const variantValues = getVariantValues(integration.automotive, variantName);
      const values = mergeValueSources(runtime.values, scenarioValues, variantValues, { variantName });
      this.output.appendLine(`[matrix] Running variant ${variantName}`);
      const summary = await this.executePipeline(runtime.workspacePath, values, variantName, integration);
      summaries.push(summary);
    }

    this.showPipelineSummary('Variant Matrix', summaries);
    const passedCount = summaries.filter((item) => item.passed).length;
    const totalDuration = summaries.reduce((sum, item) => sum + item.totalDurationMs, 0);
    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Variant Matrix',
      scenarioName: scenarioValues.scenarioName,
      success: passedCount === summaries.length,
      durationMs: totalDuration,
      detail: `${passedCount}/${summaries.length} variants passed`
    });

    if (passedCount === summaries.length) {
      vscode.window.showInformationMessage(`Variant matrix passed (${passedCount}/${summaries.length}).`);
      return;
    }
    vscode.window.showWarningMessage(`Variant matrix finished with failures (${passedCount}/${summaries.length} passed).`);
  }

  private async runMapAnalysisWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const defaultMapPath = path.join(runtime.workspacePath, 'build', scenarioValues.scenarioName || 'default', 'app.map');
    const picked = await vscode.window.showInputBox({
      title: 'Linker map file',
      prompt: 'Enter .map file path for memory size analysis',
      value: defaultMapPath,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Map file path is required.' : undefined
    });
    if (!picked) {
      return;
    }

    const mapPath = path.isAbsolute(picked) ? picked : path.join(runtime.workspacePath, picked);
    try {
      const result = await analyzeMapFile(mapPath);
      const topSections = result.sections
        .slice(0, 12)
        .map((section) => `${section.name.padEnd(20, ' ')} ${section.bytes.toString().padStart(10, ' ')} B (${formatBytes(section.bytes)})`)
        .join('\n');

      this.presenter.showReport({
        title: 'Binary Size Analysis',
        summary: [
          `Map file: ${result.mapPath}`,
          `Total sections size: ${result.totalBytes} B (${formatBytes(result.totalBytes)})`,
          `.text/.rodata: ${result.textBytes} B (${formatBytes(result.textBytes)})`,
          `.data: ${result.dataBytes} B (${formatBytes(result.dataBytes)})`,
          `.bss: ${result.bssBytes} B (${formatBytes(result.bssBytes)})`
        ],
        sections: [
          {
            title: 'Top Sections',
            body: topSections || 'No parseable section entry found.'
          }
        ]
      });

      await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
        timestamp: new Date().toISOString(),
        kind: 'workflow',
        title: 'Binary Size Analysis',
        scenarioName: scenarioValues.scenarioName,
        success: true,
        detail: mapPath
      });
    } catch (error) {
      vscode.window.showErrorMessage(`Map analysis failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
        timestamp: new Date().toISOString(),
        kind: 'workflow',
        title: 'Binary Size Analysis',
        scenarioName: scenarioValues.scenarioName,
        success: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async executePipeline(
    workspacePath: string,
    values: Record<string, string>,
    variantName: string,
    integration: ReturnType<typeof readIntegrationConfig>
  ): Promise<PipelineRunSummary> {
    const started = Date.now();
    const steps: PipelineStepResult[] = [];
    let passed = true;

    for (const step of integration.automotive.pipelineSteps) {
      const preflightVars = [
        ...integration.automotive.preflightRequiredEnvVars,
        ...step.requiredEnvVars
      ];
      if (!this.ensurePreflightEnv(preflightVars, step.name)) {
        passed = false;
        steps.push({
          variantName,
          stepName: step.name,
          success: false,
          durationMs: 0,
          exitCode: -1,
          qualityGatePassed: false,
          qualityGateReason: 'Preflight failed'
        });
        if (!step.continueOnError) {
          break;
        }
        continue;
      }

      const executable = await this.resolveExecutable(step.executableKey, step.executableKey, step.name);
      if (!executable) {
        passed = false;
        steps.push({
          variantName,
          stepName: step.name,
          success: false,
          durationMs: 0,
          exitCode: -1,
          qualityGatePassed: false,
          qualityGateReason: 'Executable not configured'
        });
        if (!step.continueOnError) {
          break;
        }
        continue;
      }

      const args = step.argsTemplate
        .map((arg) => applyTemplate(arg, values))
        .filter((arg) => arg.length > 0);
      const baseModel = await runProcessWithProgress({
        title: `Pipeline ${variantName}: ${step.name}`,
        executable,
        args,
        cwd: workspacePath,
        output: this.output
      });
      const model = this.enrichProcessModel(baseModel, workspacePath, integration);
      const success = !model.result.cancelled && model.result.exitCode === 0 && (model.qualityGate?.passed ?? true);
      if (!success) {
        passed = false;
      }

      steps.push({
        variantName,
        stepName: step.name,
        success,
        durationMs: model.result.durationMs,
        exitCode: model.result.exitCode,
        qualityGatePassed: model.qualityGate?.passed ?? true,
        qualityGateReason: model.qualityGate?.reason
      });

      await this.safeAudit(workspacePath, integration.automotive.auditLogFile, {
        timestamp: new Date().toISOString(),
        kind: 'process',
        title: `Pipeline ${variantName}: ${step.name}`,
        scenarioName: values.scenarioName,
        variantName,
        success,
        durationMs: model.result.durationMs,
        exitCode: model.result.exitCode,
        detail: model.displayCommand
      });

      if (!success && !step.continueOnError) {
        break;
      }
    }

    return {
      variantName,
      passed,
      steps,
      totalDurationMs: Date.now() - started
    };
  }

  private showPipelineSummary(title: string, summaries: PipelineRunSummary[]): void {
    const summaryLines = [
      `Variants: ${summaries.length}`,
      `Passed: ${summaries.filter((item) => item.passed).length}`,
      `Failed: ${summaries.filter((item) => !item.passed).length}`,
      `Total Duration: ${summaries.reduce((sum, item) => sum + item.totalDurationMs, 0)} ms`
    ];

    const variantSection = summaries.map((summary) => {
      const lines = [
        `Variant: ${summary.variantName}`,
        `Status: ${summary.passed ? 'PASSED' : 'FAILED'}`,
        `Duration: ${summary.totalDurationMs} ms`,
        '',
        ...summary.steps.map((step) => `- ${step.stepName}: ${step.success ? 'OK' : 'FAIL'} (exit ${step.exitCode}, ${step.durationMs} ms${step.qualityGateReason ? `, gate: ${step.qualityGateReason}` : ''})`)
      ];
      return {
        title: summary.variantName,
        body: lines.join('\n')
      };
    });

    this.presenter.showReport({
      title,
      summary: summaryLines,
      sections: variantSection
    });
  }

  private ensurePreflightEnv(requiredEnvVars: string[], actionLabel: string): boolean {
    const missing = findMissingEnvVars(requiredEnvVars);
    if (missing.length === 0) {
      return true;
    }
    vscode.window.showWarningMessage(`Preflight failed for ${actionLabel}. Missing env: ${missing.join(', ')}`);
    this.output.appendLine(`[preflight] Missing env vars for ${actionLabel}: ${missing.join(', ')}`);
    return false;
  }

  private enrichProcessModel(
    model: ProcessRunViewModel,
    workspacePath: string,
    integration: ReturnType<typeof readIntegrationConfig>
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

  private async resolveExecutable(
    executableKey: string | undefined,
    defaultExecutable: string | undefined,
    label: string
  ): Promise<string | undefined> {
    if (!executableKey) {
      return undefined;
    }

    const config = readIntegrationConfig();
    const existing = config.toolExecutables[executableKey];
    if (existing?.trim()) {
      return existing.trim();
    }

    const input = await vscode.window.showInputBox({
      title: `${label} executable`,
      prompt: `Set command for ${label}`,
      value: defaultExecutable ?? executableKey,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Executable is required.' : undefined
    });
    if (!input) {
      return undefined;
    }

    const executable = input.trim();
    await setToolExecutable(executableKey, executable);
    return executable;
  }

  private async safeAudit(
    workspacePath: string,
    auditLogFile: string,
    record: Parameters<typeof appendAuditRecord>[2]
  ): Promise<void> {
    try {
      await appendAuditRecord(workspacePath, auditLogFile, record);
    } catch (error) {
      this.output.appendLine(`[audit] Failed to append record: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function toRestAction(action: ToolAction, group: string): RestAction {
  return {
    id: action.id,
    group,
    label: action.label,
    description: action.description,
    method: action.method ?? 'GET',
    endpointTemplate: action.endpointTemplate ?? '/',
    prompt: action.prompt,
    requiresActiveFile: action.requiresActiveFile,
    requiresSelection: action.requiresSelection,
    restTarget: action.restTarget,
    requiredEnvVars: action.requiredEnvVars
  };
}

function formatScenarioDescription(values: Record<string, string>): string {
  const orderedKeys = ['project', 'ecu', 'board', 'toolchain', 'buildType'];
  const lines: string[] = [];
  orderedKeys.forEach((key) => {
    const value = values[key];
    if (value) {
      lines.push(`${key}=${value}`);
    }
  });
  return lines.join(', ');
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

function notifyRest(result: { ok: boolean; status: number; statusText: string; cancelled: boolean; timedOut: boolean }): void {
  if (result.cancelled) {
    vscode.window.showWarningMessage(result.timedOut ? 'REST request timed out.' : 'REST request cancelled.');
    return;
  }
  if (result.ok) {
    vscode.window.showInformationMessage(`REST request succeeded (${result.status}).`);
    return;
  }
  vscode.window.showWarningMessage(`REST request failed (${result.status} ${result.statusText}).`);
}
