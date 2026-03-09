import * as vscode from 'vscode';
import { CapturedLine, ProcessRunViewModel, RestRunViewModel } from './types';

export class ResultPresenter {
  private panel: vscode.WebviewPanel | undefined;

  public showProcess(model: ProcessRunViewModel): void {
    this.ensurePanel();
    if (!this.panel) {
      return;
    }

    this.panel.title = `Result: ${model.title}`;
    this.panel.webview.html = this.buildProcessHtml(model);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  public showRest(model: RestRunViewModel): void {
    this.ensurePanel();
    if (!this.panel) {
      return;
    }

    this.panel.title = `Result: ${model.title}`;
    this.panel.webview.html = this.buildRestHtml(model);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private ensurePanel(): void {
    if (this.panel) {
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'cliRunner.result',
      'CLI Runner Result',
      vscode.ViewColumn.Beside,
      {
        enableFindWidget: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private buildProcessHtml(model: ProcessRunViewModel): string {
    const statusText = model.result.cancelled
      ? 'Cancelled'
      : model.result.exitCode === 0
        ? 'Success'
        : 'Failed';
    const statusClass = model.result.cancelled
      ? 'cancelled'
      : model.result.exitCode === 0
        ? 'success'
        : 'failed';

    const keyLines = model.keyLines.length > 0
      ? model.keyLines.map((line) => `<li class="${lineClass(line.text)}"><span class="stream">${escapeHtml(line.stream)}</span><code>${escapeHtml(line.text)}</code></li>`).join('')
      : '<li class="muted"><code>No obvious key line found. Check full output below.</code></li>';

    const fullOutput = model.lines.map((line) => `[${line.stream}] ${line.text}`).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CLI Runner Result</title>
${sharedStyle()}
</head>
<body>
  <div class="card">
    <div class="title">${escapeHtml(model.title)}</div>
    <div class="status ${statusClass}">${statusText}</div>
    <div class="meta">Exit code: <strong>${model.result.exitCode}</strong></div>
    <div class="meta">Duration: <strong>${model.result.durationMs} ms</strong></div>
    <div class="meta">Captured lines: <strong>${model.totalLines}</strong></div>
    <div class="meta">Command: <code>${escapeHtml(model.displayCommand)}</code></div>
  </div>

  <div class="card">
    <div class="title">Key Information</div>
    <ul>${keyLines}</ul>
  </div>

  <div class="card">
    <div class="title">Full Output</div>
    <details open>
      <summary>Expand or collapse full output</summary>
      <pre>${escapeHtml(fullOutput || '(No output)')}</pre>
    </details>
  </div>
</body>
</html>`;
  }

  private buildRestHtml(model: RestRunViewModel): string {
    const result = model.result;
    const statusText = result.cancelled
      ? (result.timedOut ? 'Timed Out' : 'Cancelled')
      : result.ok
        ? 'Success'
        : 'Failed';
    const statusClass = result.cancelled
      ? 'cancelled'
      : result.ok
        ? 'success'
        : 'failed';

    const requestHeaders = Object.entries(model.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n');
    const responseHeaders = Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>REST Result</title>
${sharedStyle()}
</head>
<body>
  <div class="card">
    <div class="title">${escapeHtml(model.title)}</div>
    <div class="status ${statusClass}">${statusText}</div>
    <div class="meta">HTTP: <strong>${escapeHtml(model.method)} ${result.status} ${escapeHtml(result.statusText)}</strong></div>
    <div class="meta">Duration: <strong>${result.durationMs} ms</strong></div>
    <div class="meta">URL: <code>${escapeHtml(model.url)}</code></div>
  </div>

  <div class="card">
    <div class="title">Request</div>
    <details open>
      <summary>Headers</summary>
      <pre>${escapeHtml(requestHeaders || '(No headers)')}</pre>
    </details>
    <details ${model.requestBody ? 'open' : ''}>
      <summary>Body</summary>
      <pre>${escapeHtml(formatJson(model.requestBody ?? '(No body)'))}</pre>
    </details>
  </div>

  <div class="card">
    <div class="title">Response</div>
    <details>
      <summary>Headers</summary>
      <pre>${escapeHtml(responseHeaders || '(No headers)')}</pre>
    </details>
    <details open>
      <summary>Body</summary>
      <pre>${escapeHtml(formatJson(result.body || '(No response body)'))}</pre>
    </details>
  </div>
</body>
</html>`;
  }
}

function sharedStyle(): string {
  return `<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 16px;
    line-height: 1.45;
  }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 14px;
    margin-bottom: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-border) 8%);
  }
  .title {
    margin: 0 0 8px 0;
    font-size: 15px;
    font-weight: 600;
  }
  .status {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .status.success { color: #0f5132; background: #d1e7dd; }
  .status.failed { color: #842029; background: #f8d7da; }
  .status.cancelled { color: #664d03; background: #fff3cd; }
  .meta { margin: 3px 0; font-size: 13px; }
  .meta code { white-space: pre-wrap; word-break: break-all; }
  ul { margin: 8px 0 0 0; padding-left: 20px; }
  li { margin-bottom: 6px; }
  li.error code { color: #ff8b8b; }
  li.warn code { color: #ffd18b; }
  li.success code { color: #9ad39a; }
  li.muted code { opacity: 0.75; }
  .stream {
    display: inline-block;
    min-width: 54px;
    margin-right: 6px;
    opacity: 0.7;
    font-size: 12px;
  }
  details { margin-top: 8px; }
  pre {
    padding: 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-editor-background) 90%, black 10%);
    border: 1px solid var(--vscode-panel-border);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
  }
</style>`;
}

function lineClass(line: string): string {
  if (/error|failed|exception|fatal/i.test(line)) {
    return 'error';
  }
  if (/warn|warning/i.test(line)) {
    return 'warn';
  }
  if (/success|done|complete|finished/i.test(line)) {
    return 'success';
  }
  return '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
