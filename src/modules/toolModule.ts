import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { appendAuditRecord, AuditRecord } from '../core/audit';
import { readAuditRecords } from '../core/auditReader';
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
import { executeProcessRaw, runProcessWithProgress, runRestWithProgress } from '../core/exec';
import { analyzeMapFile, formatBytes } from '../core/mapAnalysis';
import { ResultPresenter } from '../core/resultPresenter';
import { AutomotivePipelineStep, HilSilJob, ProcessRunViewModel, RestAction, ToolAction, ToolDef, ToolDomain } from '../core/types';
import { InfoNode } from '../core/treeNodes';
import { parseDbcSignals, readLastLines, scanWorkspaceFiles } from '../core/workspaceInsights';

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
    id: 'embedded.clangFormat',
    label: 'clang-format',
    domain: 'Embedded',
    executableKey: 'clang-format',
    defaultExecutable: 'clang-format',
    actions: [
      {
        id: 'quality.clangFormatCheck',
        label: 'Format Check (Active File)',
        description: 'Run clang-format dry-run check on active file',
        kind: 'cli',
        argsTemplate: ['--dry-run', '--Werror', '${activeFilePath}'],
        requiresActiveFile: true
      },
      {
        id: 'quality.clangFormatApply',
        label: 'Format Apply (Active File)',
        description: 'Format active file in-place',
        kind: 'cli',
        argsTemplate: ['-i', '${activeFilePath}'],
        requiresActiveFile: true
      }
    ]
  },
  {
    id: 'embedded.scanBuild',
    label: 'scan-build',
    domain: 'Embedded',
    executableKey: 'scan-build',
    defaultExecutable: 'scan-build',
    actions: [
      {
        id: 'quality.scanBuild',
        label: 'scan-build (Scenario Build)',
        description: 'Run Clang Static Analyzer on current scenario build directory',
        kind: 'cli',
        argsTemplate: ['--status-bugs', 'cmake', '--build', '${workspacePath}/build/${scenarioName}']
      }
    ]
  },
  {
    id: 'embedded.ctest',
    label: 'CTest',
    domain: 'Embedded',
    executableKey: 'ctest',
    defaultExecutable: 'ctest',
    actions: [
      {
        id: 'dynamic.ctestAll',
        label: 'Run Unit Tests (All)',
        description: 'Run all tests from scenario build directory',
        kind: 'cli',
        argsTemplate: ['--test-dir', '${workspacePath}/build/${scenarioName}', '--output-on-failure']
      },
      {
        id: 'dynamic.ctestSmoke',
        label: 'Run Smoke Tests',
        description: 'Run tests labeled smoke in scenario build directory',
        kind: 'cli',
        argsTemplate: ['--test-dir', '${workspacePath}/build/${scenarioName}', '-L', 'smoke', '--output-on-failure']
      }
    ]
  },
  {
    id: 'embedded.gcovr',
    label: 'gcovr',
    domain: 'Embedded',
    executableKey: 'gcovr',
    defaultExecutable: 'gcovr',
    actions: [
      {
        id: 'dynamic.coverageText',
        label: 'Coverage Summary (Text)',
        description: 'Generate coverage summary for scenario build',
        kind: 'cli',
        argsTemplate: ['-r', '${workspacePath}', '${workspacePath}/build/${scenarioName}']
      },
      {
        id: 'dynamic.coverageXml',
        label: 'Coverage Report (XML)',
        description: 'Generate Cobertura XML coverage report',
        kind: 'cli',
        argsTemplate: ['-r', '${workspacePath}', '${workspacePath}/build/${scenarioName}', '--xml-pretty', '-o', '${workspacePath}/build/${scenarioName}/coverage.xml']
      }
    ]
  },
  {
    id: 'embedded.valgrind',
    label: 'Valgrind',
    domain: 'Embedded',
    executableKey: 'valgrind',
    defaultExecutable: 'valgrind',
    actions: [
      {
        id: 'dynamic.valgrindMemcheck',
        label: 'Memcheck (Host Binary)',
        description: 'Run Valgrind memcheck for host-executable tests',
        kind: 'cli',
        argsTemplate: ['--tool=memcheck', '--leak-check=full', '--track-origins=yes', '--error-exitcode=101', '${hostBinary}'],
        prompt: { variable: 'hostBinary', title: 'Host Binary Path', prompt: 'Enter host binary path for memcheck' }
      }
    ]
  },
  {
    id: 'embedded.qemu',
    label: 'QEMU',
    domain: 'Embedded',
    executableKey: 'qemu-system-arm',
    defaultExecutable: 'qemu-system-arm',
    actions: [
      {
        id: 'dynamic.qemuSmoke',
        label: 'QEMU Smoke Run',
        description: 'Boot firmware in QEMU for smoke validation',
        kind: 'cli',
        argsTemplate: ['-M', '${qemuBoard}', '-nographic', '-kernel', '${imagePath}'],
        prompt: { variable: 'imagePath', title: 'Firmware Image', prompt: 'Enter firmware image path for QEMU run' }
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
      },
      {
        id: 'automotive.environmentDoctor',
        label: 'Environment Doctor',
        description: 'Check tooling/env/files readiness before build and flashing',
        kind: 'workflow',
        workflowId: 'automotive.environmentDoctor'
      },
      {
        id: 'automotive.qualityDashboard',
        label: 'Quality Gate Dashboard',
        description: 'Show quality trend from recent audit and gate thresholds',
        kind: 'workflow',
        workflowId: 'automotive.qualityDashboard'
      },
      {
        id: 'automotive.sizeRegression',
        label: 'Compare Size Regression',
        description: 'Compare current map file with baseline and budget limits',
        kind: 'workflow',
        workflowId: 'automotive.sizeRegression'
      },
      {
        id: 'automotive.flashAndSmoke',
        label: 'Flash + Smoke Test',
        description: 'Program firmware then run smoke tests in one flow',
        kind: 'workflow',
        workflowId: 'automotive.flashAndSmoke'
      },
      {
        id: 'automotive.udsDiagnostics',
        label: 'UDS Diagnostics',
        description: 'Run common UDS diagnostics (read/clear DTC, read DID)',
        kind: 'workflow',
        workflowId: 'automotive.udsDiagnostics'
      },
      {
        id: 'automotive.dbcLookup',
        label: 'DBC Signal Lookup',
        description: 'Search DBC signals and inspect scaling and ranges',
        kind: 'workflow',
        workflowId: 'automotive.dbcLookup'
      },
      {
        id: 'automotive.applyPipelineTemplate',
        label: 'Apply Pipeline Template',
        description: 'Apply a preset pipeline template for scenario workflows',
        kind: 'workflow',
        workflowId: 'automotive.applyPipelineTemplate'
      },
      {
        id: 'automotive.runHilSil',
        label: 'Run HIL/SIL Orchestrator',
        description: 'Execute configured HIL/SIL validation jobs with summary',
        kind: 'workflow',
        workflowId: 'automotive.runHilSil'
      },
      {
        id: 'automotive.traceabilityReport',
        label: 'Generate Traceability Report',
        description: 'Build requirement/commit/test traceability summary',
        kind: 'workflow',
        workflowId: 'automotive.traceabilityReport'
      },
      {
        id: 'automotive.postmortemReport',
        label: 'Generate Postmortem Report',
        description: 'Collect diagnostics and logs into incident report',
        kind: 'workflow',
        workflowId: 'automotive.postmortemReport'
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

  public constructor(
    private readonly getToolDefs: () => readonly ToolDef[]
  ) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getAllActionNodes(): ToolActionNode[] {
    return this.getToolDefs().flatMap((tool) => tool.actions.map((action) => new ToolActionNode(tool, action)));
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
      return this.getToolDefs().filter((tool) => tool.domain === element.domain).map((tool) => new ToolNode(tool));
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
  private readonly externalToolDefs: ToolDef[] = [];
  private readonly provider = new ToolProvider(() => this.getToolDefs());
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

  public listActionSummaries(): Array<{
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly kind: ToolAction['kind'];
    readonly domain: ToolDomain;
    readonly toolId: string;
    readonly toolLabel: string;
    readonly source: 'builtin' | 'external';
  }> {
    const builtinToolIds = new Set(TOOL_DEFS.map((item) => item.id));
    return this.getToolDefs().flatMap((tool) => tool.actions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      kind: action.kind,
      domain: tool.domain,
      toolId: tool.id,
      toolLabel: tool.label,
      source: builtinToolIds.has(tool.id) ? 'builtin' as const : 'external' as const
    })));
  }

  public async runActionById(actionId: string): Promise<boolean> {
    const found = this.findActionById(actionId);
    if (!found) {
      return false;
    }
    await this.runAction(new ToolActionNode(found.tool, found.action));
    return true;
  }

  public registerExternalToolDefs(defs: readonly ToolDef[]): vscode.Disposable {
    const addedIds: string[] = [];
    defs.forEach((candidate) => {
      if (this.getToolDefs().some((item) => item.id === candidate.id)) {
        this.output.appendLine(`[interop] Skip external tool def "${candidate.id}" because id already exists.`);
        return;
      }
      this.externalToolDefs.push(cloneToolDef(candidate));
      addedIds.push(candidate.id);
    });
    if (addedIds.length > 0) {
      this.refresh();
    }

    return new vscode.Disposable(() => {
      if (addedIds.length === 0) {
        return;
      }
      const set = new Set(addedIds);
      const remaining = this.externalToolDefs.filter((item) => !set.has(item.id));
      this.externalToolDefs.splice(0, this.externalToolDefs.length, ...remaining);
      this.refresh();
    });
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

  private getToolDefs(): readonly ToolDef[] {
    return [...TOOL_DEFS, ...this.externalToolDefs];
  }

  private findActionById(actionId: string): { readonly tool: ToolDef; readonly action: ToolAction } | undefined {
    for (const tool of this.getToolDefs()) {
      const action = tool.actions.find((candidate) => candidate.id === actionId);
      if (action) {
        return { tool, action };
      }
    }
    return undefined;
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
      case 'automotive.environmentDoctor':
        await this.runEnvironmentDoctorWorkflow();
        return;
      case 'automotive.qualityDashboard':
        await this.runQualityDashboardWorkflow();
        return;
      case 'automotive.sizeRegression':
        await this.runSizeRegressionWorkflow();
        return;
      case 'automotive.flashAndSmoke':
        await this.runFlashAndSmokeWorkflow();
        return;
      case 'automotive.udsDiagnostics':
        await this.runUdsDiagnosticsWorkflow();
        return;
      case 'automotive.dbcLookup':
        await this.runDbcLookupWorkflow();
        return;
      case 'automotive.applyPipelineTemplate':
        await this.runApplyPipelineTemplateWorkflow();
        return;
      case 'automotive.runHilSil':
        await this.runHilSilWorkflow();
        return;
      case 'automotive.traceabilityReport':
        await this.runTraceabilityReportWorkflow();
        return;
      case 'automotive.postmortemReport':
        await this.runPostmortemWorkflow();
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

  private async runEnvironmentDoctorWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const runtime = await buildRuntimeContext();
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const envVars = Array.from(new Set([
      ...integration.automotive.preflightRequiredEnvVars,
      ...integration.automotive.environmentDoctor.requiredEnvVars
    ])).sort((a, b) => a.localeCompare(b));
    const missingEnvVars = findMissingEnvVars(envVars);
    const envLines = envVars.length === 0
      ? ['No environment variable check configured.']
      : envVars.map((name) => `${missingEnvVars.includes(name) ? 'FAIL' : 'OK'} ${name}`);

    const executableKeys = integration.automotive.environmentDoctor.requiredExecutables;
    const executableLines: string[] = [];
    for (const executableKey of executableKeys) {
      const configured = integration.toolExecutables[executableKey] || executableKey;
      const available = await isExecutableReachable(configured, runtime.workspacePath);
      executableLines.push(`${available ? 'OK' : 'FAIL'} ${executableKey} -> ${configured}`);
    }

    const fileChecks = integration.automotive.environmentDoctor.requiredFiles;
    const fileLines: string[] = [];
    for (const candidate of fileChecks) {
      const fullPath = path.isAbsolute(candidate) ? candidate : path.join(runtime.workspacePath, candidate);
      const exists = await pathExists(fullPath);
      fileLines.push(`${exists ? 'OK' : 'FAIL'} ${candidate}`);
    }

    const failedExecutables = executableLines.filter((line) => line.startsWith('FAIL')).length;
    const failedFiles = fileLines.filter((line) => line.startsWith('FAIL')).length;
    const passed = missingEnvVars.length === 0 && failedExecutables === 0 && failedFiles === 0;

    this.presenter.showReport({
      title: 'Environment Doctor',
      summary: [
        `Status: ${passed ? 'PASS' : 'FAIL'}`,
        `Missing env vars: ${missingEnvVars.length}`,
        `Missing executables: ${failedExecutables}`,
        `Missing files: ${failedFiles}`,
        `REST base URL: ${integration.restBaseUrl || '(not set)'}`,
        `ALM base URL: ${integration.almRestBaseUrl || '(not set)'}`
      ],
      sections: [
        { title: 'Environment Variables', body: envLines.join('\n') || '(none)' },
        { title: 'Tool Executables', body: executableLines.join('\n') || '(none)' },
        { title: 'Required Files', body: fileLines.join('\n') || '(none)' }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Environment Doctor',
      scenarioName: integration.automotive.activeScenario,
      success: passed,
      detail: `missingEnv=${missingEnvVars.length}, missingExe=${failedExecutables}, missingFiles=${failedFiles}`
    });
  }

  private async runQualityDashboardWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const runtime = await buildRuntimeContext();
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const records = await readAuditRecords(runtime.workspacePath, integration.automotive.auditLogFile, { limit: 300 });
    const recent = records.slice(-60);
    const successCount = recent.filter((record) => record.success).length;
    const failCount = recent.length - successCount;
    const avgDuration = recent.length > 0
      ? Math.round(recent.reduce((sum, record) => sum + (record.durationMs ?? 0), 0) / recent.length)
      : 0;

    const failedTitles = new Map<string, number>();
    recent
      .filter((record) => !record.success)
      .forEach((record) => {
        failedTitles.set(record.title, (failedTitles.get(record.title) ?? 0) + 1);
      });
    const topFailures = Array.from(failedTitles.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([title, count]) => `${count.toString().padStart(2, ' ')}x ${title}`);

    const processRuns = recent.filter((record) => record.kind === 'process').length;
    const restRuns = recent.filter((record) => record.kind === 'rest').length;
    const workflowRuns = recent.filter((record) => record.kind === 'workflow').length;
    const passRate = recent.length > 0 ? Math.round((successCount / recent.length) * 100) : 0;

    this.presenter.showReport({
      title: 'Quality Gate Dashboard',
      summary: [
        `Recent records: ${recent.length}`,
        `Pass rate: ${passRate}% (${successCount}/${recent.length})`,
        `Average duration: ${avgDuration} ms`,
        `Kinds: process=${processRuns}, rest=${restRuns}, workflow=${workflowRuns}`,
        `Thresholds: errors<=${integration.automotive.qualityGateMaxErrors}, warnings<=${integration.automotive.qualityGateMaxWarnings}`
      ],
      sections: [
        {
          title: 'Failure Hotspots',
          body: topFailures.join('\n') || 'No failures in recent audit records.'
        },
        {
          title: 'Recent Failures',
          body: recent
            .filter((record) => !record.success)
            .slice(-20)
            .map((record) => `${record.timestamp} | ${record.title} | ${record.detail ?? ''}`)
            .join('\n') || 'No recent failures.'
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Quality Gate Dashboard',
      scenarioName: integration.automotive.activeScenario,
      success: failCount === 0,
      detail: `records=${recent.length}, pass=${successCount}, fail=${failCount}`
    });
  }

  private async runSizeRegressionWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const defaultCurrentMap = path.join(runtime.workspacePath, 'build', scenarioValues.scenarioName || 'default', 'app.map');
    const currentInput = await vscode.window.showInputBox({
      title: 'Current map file',
      prompt: 'Enter current .map file path for regression compare',
      value: defaultCurrentMap,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Current map file path is required.' : undefined
    });
    if (!currentInput) {
      return;
    }

    const defaultBaseline = integration.automotive.sizeRegression.baselineMapPath || defaultCurrentMap;
    const baselineInput = await vscode.window.showInputBox({
      title: 'Baseline map file',
      prompt: 'Enter baseline .map file path',
      value: defaultBaseline,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Baseline map file path is required.' : undefined
    });
    if (!baselineInput) {
      return;
    }

    const currentMapPath = path.isAbsolute(currentInput) ? currentInput : path.join(runtime.workspacePath, currentInput);
    const baselineMapPath = path.isAbsolute(baselineInput) ? baselineInput : path.join(runtime.workspacePath, baselineInput);
    const current = await analyzeMapFile(currentMapPath);
    const baseline = await analyzeMapFile(baselineMapPath);

    const totalDelta = current.totalBytes - baseline.totalBytes;
    const textDelta = current.textBytes - baseline.textBytes;
    const dataDelta = current.dataBytes - baseline.dataBytes;
    const bssDelta = current.bssBytes - baseline.bssBytes;

    const totalBudgetResult = evaluateBudget(current.totalBytes, integration.automotive.sizeRegression.budgetTotalBytes, 'total');
    const textBudgetResult = evaluateBudget(current.textBytes, integration.automotive.sizeRegression.budgetTextBytes, 'text');
    const dataBudgetResult = evaluateBudget(current.dataBytes, integration.automotive.sizeRegression.budgetDataBytes, 'data');
    const bssBudgetResult = evaluateBudget(current.bssBytes, integration.automotive.sizeRegression.budgetBssBytes, 'bss');

    const budgetFailures = [totalBudgetResult, textBudgetResult, dataBudgetResult, bssBudgetResult]
      .filter((item) => !item.passed)
      .map((item) => item.reason);
    const passed = budgetFailures.length === 0;

    this.presenter.showReport({
      title: 'Size Regression',
      summary: [
        `Status: ${passed ? 'PASS' : 'FAIL'}`,
        `Current map: ${current.mapPath}`,
        `Baseline map: ${baseline.mapPath}`,
        `Total: ${formatSignedDelta(totalDelta)} (current ${formatBytes(current.totalBytes)})`,
        `Text/Rodata: ${formatSignedDelta(textDelta)} (current ${formatBytes(current.textBytes)})`,
        `Data: ${formatSignedDelta(dataDelta)} (current ${formatBytes(current.dataBytes)})`,
        `BSS: ${formatSignedDelta(bssDelta)} (current ${formatBytes(current.bssBytes)})`
      ],
      sections: [
        {
          title: 'Budget Check',
          body: [
            totalBudgetResult.reason,
            textBudgetResult.reason,
            dataBudgetResult.reason,
            bssBudgetResult.reason
          ].join('\n')
        },
        {
          title: 'Largest Current Sections',
          body: current.sections
            .slice(0, 15)
            .map((section) => `${section.name.padEnd(20, ' ')} ${section.bytes.toString().padStart(10, ' ')} B (${formatBytes(section.bytes)})`)
            .join('\n') || 'No section parsed.'
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Size Regression',
      scenarioName: scenarioValues.scenarioName,
      success: passed,
      detail: `totalDelta=${totalDelta}, textDelta=${textDelta}, dataDelta=${dataDelta}, bssDelta=${bssDelta}`
    });
  }

  private async runFlashAndSmokeWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const imagePathInput = await vscode.window.showInputBox({
      title: 'Firmware image path',
      prompt: 'Enter firmware image path (elf/hex/bin)',
      value: path.join(runtime.workspacePath, 'build', scenarioValues.scenarioName || 'default', 'app.elf'),
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Image path is required.' : undefined
    });
    if (!imagePathInput) {
      return;
    }

    const imagePath = path.isAbsolute(imagePathInput)
      ? imagePathInput
      : path.join(runtime.workspacePath, imagePathInput);
    const values = mergeValueSources(runtime.values, scenarioValues, { imagePath });

    const flashExecutable = await this.resolveExecutable(
      integration.automotive.flashSmoke.flashExecutableKey,
      integration.automotive.flashSmoke.flashExecutableKey,
      'Flash step'
    );
    if (!flashExecutable) {
      return;
    }

    const flashResult = await this.runProcessStep(
      'Flash Firmware',
      flashExecutable,
      integration.automotive.flashSmoke.flashArgsTemplate.map((arg) => applyTemplate(arg, values)),
      runtime.workspacePath,
      integration
    );

    let smokeResult: Awaited<ReturnType<typeof this.runProcessStep>> | undefined;
    if (flashResult.success) {
      const smokeExecutable = await this.resolveExecutable(
        integration.automotive.flashSmoke.smokeExecutableKey,
        integration.automotive.flashSmoke.smokeExecutableKey,
        'Smoke step'
      );
      if (!smokeExecutable) {
        return;
      }
      smokeResult = await this.runProcessStep(
        'Smoke Test',
        smokeExecutable,
        integration.automotive.flashSmoke.smokeArgsTemplate.map((arg) => applyTemplate(arg, values)),
        runtime.workspacePath,
        integration
      );
    }

    const passed = flashResult.success && (smokeResult?.success ?? false);
    const detailLines = [
      `Flash: ${flashResult.success ? 'OK' : 'FAIL'} (exit ${flashResult.exitCode}, ${flashResult.durationMs} ms)`,
      smokeResult
        ? `Smoke: ${smokeResult.success ? 'OK' : 'FAIL'} (exit ${smokeResult.exitCode}, ${smokeResult.durationMs} ms)`
        : 'Smoke: skipped due to flash failure'
    ];

    this.presenter.showReport({
      title: 'Flash + Smoke Test',
      summary: [
        `Status: ${passed ? 'PASS' : 'FAIL'}`,
        `Image: ${imagePath}`,
        `Scenario: ${scenarioValues.scenarioName || '(none)'}`
      ],
      sections: [
        {
          title: 'Step Result',
          body: detailLines.join('\n')
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Flash + Smoke Test',
      scenarioName: scenarioValues.scenarioName,
      success: passed,
      durationMs: flashResult.durationMs + (smokeResult?.durationMs ?? 0),
      detail: detailLines.join('; ')
    });
  }

  private async runUdsDiagnosticsWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const operation = await vscode.window.showQuickPick(
      [
        { label: 'Read DTC', value: 'readDtc' as const },
        { label: 'Clear DTC', value: 'clearDtc' as const },
        { label: 'Read DID', value: 'readDid' as const }
      ],
      { title: 'UDS operation' }
    );
    if (!operation) {
      return;
    }

    const ecuAddress = await vscode.window.showInputBox({
      title: 'ECU address',
      prompt: 'Enter UDS target ECU address',
      value: integration.automotive.udsDiagnostics.ecuAddress || scenarioValues.ecu || '0x7E0',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'ECU address is required.' : undefined
    });
    if (!ecuAddress) {
      return;
    }

    let did = '';
    if (operation.value === 'readDid') {
      const didInput = await vscode.window.showInputBox({
        title: 'DID',
        prompt: 'Enter DID (for example F190)',
        value: 'F190',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length === 0 ? 'DID is required.' : undefined
      });
      if (!didInput) {
        return;
      }
      did = didInput.trim();
    }

    const values = mergeValueSources(runtime.values, scenarioValues, {
      ecuAddress: ecuAddress.trim(),
      did
    });

    if (integration.automotive.udsDiagnostics.transport === 'rest') {
      const baseUrl = integration.automotive.udsDiagnostics.restBaseUrl || integration.restBaseUrl;
      if (!baseUrl) {
        vscode.window.showWarningMessage('Set cliRunner.udsRestBaseUrl (or cliRunner.restBaseUrl) first.');
        return;
      }

      const endpointTemplate = operation.value === 'readDtc'
        ? integration.automotive.udsDiagnostics.readDtcEndpointTemplate
        : operation.value === 'clearDtc'
          ? integration.automotive.udsDiagnostics.clearDtcEndpointTemplate
          : integration.automotive.udsDiagnostics.readDidEndpointTemplate;
      const endpoint = applyTemplate(endpointTemplate, values);
      const url = /^https?:\/\//i.test(endpoint)
        ? endpoint
        : `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
      const method = operation.value === 'clearDtc' ? 'POST' : 'GET';
      const token = integration.automotive.udsDiagnostics.restToken || integration.restToken;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const model = await runRestWithProgress({
        title: `UDS ${operation.label}`,
        method,
        url,
        headers,
        timeoutMs: integration.restTimeoutMs,
        output: this.output
      });
      this.presenter.showRest(model);
      notifyRest(model.result);
      await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
        timestamp: new Date().toISOString(),
        kind: 'workflow',
        title: `UDS ${operation.label}`,
        scenarioName: scenarioValues.scenarioName,
        success: !model.result.cancelled && model.result.ok,
        durationMs: model.result.durationMs,
        detail: `${method} ${url}`
      });
      return;
    }

    const executable = await this.resolveExecutable(
      integration.automotive.udsDiagnostics.executableKey,
      integration.automotive.udsDiagnostics.executableKey,
      'UDS CLI'
    );
    if (!executable) {
      return;
    }
    const argsTemplate = operation.value === 'readDtc'
      ? integration.automotive.udsDiagnostics.readDtcArgsTemplate
      : operation.value === 'clearDtc'
        ? integration.automotive.udsDiagnostics.clearDtcArgsTemplate
        : integration.automotive.udsDiagnostics.readDidArgsTemplate;
    const args = argsTemplate.map((arg) => applyTemplate(arg, values)).filter((arg) => arg.length > 0);
    const result = await this.runProcessStep(`UDS ${operation.label}`, executable, args, runtime.workspacePath, integration);

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: `UDS ${operation.label}`,
      scenarioName: scenarioValues.scenarioName,
      success: result.success,
      durationMs: result.durationMs,
      detail: `${executable} ${args.join(' ')}`
    });
  }

  private async runDbcLookupWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const runtime = await buildRuntimeContext();
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const keyword = await vscode.window.showInputBox({
      title: 'DBC signal keyword',
      prompt: 'Enter signal name keyword (case-insensitive)',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Keyword is required.' : undefined
    });
    if (!keyword) {
      return;
    }

    const roots = integration.automotive.dbcSearchRoots
      .map((item) => path.isAbsolute(item) ? item : path.join(runtime.workspacePath, item))
      .filter((item, index, all) => all.indexOf(item) === index);
    const dbcFiles = await scanWorkspaceFiles(roots, {
      extensions: ['.dbc'],
      maxFiles: 120,
      maxDepth: 8
    });
    if (dbcFiles.length === 0) {
      vscode.window.showWarningMessage('No .dbc files found under configured roots.');
      return;
    }

    const lookup = keyword.trim().toLowerCase();
    const hitLines: string[] = [];
    let matchedCount = 0;
    for (const dbcFile of dbcFiles) {
      let content = '';
      try {
        content = await fs.readFile(dbcFile, 'utf8');
      } catch {
        continue;
      }
      const signals = parseDbcSignals(content);
      const matched = signals.filter((signal) =>
        signal.signalName.toLowerCase().includes(lookup)
        || signal.messageName.toLowerCase().includes(lookup)
      );
      matched.forEach((signal) => {
        if (hitLines.length >= 120) {
          return;
        }
        matchedCount += 1;
        hitLines.push([
          `${path.relative(runtime.workspacePath, dbcFile)} | BO_ ${signal.messageId} ${signal.messageName}`,
          `  SG_ ${signal.signalName} : ${signal.startBit}|${signal.bitLength}`,
          `  scale=(${signal.factor},${signal.offset}) range=[${signal.minValue}|${signal.maxValue}] unit="${signal.unit}" receivers=${signal.receivers}`
        ].join('\n'));
      });
    }

    this.presenter.showReport({
      title: 'DBC Signal Lookup',
      summary: [
        `Keyword: ${keyword}`,
        `Scanned files: ${dbcFiles.length}`,
        `Matches: ${matchedCount}`,
        `Search roots: ${roots.map((root) => path.relative(runtime.workspacePath, root) || '.').join(', ')}`
      ],
      sections: [
        {
          title: 'Matched Signals',
          body: hitLines.join('\n\n') || 'No matching signal found.'
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'DBC Signal Lookup',
      success: matchedCount > 0,
      detail: `keyword=${keyword}, matches=${matchedCount}`
    });
  }

  private async runApplyPipelineTemplateWorkflow(): Promise<void> {
    const runtime = await buildRuntimeContext();
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const template = await vscode.window.showQuickPick(
      [
        {
          label: 'CMake + Static + UnitTest',
          value: 'cmakeDefault' as const,
          description: 'Configure + build + cppcheck + ctest smoke'
        },
        {
          label: 'IAR + Static',
          value: 'iarDefault' as const,
          description: 'IAR build + clang-tidy + cppcheck'
        },
        {
          label: 'GHS + QEMU Smoke',
          value: 'ghsDefault' as const,
          description: 'GHS build + QEMU smoke run + quality check'
        }
      ],
      { title: 'Select pipeline template' }
    );
    if (!template) {
      return;
    }

    const steps = buildPipelineTemplate(template.value);
    await vscode.workspace.getConfiguration('cliRunner').update(
      'pipelineSteps',
      steps,
      vscode.ConfigurationTarget.Workspace
    );

    this.presenter.showReport({
      title: 'Pipeline Template Applied',
      summary: [
        `Template: ${template.label}`,
        `Step count: ${steps.length}`,
        'cliRunner.pipelineSteps has been updated in workspace settings.'
      ],
      sections: [
        {
          title: 'Steps',
          body: steps
            .map((step, index) => `${index + 1}. ${step.name}\n   executableKey=${step.executableKey}\n   args=${step.argsTemplate.join(' ')}`)
            .join('\n')
        }
      ]
    });

    const integration = readIntegrationConfig();
    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Apply Pipeline Template',
      scenarioName: integration.automotive.activeScenario,
      success: true,
      detail: template.label
    });
  }

  private async runHilSilWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const scenarioValues = getScenarioValues(integration.automotive);
    const runtime = await buildRuntimeContext({
      additionalValues: scenarioValues
    });
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const values = mergeValueSources(runtime.values, scenarioValues);
    const lines: string[] = [];
    let passed = true;
    let totalDuration = 0;

    for (const job of integration.automotive.hilSilJobs) {
      if (!this.ensurePreflightEnv([...integration.automotive.preflightRequiredEnvVars, ...job.requiredEnvVars], job.name)) {
        passed = false;
        lines.push(`${job.name}: FAIL (preflight)`);
        if (!job.continueOnError) {
          break;
        }
        continue;
      }

      if (job.kind === 'cli') {
        const executable = await this.resolveExecutable(job.executableKey, job.executableKey, job.name);
        if (!executable) {
          passed = false;
          lines.push(`${job.name}: FAIL (missing executable)`);
          if (!job.continueOnError) {
            break;
          }
          continue;
        }

        const args = job.argsTemplate.map((arg) => applyTemplate(arg, values)).filter((arg) => arg.length > 0);
        const result = await this.runProcessStep(job.name, executable, args, runtime.workspacePath, integration);
        totalDuration += result.durationMs;
        passed = passed && result.success;
        lines.push(`${job.name}: ${result.success ? 'OK' : 'FAIL'} (exit ${result.exitCode}, ${result.durationMs} ms)`);
        if (!result.success && !job.continueOnError) {
          break;
        }
        continue;
      }

      const restResult = await this.runHilSilRestJob(job, values, integration);
      totalDuration += restResult.durationMs;
      passed = passed && restResult.success;
      lines.push(`${job.name}: ${restResult.detail}`);
      if (!restResult.success && !job.continueOnError) {
        break;
      }
    }

    this.presenter.showReport({
      title: 'HIL/SIL Orchestrator',
      summary: [
        `Status: ${passed ? 'PASS' : 'FAIL'}`,
        `Jobs configured: ${integration.automotive.hilSilJobs.length}`,
        `Total duration: ${totalDuration} ms`
      ],
      sections: [
        {
          title: 'Job Result',
          body: lines.join('\n') || '(none)'
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'HIL/SIL Orchestrator',
      scenarioName: scenarioValues.scenarioName,
      success: passed,
      durationMs: totalDuration,
      detail: lines.join('; ')
    });
  }

  private async runTraceabilityReportWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const runtime = await buildRuntimeContext();
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const requirementHint = await vscode.window.showInputBox({
      title: 'Requirement filter (optional)',
      prompt: 'Enter one requirement ID to focus report (leave empty to include all)',
      ignoreFocusOut: true
    });

    const gitLines = await this.runGitLines(
      runtime.workspacePath,
      ['log', '-n', String(integration.automotive.traceability.lookbackCommits), '--pretty=format:%H\t%ad\t%an\t%s', '--date=short']
    );
    const requirementRegex = safeRegex(integration.automotive.traceability.requirementPattern);
    const commitRows = gitLines.map((line) => {
      const parts = line.split('\t');
      return {
        hash: parts[0] ?? '',
        date: parts[1] ?? '',
        author: parts[2] ?? '',
        subject: parts.slice(3).join('\t') || ''
      };
    }).filter((row) => row.hash.length > 0);

    const matchedCommits = commitRows.filter((row) => {
      const requirementMatches = row.subject.match(requirementRegex) ?? [];
      if (requirementHint && requirementHint.trim().length > 0) {
        return requirementMatches.some((id) => id.toLowerCase() === requirementHint.trim().toLowerCase());
      }
      return requirementMatches.length > 0;
    });

    const auditRecords = await readAuditRecords(runtime.workspacePath, integration.automotive.auditLogFile, { limit: 240 });
    const relatedTests = auditRecords
      .filter((record) => /(test|smoke|coverage|pipeline)/i.test(record.title))
      .slice(-30);

    const now = timestampForFileName(new Date());
    const fileName = requirementHint && requirementHint.trim().length > 0
      ? `traceability-${sanitizeFileName(requirementHint)}-${now}.md`
      : `traceability-${now}.md`;
    const reportDir = path.join(runtime.workspacePath, integration.automotive.postmortem.reportDir);
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, fileName);
    const markdown = buildTraceabilityMarkdown({
      workspaceName: runtime.workspaceName,
      requirementHint: requirementHint?.trim() ?? '',
      requirementPattern: integration.automotive.traceability.requirementPattern,
      scannedCommits: commitRows.length,
      matchedCommits,
      relatedTests
    });
    await fs.writeFile(reportPath, markdown, 'utf8');

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);

    this.presenter.showReport({
      title: 'Traceability Report',
      summary: [
        `Report: ${reportPath}`,
        `Scanned commits: ${commitRows.length}`,
        `Matched commits: ${matchedCommits.length}`,
        `Recent test/workflow records: ${relatedTests.length}`
      ],
      sections: [
        {
          title: 'Matched Commits',
          body: matchedCommits
            .slice(0, 40)
            .map((row) => `${row.date} ${row.hash.slice(0, 8)} ${row.subject}`)
            .join('\n') || 'No matched commit.'
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Traceability Report',
      success: matchedCommits.length > 0,
      detail: reportPath
    });
  }

  private async runPostmortemWorkflow(): Promise<void> {
    const integration = readIntegrationConfig();
    const runtime = await buildRuntimeContext();
    if (!runtime || !runtime.workspacePath) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const incident = await vscode.window.showInputBox({
      title: 'Incident title',
      prompt: 'Name this incident report',
      value: 'Build or validation failure',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0 ? 'Incident title is required.' : undefined
    });
    if (!incident) {
      return;
    }

    const auditRecords = await readAuditRecords(runtime.workspacePath, integration.automotive.auditLogFile, { limit: 300 });
    const recentFailures = auditRecords
      .filter((record) => !record.success)
      .slice(-30);
    const gitStatus = await this.runGitLines(runtime.workspacePath, ['status', '--short', '--branch']);
    const logSnippets: Array<{ readonly path: string; readonly lines: string[] }> = [];
    for (const candidate of integration.automotive.postmortem.logFiles) {
      const fullPath = path.isAbsolute(candidate) ? candidate : path.join(runtime.workspacePath, candidate);
      const lines = await readLastLines(fullPath, integration.automotive.postmortem.maxLogLines);
      if (lines.length > 0) {
        logSnippets.push({ path: fullPath, lines });
      }
    }

    const reportDir = path.isAbsolute(integration.automotive.postmortem.reportDir)
      ? integration.automotive.postmortem.reportDir
      : path.join(runtime.workspacePath, integration.automotive.postmortem.reportDir);
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `postmortem-${timestampForFileName(new Date())}.md`);
    const markdown = buildPostmortemMarkdown({
      incidentTitle: incident.trim(),
      workspaceName: runtime.workspaceName,
      gitStatus,
      failures: recentFailures,
      logSnippets
    });
    await fs.writeFile(reportPath, markdown, 'utf8');

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(reportPath));
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);

    this.presenter.showReport({
      title: 'Postmortem Report',
      summary: [
        `Report: ${reportPath}`,
        `Recent failures included: ${recentFailures.length}`,
        `Log snippets included: ${logSnippets.length}`
      ],
      sections: [
        {
          title: 'Latest Failure Timeline',
          body: recentFailures
            .slice(-20)
            .map((record) => `${record.timestamp} | ${record.title} | ${record.detail ?? ''}`)
            .join('\n') || 'No failure record found.'
        }
      ]
    });

    await this.safeAudit(runtime.workspacePath, integration.automotive.auditLogFile, {
      timestamp: new Date().toISOString(),
      kind: 'workflow',
      title: 'Postmortem Report',
      success: true,
      detail: reportPath
    });
  }

  private async runProcessStep(
    title: string,
    executable: string,
    args: string[],
    workspacePath: string,
    integration: ReturnType<typeof readIntegrationConfig>
  ): Promise<{
    readonly success: boolean;
    readonly durationMs: number;
    readonly exitCode: number;
  }> {
    const baseModel = await runProcessWithProgress({
      title,
      executable,
      args,
      cwd: workspacePath,
      output: this.output
    });
    const model = this.enrichProcessModel(baseModel, workspacePath, integration);
    this.presenter.showProcess(model);
    const success = !model.result.cancelled
      && model.result.exitCode === 0
      && (model.qualityGate?.passed ?? true);
    return {
      success,
      durationMs: model.result.durationMs,
      exitCode: model.result.exitCode
    };
  }

  private async runHilSilRestJob(
    job: HilSilJob,
    values: Record<string, string>,
    integration: ReturnType<typeof readIntegrationConfig>
  ): Promise<{
    readonly success: boolean;
    readonly durationMs: number;
    readonly detail: string;
  }> {
    const target = job.restTarget ?? 'resource';
    const baseUrl = target === 'alm' ? integration.almRestBaseUrl : integration.restBaseUrl;
    const token = target === 'alm' ? integration.almRestToken : integration.restToken;
    if (!baseUrl) {
      return {
        success: false,
        durationMs: 0,
        detail: `FAIL (missing ${target === 'alm' ? 'alm' : 'resource'} base URL)`
      };
    }

    const endpoint = applyTemplate(job.endpointTemplate, values);
    const url = /^https?:\/\//i.test(endpoint)
      ? endpoint
      : `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...integration.restExtraHeaders };
    if (token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }

    const model = await runRestWithProgress({
      title: `HIL/SIL: ${job.name}`,
      method: job.method,
      url,
      headers,
      timeoutMs: integration.restTimeoutMs,
      output: this.output
    });
    this.presenter.showRest(model);
    const success = !model.result.cancelled && model.result.ok;
    return {
      success,
      durationMs: model.result.durationMs,
      detail: `${success ? 'OK' : 'FAIL'} (HTTP ${model.result.status}, ${model.result.durationMs} ms)`
    };
  }

  private async runGitLines(workspacePath: string, args: string[]): Promise<string[]> {
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const result = await executeProcessRaw('git', args, workspacePath, cancellation.token, () => {
        // Ignore streaming lines for report generation.
      });
      const stdoutLines = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      return stdoutLines;
    } catch {
      return [];
    } finally {
      cancellation.dispose();
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

function cloneToolDef(input: ToolDef): ToolDef {
  return {
    ...input,
    actions: input.actions.map((action) => ({
      ...action,
      argsTemplate: action.argsTemplate ? [...action.argsTemplate] : undefined,
      requiredEnvVars: action.requiredEnvVars ? [...action.requiredEnvVars] : undefined,
      prompt: action.prompt ? { ...action.prompt } : undefined
    }))
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

function evaluateBudget(value: number, budget: number, label: string): {
  readonly passed: boolean;
  readonly reason: string;
} {
  if (budget <= 0) {
    return {
      passed: true,
      reason: `${label}: SKIP (budget not configured)`
    };
  }
  if (value <= budget) {
    return {
      passed: true,
      reason: `${label}: OK (${value} <= ${budget})`
    };
  }
  return {
    passed: false,
    reason: `${label}: FAIL (${value} > ${budget})`
  };
}

function formatSignedDelta(delta: number): string {
  if (delta === 0) {
    return '0 B';
  }
  const prefix = delta > 0 ? '+' : '-';
  return `${prefix}${formatBytes(Math.abs(delta))} (${prefix}${Math.abs(delta)} B)`;
}

async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function isExecutableReachable(command: string, workspacePath: string): Promise<boolean> {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  if (path.isAbsolute(normalized)) {
    return pathExists(normalized);
  }

  if (normalized.includes('/') || normalized.includes('\\')) {
    return pathExists(path.resolve(workspacePath, normalized));
  }

  const pathEnv = process.env.PATH ?? '';
  const folders = pathEnv.split(path.delimiter).filter((entry) => entry.trim().length > 0);
  const candidates = withExecutableExtensions(normalized);
  for (const folder of folders) {
    for (const candidate of candidates) {
      const fullPath = path.join(folder, candidate);
      if (await pathExists(fullPath)) {
        return true;
      }
    }
  }
  return false;
}

function withExecutableExtensions(command: string): string[] {
  if (process.platform !== 'win32') {
    return [command];
  }
  const ext = path.extname(command);
  if (ext.length > 0) {
    return [command];
  }
  const pathExt = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [command, ...pathExt.map((item) => `${command}${item.toLowerCase()}`)];
}

function buildPipelineTemplate(template: 'cmakeDefault' | 'iarDefault' | 'ghsDefault'): AutomotivePipelineStep[] {
  if (template === 'iarDefault') {
    return [
      {
        name: 'Build (IAR)',
        executableKey: 'iarbuild',
        argsTemplate: ['${projectFile}', '-build', '${buildType}'],
        continueOnError: false,
        requiredEnvVars: []
      },
      {
        name: 'clang-tidy (Active File)',
        executableKey: 'clang-tidy',
        argsTemplate: ['${activeFilePath}', '--'],
        continueOnError: true,
        requiredEnvVars: []
      },
      {
        name: 'cppcheck (Workspace)',
        executableKey: 'cppcheck',
        argsTemplate: ['--enable=warning,style,performance,portability', '${workspacePath}'],
        continueOnError: true,
        requiredEnvVars: []
      }
    ];
  }

  if (template === 'ghsDefault') {
    return [
      {
        name: 'Build (Green Hills)',
        executableKey: 'gbuild',
        argsTemplate: ['${projectFile}'],
        continueOnError: false,
        requiredEnvVars: []
      },
      {
        name: 'QEMU Smoke',
        executableKey: 'qemu-system-arm',
        argsTemplate: ['-M', '${qemuBoard}', '-nographic', '-kernel', '${imagePath}'],
        continueOnError: true,
        requiredEnvVars: []
      },
      {
        name: 'Quality Check (cppcheck)',
        executableKey: 'cppcheck',
        argsTemplate: ['--enable=warning,style,performance,portability', '${workspacePath}'],
        continueOnError: true,
        requiredEnvVars: []
      }
    ];
  }

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
      argsTemplate: ['--build', '${workspacePath}/build/${variantName}', '--parallel'],
      continueOnError: false,
      requiredEnvVars: []
    },
    {
      name: 'Static Analysis (cppcheck)',
      executableKey: 'cppcheck',
      argsTemplate: ['--enable=warning,style,performance,portability', '${workspacePath}'],
      continueOnError: true,
      requiredEnvVars: []
    },
    {
      name: 'Smoke Test (CTest)',
      executableKey: 'ctest',
      argsTemplate: ['--test-dir', '${workspacePath}/build/${variantName}', '-L', 'smoke', '--output-on-failure'],
      continueOnError: true,
      requiredEnvVars: []
    }
  ];
}

function timestampForFileName(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function sanitizeFileName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'report';
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return /[A-Z]{2,}-\d+/g;
  }
}

function buildTraceabilityMarkdown(options: {
  readonly workspaceName: string;
  readonly requirementHint: string;
  readonly requirementPattern: string;
  readonly scannedCommits: number;
  readonly matchedCommits: Array<{ readonly hash: string; readonly date: string; readonly author: string; readonly subject: string }>;
  readonly relatedTests: AuditRecord[];
}): string {
  const lines: string[] = [];
  lines.push('# Traceability Report');
  lines.push('');
  lines.push(`- Workspace: ${options.workspaceName}`);
  lines.push(`- Requirement filter: ${options.requirementHint || '(all matched requirements)'}`);
  lines.push(`- Requirement regex: \`${options.requirementPattern}\``);
  lines.push(`- Scanned commits: ${options.scannedCommits}`);
  lines.push(`- Matched commits: ${options.matchedCommits.length}`);
  lines.push(`- Related test/workflow records: ${options.relatedTests.length}`);
  lines.push('');
  lines.push('## Matched Commits');
  lines.push('');
  if (options.matchedCommits.length === 0) {
    lines.push('_No matched commit._');
  } else {
    options.matchedCommits.forEach((commit) => {
      lines.push(`- ${commit.date} \`${commit.hash.slice(0, 8)}\` ${commit.subject} (${commit.author})`);
    });
  }
  lines.push('');
  lines.push('## Recent Test and Workflow Records');
  lines.push('');
  if (options.relatedTests.length === 0) {
    lines.push('_No related record found in audit log._');
  } else {
    options.relatedTests.forEach((record) => {
      lines.push(`- ${record.timestamp} | ${record.success ? 'PASS' : 'FAIL'} | ${record.title} | ${record.detail ?? ''}`);
    });
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildPostmortemMarkdown(options: {
  readonly incidentTitle: string;
  readonly workspaceName: string;
  readonly gitStatus: string[];
  readonly failures: AuditRecord[];
  readonly logSnippets: Array<{ readonly path: string; readonly lines: string[] }>;
}): string {
  const lines: string[] = [];
  lines.push('# Incident Postmortem');
  lines.push('');
  lines.push(`- Incident: ${options.incidentTitle}`);
  lines.push(`- Workspace: ${options.workspaceName}`);
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Git Status Snapshot');
  lines.push('');
  if (options.gitStatus.length === 0) {
    lines.push('_No git status data._');
  } else {
    lines.push('```text');
    lines.push(...options.gitStatus);
    lines.push('```');
  }
  lines.push('');
  lines.push('## Recent Failure Timeline');
  lines.push('');
  if (options.failures.length === 0) {
    lines.push('_No failure record found in audit log._');
  } else {
    options.failures.forEach((record) => {
      lines.push(`- ${record.timestamp} | ${record.title} | ${record.detail ?? ''}`);
    });
  }
  lines.push('');
  lines.push('## Log Evidence');
  lines.push('');
  if (options.logSnippets.length === 0) {
    lines.push('_No configured log file snippet included._');
  } else {
    options.logSnippets.forEach((snippet) => {
      lines.push(`### ${snippet.path}`);
      lines.push('```text');
      lines.push(...snippet.lines);
      lines.push('```');
      lines.push('');
    });
  }
  lines.push('## Initial Findings');
  lines.push('');
  lines.push('- Summarize the primary symptom and first failure point.');
  lines.push('- Link likely root cause candidates and required reproducer data.');
  lines.push('- Capture next containment and permanent fix actions.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
