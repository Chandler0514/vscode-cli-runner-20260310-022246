import * as vscode from 'vscode';
import { readCliConfig, readIntegrationConfig } from './config';

const QUICKSTART_SHOWN_KEY = 'cliRunner.quickstart.shown.v1';

interface QuickstartCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly required: boolean;
  readonly hint: string;
}

interface QuickstartModel {
  readonly workspaceName: string;
  readonly checks: QuickstartCheck[];
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
  const scenarioCount = Object.keys(integration.automotive.scenarios).length;
  const variantCount = Object.keys(integration.automotive.variantMatrix).length;

  return {
    workspaceName: workspace?.name ?? '(no workspace)',
    checks: [
      {
        label: 'Workspace opened',
        ok: Boolean(workspace),
        required: true,
        hint: 'Open a project folder first.'
      },
      {
        label: 'CLI executable configured',
        ok: cli.executableNames.length > 0,
        required: true,
        hint: 'Use "Add Executable Name" to seed CLI Commands discovery.'
      },
      {
        label: 'Automotive scenarios configured',
        ok: scenarioCount > 0,
        required: true,
        hint: 'Set cliRunner.scenarios in workspace settings.'
      },
      {
        label: 'Active scenario selected',
        ok: integration.automotive.activeScenario.trim().length > 0,
        required: true,
        hint: 'Run "Set Active Scenario" to select one.'
      },
      {
        label: 'Variant matrix configured',
        ok: variantCount > 0,
        required: false,
        hint: 'Optional but recommended for matrix regression.'
      },
      {
        label: 'REST endpoint configured',
        ok: integration.restBaseUrl.length > 0 || integration.almRestBaseUrl.length > 0,
        required: false,
        hint: 'Set restBaseUrl/almRestBaseUrl if you use REST Services.'
      }
    ]
  };
}

function buildHtml(model: QuickstartModel, firstRun: boolean): string {
  const requiredDone = model.checks.filter((item) => item.required && item.ok).length;
  const requiredTotal = model.checks.filter((item) => item.required).length;
  const heading = firstRun
    ? 'Welcome to CLI Runner'
    : 'CLI Runner Quickstart';
  const intro = firstRun
    ? 'First-time setup: finish required checks, then run the guided flow below.'
    : 'Use this guide anytime to refresh setup, workflow, and design mindset.';

  const checks = model.checks.map((item) => `
      <li class="check-item ${item.ok ? 'ok' : 'todo'}">
        <span class="state">${item.ok ? 'OK' : 'TODO'}</span>
        <span class="label">${escapeHtml(item.label)}</span>
        <span class="meta">${item.required ? 'Required' : 'Optional'} · ${escapeHtml(item.hint)}</span>
      </li>
    `).join('');

  const sections = `
  <div class="grid">
    <section class="card">
      <h2>Step 1 · Configure</h2>
      <p>Complete the required checks and establish project context.</p>
      <div class="actions">
        <a class="btn" href="${commandUri('workbench.action.openWorkspaceSettingsFile')}">Open Workspace Settings</a>
        <a class="btn" href="${commandUri('cliRunner.pickExecutable')}">Add Executable</a>
        <a class="btn" href="${commandUri('cliRunner.setActiveScenario')}">Set Scenario</a>
        <a class="btn ghost" href="${commandUri('cliRunner.openQuickstart')}">Refresh Checks</a>
      </div>
    </section>

    <section class="card">
      <h2>Step 2 · Experience</h2>
      <p>Run one action in each module to feel the execution loop.</p>
      <div class="actions">
        <a class="btn" href="${commandUri('cliRunner.openView')}">Open Sidebar</a>
        <a class="btn" href="${commandUri('cliRunner.runCommand')}">Try CLI Commands</a>
        <a class="btn" href="${commandUri('cliRunner.runToolAction')}">Try Tool Wrappers</a>
        <a class="btn" href="${commandUri('cliRunner.runRestAction')}">Try REST Services</a>
      </div>
    </section>

    <section class="card">
      <h2>Step 3 · Operate Like A Team</h2>
      <p>Run standardized workflows to build engineering rhythm.</p>
      <div class="actions">
        <a class="btn" href="${commandUri('cliRunner.runAutomotivePipeline')}">Run Pipeline</a>
        <a class="btn" href="${commandUri('cliRunner.runVariantMatrix')}">Run Variant Matrix</a>
        <a class="btn" href="${commandUri('cliRunner.runToolAction')}">Analyze Map / Quality</a>
      </div>
    </section>
  </div>`;

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
  .hero {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-editorWidget-border) 10%);
  }
  h1 { margin: 0 0 8px 0; font-size: 20px; }
  h2 { margin: 0 0 8px 0; font-size: 15px; }
  p { margin: 0 0 10px 0; opacity: 0.95; }
  .meta { font-size: 12px; opacity: 0.75; }
  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .check-item {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .check-item:last-child { border-bottom: none; }
  .state {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.4px;
    border-radius: 999px;
    text-align: center;
    padding: 2px 6px;
    height: fit-content;
  }
  .check-item.ok .state { background: #1f7a3d; color: #fff; }
  .check-item.todo .state { background: #8a6a00; color: #fff; }
  .label { font-weight: 600; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-border) 8%);
  }
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
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .btn.ghost {
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border-color: var(--vscode-panel-border);
  }
  .philosophy {
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 10px;
    padding: 12px;
    margin-top: 12px;
  }
  ul {
    margin: 8px 0 0 18px;
    padding: 0;
  }
</style>
</head>
<body>
  <section class="hero">
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(intro)}</p>
    <div class="meta">Workspace: ${escapeHtml(model.workspaceName)} · Required checks: ${requiredDone}/${requiredTotal}</div>
  </section>

  <ul class="list">${checks}</ul>

  ${sections}

  <section class="philosophy">
    <h2>Design Mindset</h2>
    <ul>
      <li>Context first: every action is templated from workspace/scenario/selection.</li>
      <li>Observable by default: output, key lines, diagnostics, and audit trail are visible.</li>
      <li>Composable modules: CLI discovery, tool wrappers, REST services share one runtime model.</li>
      <li>Deterministic workflow: repeatable pipeline and matrix runs over ad-hoc shell habits.</li>
    </ul>
  </section>
</body>
</html>`;
}

function commandUri(command: string): string {
  return `command:${command}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
