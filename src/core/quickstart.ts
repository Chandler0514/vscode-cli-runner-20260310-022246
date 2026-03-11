import * as vscode from 'vscode';
import { readCliConfig, readIntegrationConfig } from './config';

const QUICKSTART_SHOWN_KEY = 'cliRunner.quickstart.shown.v3';

interface QuickstartAction {
  readonly label: string;
  readonly command: string;
  readonly args?: unknown[];
  readonly primary?: boolean;
}

interface QuickstartCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly hint: string;
  readonly action: QuickstartAction;
}

interface QuickstartTourStep {
  readonly title: string;
  readonly intent: string;
  readonly actions: QuickstartAction[];
}

interface QuickstartModel {
  readonly workspaceName: string;
  readonly checks: QuickstartCheck[];
  readonly tour: QuickstartTourStep[];
  readonly recommendedAction?: QuickstartAction;
}

export class QuickstartGuide {
  private panel: vscode.WebviewPanel | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async maybeShowOnFirstRun(): Promise<void> {
    const alreadyShown = this.context.globalState.get<boolean>(QUICKSTART_SHOWN_KEY, false);
    if (alreadyShown) {
      return;
    }
    await this.context.globalState.update(QUICKSTART_SHOWN_KEY, true);
    await this.open({ firstRun: true });
  }

  public async open(options: { readonly firstRun?: boolean } = {}): Promise<void> {
    const model = buildModel();
    this.ensurePanel();
    if (!this.panel) {
      return;
    }

    this.panel.title = options.firstRun ? 'CLI Runner Quickstart' : 'CLI Runner Guide';
    this.panel.webview.html = buildHtml(model, options.firstRun === true);
    this.panel.reveal(vscode.ViewColumn.Active, true);
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'cliRunner.quickstart',
      'CLI Runner Quickstart',
      vscode.ViewColumn.Active,
      {
        enableCommandUris: true,
        retainContextWhenHidden: true
      }
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }
}

