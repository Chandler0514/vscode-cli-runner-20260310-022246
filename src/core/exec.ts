import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as iconv from 'iconv-lite';
import { readIntegrationConfig } from './config';
import { CapturedLine, HttpMethod, ProcessResult, ProcessRunViewModel, RestResult, RestRunViewModel, StreamName } from './types';
import { formatCommand } from './cliDiscovery';

export async function runProcessWithProgress(options: {
  readonly title: string;
  readonly executable: string;
  readonly args: string[];
  readonly cwd: string;
  readonly output: vscode.OutputChannel;
}): Promise<ProcessRunViewModel> {
  const displayCommand = formatCommand(options.executable, options.args);
  const lines: CapturedLine[] = [];
  const keyLines: CapturedLine[] = [];
  let totalLines = 0;
  let lastPercent = 0;

  options.output.clear();
  options.output.show(true);
  options.output.appendLine(`[${new Date().toLocaleString()}] Running ${displayCommand}`);

  const result = await vscode.window.withProgress<ProcessResult>(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: true
    },
    async (progress, token) => executeProcessRaw(options.executable, options.args, options.cwd, token, (line, stream) => {
      totalLines += 1;
      options.output.appendLine(`[${stream}] ${line}`);

      if (lines.length < 5000) {
        lines.push({ stream, text: line });
      }

      if (isKeyLine(line) && keyLines.length < 80) {
        keyLines.push({ stream, text: line });
      }

      const percent = extractPercent(line);
      if (typeof percent === 'number' && percent >= lastPercent && percent <= 100) {
        progress.report({ increment: percent - lastPercent, message: `${percent}%` });
        lastPercent = percent;
      } else if (totalLines % 12 === 0) {
        progress.report({ message: shorten(line, 90) });
      }
    })
  );

  options.output.appendLine(`\nProcess finished with code ${result.exitCode} in ${result.durationMs}ms`);

  return {
    title: options.title,
    displayCommand,
    result,
    lines,
    keyLines: keyLines.length > 0 ? keyLines : lines.slice(0, Math.min(20, lines.length)),
    totalLines
  };
}

export async function runRestWithProgress(options: {
  readonly title: string;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly output: vscode.OutputChannel;
}): Promise<RestRunViewModel> {
  options.output.clear();
  options.output.show(true);
  options.output.appendLine(`[${new Date().toLocaleString()}] ${options.method} ${options.url}`);

  Object.entries(options.headers).forEach(([key, value]) => {
    options.output.appendLine(`[header] ${key}: ${value}`);
  });
  if (options.body) {
    options.output.appendLine('[request-body]');
    options.output.appendLine(options.body);
  }

  const result = await vscode.window.withProgress<RestResult>(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: true
    },
    async (_progress, token) => executeRestRaw(options.method, options.url, options.headers, options.body, options.timeoutMs, token)
  );

  options.output.appendLine(`\nREST finished: ${result.status} ${result.statusText} (${result.durationMs}ms)`);
  if (result.body.trim().length > 0) {
    options.output.appendLine('[response-body]');
    options.output.appendLine(shorten(result.body, 7000));
  }

  return {
    title: options.title,
    method: options.method,
    url: options.url,
    requestHeaders: options.headers,
    requestBody: options.body,
    result
  };
}

export async function executeProcessRaw(
  executable: string,
  args: string[],
  cwd: string,
  token: vscode.CancellationToken,
  onLine: (line: string, stream: StreamName) => void
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const started = Date.now();
    const invocation = resolveInvocation(executable, args);
    const outputEncoding = resolveWindowsOutputEncoding();
    const stdoutDecoder = createOutputDecoder(outputEncoding);
    const stderrDecoder = createOutputDecoder(outputEncoding);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true
    });

    let cancelled = false;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let outRemainder = '';
    let errRemainder = '';

    const cancelSub = token.onCancellationRequested(() => {
      cancelled = true;
      child.kill();
    });

    const emit = (text: string, stream: StreamName, remainder: string): string => {
      const merged = remainder + text;
      const parts = merged.split(/\r?\n|\r/g);
      const next = parts.pop() ?? '';
      parts.forEach((part) => onLine(part, stream));
      return next;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      stdout += text;
      outRemainder = emit(text, 'stdout', outRemainder);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      stderr += text;
      errRemainder = emit(text, 'stderr', errRemainder);
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cancelSub.dispose();
      reject(error);
    });

    child.on('close', (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      cancelSub.dispose();
      const outTail = stdoutDecoder.end();
      if (outTail) {
        stdout += outTail;
        outRemainder = emit(outTail, 'stdout', outRemainder);
      }
      const errTail = stderrDecoder.end();
      if (errTail) {
        stderr += errTail;
        errRemainder = emit(errTail, 'stderr', errRemainder);
      }
      if (outRemainder) {
        onLine(outRemainder, 'stdout');
      }
      if (errRemainder) {
        onLine(errRemainder, 'stderr');
      }
      resolve({
        exitCode: typeof exitCode === 'number' ? exitCode : -1,
        stdout,
        stderr,
        cancelled,
        durationMs: Date.now() - started
      });
    });
  });
}

function resolveInvocation(executable: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: executable, args };
  }
  const ext = path.extname(executable).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const cmdLine = [executable, ...args].map(quoteForCmd).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', cmdLine]
    };
  }
  if (ext === '.ps1') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args]
    };
  }
  return { command: executable, args };
}

function quoteForCmd(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s"&|<>^()%!]/.test(value)) {
    return value;
  }
  const escaped = value.replace(/(["^])/g, '^$1');
  return `"${escaped}"`;
}

function resolveWindowsOutputEncoding(): 'utf8' | 'gb18030' {
  if (process.platform !== 'win32') {
    return 'utf8';
  }

  const configured = readIntegrationConfig().windowsOutputEncoding;
  if (configured === 'utf8' || configured === 'gb18030') {
    return configured;
  }

  const language = (vscode.env.language || '').toLowerCase();
  if (language.startsWith('zh')) {
    return 'gb18030';
  }
  return 'utf8';
}

function createOutputDecoder(encoding: 'utf8' | 'gb18030'): {
  readonly write: (chunk: Buffer) => string;
  readonly end: () => string;
} {
  if (encoding === 'utf8') {
    const decoder = new StringDecoder('utf8');
    return {
      write: (chunk) => decoder.write(chunk),
      end: () => decoder.end()
    };
  }

  const decoder = iconv.getDecoder('gb18030');
  return {
    write: (chunk) => decoder.write(chunk),
    end: () => decoder.end() ?? ''
  };
}

export async function executeRestRaw(
  method: HttpMethod,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  token: vscode.CancellationToken
): Promise<RestResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let cancelledByUser = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const sub = token.onCancellationRequested(() => {
    cancelledByUser = true;
    controller.abort();
  });

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
      headers: responseHeaders,
      durationMs: Date.now() - started,
      cancelled: false,
      timedOut: false
    };
  } catch {
    return {
      ok: false,
      status: 0,
      statusText: timedOut ? 'Timed out' : 'Cancelled',
      body: '',
      headers: {},
      durationMs: Date.now() - started,
      cancelled: cancelledByUser || !timedOut,
      timedOut
    };
  } finally {
    clearTimeout(timeout);
    sub.dispose();
  }
}

function extractPercent(line: string): number | undefined {
  const match = /(\d{1,3})\s*%/.exec(line);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  if (Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, value));
}

function isKeyLine(line: string): boolean {
  return /(error|warn|fail|success|done|complete|progress|\d{1,3}\s*%)/i.test(line);
}

function shorten(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