function buildModel(): QuickstartModel {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const cli = readCliConfig();
  const integration = readIntegrationConfig();
  const hasWorkspace = Boolean(workspace);
  const hasCliExecutable = cli.executableNames.length > 0;
  const scenarioCount = Object.keys(integration.automotive.scenarios).length;
  const hasScenario = scenarioCount > 0;
  const hasActiveScenario = integration.automotive.activeScenario.trim().length > 0;
  const hasVariantMatrix = Object.keys(integration.automotive.variantMatrix).length > 0;
  const hasRestEndpoint = integration.restBaseUrl.length > 0 || integration.almRestBaseUrl.length > 0;
  const hasSizeRegressionBaseline = integration.automotive.sizeRegression.baselineMapPath.trim().length > 0
    || integration.automotive.sizeRegression.budgetTotalBytes > 0
    || integration.automotive.sizeRegression.budgetTextBytes > 0
    || integration.automotive.sizeRegression.budgetDataBytes > 0
    || integration.automotive.sizeRegression.budgetBssBytes > 0;
  const hasUdsReady = integration.automotive.udsDiagnostics.transport === 'rest'
    ? (integration.automotive.udsDiagnostics.restBaseUrl.length > 0 || integration.restBaseUrl.length > 0)
    : integration.automotive.udsDiagnostics.executableKey.trim().length > 0;
  const hasDbcSearchRoots = integration.automotive.dbcSearchRoots.length > 0;
  const hasHilSilJobs = integration.automotive.hilSilJobs.length > 0;
  const hasPostmortemDir = integration.automotive.postmortem.reportDir.trim().length > 0;

  const checks: QuickstartCheck[] = [
    {
      label: 'Workspace opened',
      ok: hasWorkspace,
      required: true,
      hint: 'Open a project folder to activate workspace-based context.',
      action: {
        label: 'Open Folder',
        command: 'workbench.action.files.openFolder',
        primary: true
      }
    },
    {
      label: 'CLI executable configured',
      ok: hasCliExecutable,
      required: true,
      hint: 'Seed CLI discovery with at least one executable name/path.',
      action: {
        label: 'Add Executable',
        command: 'cliRunner.pickExecutable',
        primary: true
      }
    },
    {
      label: 'Automotive scenarios configured',
      ok: hasScenario,
      required: true,
      hint: 'Set cliRunner.scenarios so templates can resolve project and ECU variables.',
      action: {
        label: 'Open Settings (cliRunner.scenarios)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.scenarios'],
        primary: true
      }
    },
    {
      label: 'Active scenario selected',
      ok: hasActiveScenario,
      required: true,
      hint: 'Pick one scenario before pipeline and matrix actions.',
      action: {
        label: 'Set Active Scenario',
        command: 'cliRunner.setActiveScenario',
        primary: true
      }
    },
    {
      label: 'Variant matrix configured',
      ok: hasVariantMatrix,
      required: false,
      hint: 'Optional but recommended for cross-variant regression.',
      action: {
        label: 'Open Settings (cliRunner.variantMatrix)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.variantMatrix']
      }
    },
    {
      label: 'REST endpoint configured',
      ok: hasRestEndpoint,
      required: false,
      hint: 'Configure restBaseUrl/almRestBaseUrl for REST Services.',
      action: {
        label: 'Open Settings (cliRunner.restBaseUrl)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.restBaseUrl']
      }
    },
    {
      label: 'Size regression baseline/budget configured',
      ok: hasSizeRegressionBaseline,
      required: false,
      hint: 'Configure map baseline or size budgets before regression checks.',
      action: {
        label: 'Open Settings (size budget)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.sizeBudgetTotalBytes']
      }
    },
    {
      label: 'UDS diagnostics transport ready',
      ok: hasUdsReady,
      required: false,
      hint: 'Set UDS REST endpoint/token or CLI executable key.',
      action: {
        label: 'Open Settings (UDS)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.udsTransport']
      }
    },
    {
      label: 'DBC search roots configured',
      ok: hasDbcSearchRoots,
      required: false,
      hint: 'Set dbcSearchRoots for fast signal lookup.',
      action: {
        label: 'Open Settings (DBC roots)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.dbcSearchRoots']
      }
    },
    {
      label: 'HIL/SIL jobs configured',
      ok: hasHilSilJobs,
      required: false,
      hint: 'Set hilSilJobs for mixed CLI/REST validation orchestration.',
      action: {
        label: 'Open Settings (HIL/SIL jobs)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.hilSilJobs']
      }
    },
    {
      label: 'Postmortem report directory configured',
      ok: hasPostmortemDir,
      required: false,
      hint: 'Set report directory and log snippets for incident analysis.',
      action: {
        label: 'Open Settings (postmortem)',
        command: 'workbench.action.openSettings',
        args: ['cliRunner.postmortemReportDir']
      }
    }
  ];

  const recommendedAction = checks.find((item) => item.required && !item.ok)?.action;

  const tour: QuickstartTourStep[] = [
    {
      title: 'Step 1 - Configure Plugin',
      intent: 'Finish required setup before exploration.',
      actions: [
        { label: 'Open Workspace Settings JSON', command: 'workbench.action.openWorkspaceSettingsFile', primary: true },
        { label: 'Search Settings: cliRunner', command: 'workbench.action.openSettings', args: ['cliRunner'] },
        { label: 'Add Executable', command: 'cliRunner.pickExecutable' },
        { label: 'Set Active Scenario', command: 'cliRunner.setActiveScenario' },
        { label: 'Refresh Checkboard', command: 'cliRunner.openQuickstart' }
      ]
    },
    {
      title: 'Step 2 - Explore The Three Views',
      intent: 'Browse each module and understand responsibility boundaries.',
      actions: [
        { label: 'Open CLI Runner Sidebar', command: 'cliRunner.openView', primary: true },
        { label: 'Focus CLI Commands', command: 'cliRunner.modules.commands.focus' },
        { label: 'Focus Tool Wrappers', command: 'cliRunner.modules.tools.focus' },
        { label: 'Focus REST Services', command: 'cliRunner.modules.rest.focus' }
      ]
    },
    {
      title: 'Step 3 - Run Core Actions',
      intent: 'Execute one action per module and inspect output + result views.',
      actions: [
        { label: 'Run CLI Command', command: 'cliRunner.runCommand', primary: true },
        { label: 'Run Tool Action', command: 'cliRunner.runToolAction' },
        { label: 'Run REST Action', command: 'cliRunner.runRestAction' },
        { label: 'Toggle Output Panel', command: 'workbench.action.output.toggleOutput' }
      ]
    },
    {
      title: 'Step 4 - Run Automotive Workflow Pack',
      intent: 'Execute high-value automotive workflows from Tool Wrappers.',
      actions: [
        { label: 'Run Tool Action (Pick Workflow)', command: 'cliRunner.runToolAction', primary: true },
        { label: 'Run Automotive Pipeline', command: 'cliRunner.runAutomotivePipeline' },
        { label: 'Run Variant Matrix', command: 'cliRunner.runVariantMatrix' },
        { label: 'Open Settings (Environment Doctor)', command: 'workbench.action.openSettings', args: ['cliRunner.environmentRequiredEnvVars'] },
        { label: 'Open Settings (UDS)', command: 'workbench.action.openSettings', args: ['cliRunner.udsTransport'] },
        { label: 'Open Settings (HIL/SIL jobs)', command: 'workbench.action.openSettings', args: ['cliRunner.hilSilJobs'] }
      ]
    },
    {
      title: 'Step 5 - Review Evidence And Reports',
      intent: 'Collect audit traces and generate traceability/postmortem reports.',
      actions: [
        { label: 'Open Audit Log', command: 'cliRunner.openAuditLog' },
        { label: 'Run Tool Action (Traceability/Postmortem)', command: 'cliRunner.runToolAction', primary: true },
        { label: 'Open Settings (Report Dir)', command: 'workbench.action.openSettings', args: ['cliRunner.postmortemReportDir'] },
        { label: 'Check For Updates', command: 'cliRunner.checkForUpdates' },
        { label: 'Open Quickstart Again', command: 'cliRunner.openQuickstart' }
      ]
    },
    {
      title: 'Step 6 - Interop Playground',
      intent: 'Connect CLI Runner with other extensions or expose your own integration layer.',
      actions: [
        { label: 'Open Interop Playground', command: 'cliRunner.openInteropPlayground', primary: true },
        { label: 'List Interop Tool Actions', command: 'cliRunner.interop.listToolActions' },
        { label: 'List Interop REST Actions', command: 'cliRunner.interop.listRestActions' },
        { label: 'Get Interop Capabilities', command: 'cliRunner.interop.getCapabilities' }
      ]
    }
  ];

  return {
    workspaceName: workspace?.name ?? '(no workspace)',
    checks,
    tour,
    recommendedAction
  };
}

function buildHtml(model: QuickstartModel, firstRun: boolean): string {
  const requiredDone = model.checks.filter((item) => item.required && item.ok).length;
  const requiredTotal = model.checks.filter((item) => item.required).length;
  const heading = firstRun ? 'Welcome to CLI Runner' : 'CLI Runner Quickstart';
  const intro = firstRun
    ? 'Start with setup, then follow the guided tour to build an operating mindset.'
    : 'Use this guide to navigate features, configure plugin settings, and train new teammates.';

  const checkRows = model.checks.map((item) => `
    <li class="check-row ${item.ok ? 'ok' : 'todo'}">
      <div>
        <div class="label">${escapeHtml(item.label)}</div>
        <div class="meta">${item.required ? 'Required' : 'Optional'} - ${escapeHtml(item.hint)}</div>
      </div>
      <div class="right">
        <span class="state">${item.ok ? 'OK' : 'TODO'}</span>
        ${actionButton(item.action)}
      </div>
    </li>
  `).join('');

  const tourCards = model.tour.map((step) => `
    <section class="tour-card">
      <h3>${escapeHtml(step.title)}</h3>
      <p>${escapeHtml(step.intent)}</p>
      <div class="actions">${step.actions.map((action) => actionButton(action)).join('')}</div>
    </section>
  `).join('');

  const nextAction = model.recommendedAction
    ? `<div class="next-action">Suggested next move: ${actionButton({ ...model.recommendedAction, primary: true })}</div>`
    : `<div class="next-action success">All required checks passed. Start the guided tour below.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CLI Runner Quickstart</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 18px;
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    line-height: 1.5;
  }
  h1, h2, h3 { margin: 0; }
  p { margin: 6px 0 0 0; }
  .hero {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    padding: 16px;
    background: linear-gradient(140deg, color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-focusBorder) 14%), var(--vscode-editor-background));
  }
  .hero .meta { margin-top: 6px; font-size: 12px; opacity: 0.78; }
  .next-action {
    margin-top: 10px;
    padding: 10px;
    border-radius: 10px;
    border: 1px dashed var(--vscode-panel-border);
    font-size: 12px;
  }
  .next-action.success {
    border-style: solid;
    color: var(--vscode-terminal-ansiGreen);
  }
  .section-title {
    margin-top: 14px;
    margin-bottom: 8px;
    font-size: 14px;
    letter-spacing: 0.3px;
    text-transform: uppercase;
    opacity: 0.8;
  }
  .check-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    overflow: hidden;
  }
  .check-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .check-row:last-child { border-bottom: none; }
  .check-row .label { font-weight: 600; }
  .check-row .meta { font-size: 12px; opacity: 0.75; }
  .right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    min-width: 160px;
  }
  .state {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .check-row.ok .state {
    color: #fff;
    background: #1f7a3d;
  }
  .check-row.todo .state {
    color: #fff;
    background: #8a6a00;
  }
  .tour-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 10px;
  }
  .tour-card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-border) 8%);
  }
  .tour-card h3 { font-size: 15px; }
  .tour-card p { font-size: 13px; opacity: 0.9; margin-bottom: 10px; }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .btn {
    text-decoration: none;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-textLink-foreground);
    background: transparent;
  }
  .btn:hover {
    background: color-mix(in srgb, var(--vscode-button-hoverBackground) 35%, transparent);
  }
  .btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent);
  }
  .btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .mindset {
    margin-top: 12px;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 12px;
    padding: 12px;
  }
  .mindset ul {
    margin: 8px 0 0 18px;
    padding: 0;
  }
  @media (max-width: 760px) {
    .right {
      min-width: 130px;
    }
  }
</style>
</head>
<body>
  <section class="hero">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(intro)}</p>
    <div class="meta">Workspace: ${escapeHtml(model.workspaceName)} - Required checks: ${requiredDone}/${requiredTotal}</div>
    ${nextAction}
  </section>

  <h2 class="section-title">Setup Checkboard</h2>
  <ul class="check-list">${checkRows}</ul>

  <h2 class="section-title">Guided Click Tour</h2>
  <div class="tour-grid">${tourCards}</div>

  <section class="mindset">
    <h3>Design Mindset</h3>
    <ul>
      <li>Context first: command templates resolve from workspace, file, selection, and scenario values.</li>
      <li>Observable by default: every run surfaces output, key lines, diagnostics, and audit records.</li>
      <li>Modular by design: CLI discovery, wrappers, and REST actions share one runtime contract.</li>
      <li>Repeatability over heroics: pipeline and matrix encourage deterministic team execution.</li>
    </ul>
  </section>
</body>
</html>`;
}

function actionButton(action: QuickstartAction): string {
  return `<a class="btn${action.primary ? ' primary' : ''}" href="${commandUri(action.command, action.args)}">${escapeHtml(action.label)}</a>`;
}

function commandUri(command: string, args?: unknown[]): string {
  if (!args || args.length === 0) {
    return `command:${command}`;
  }
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
