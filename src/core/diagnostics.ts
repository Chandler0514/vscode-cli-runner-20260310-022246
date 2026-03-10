import * as path from 'path';
import * as vscode from 'vscode';
import { CapturedLine, DiagnosticSummary, ParsedDiagnostic } from './types';

export function parseDiagnostics(lines: readonly CapturedLine[], workspacePath: string): ParsedDiagnostic[] {
  const parsed: ParsedDiagnostic[] = [];
  for (const line of lines) {
    if (parsed.length >= 2000) {
      break;
    }
    const entry = parseDiagnosticLine(line.text, workspacePath);
    if (entry) {
      parsed.push(entry);
    }
  }
  return parsed;
}

export function publishDiagnostics(
  collection: vscode.DiagnosticCollection,
  diagnostics: readonly ParsedDiagnostic[]
): DiagnosticSummary {
  const perFile = new Map<string, vscode.Diagnostic[]>();
  diagnostics.forEach((entry) => {
    const key = path.normalize(entry.filePath);
    const diagnosticsForFile = perFile.get(key) ?? [];
    diagnosticsForFile.push(
      new vscode.Diagnostic(
        new vscode.Range(
          Math.max(0, entry.line - 1),
          Math.max(0, entry.column - 1),
          Math.max(0, entry.line - 1),
          Math.max(0, entry.column)
        ),
        entry.message,
        toSeverity(entry.severity)
      )
    );
    const last = diagnosticsForFile[diagnosticsForFile.length - 1];
    last.source = entry.source;
    perFile.set(key, diagnosticsForFile);
  });

  collection.clear();
  perFile.forEach((items, filePath) => {
    collection.set(vscode.Uri.file(filePath), items);
  });

  return summarizeDiagnostics(diagnostics);
}

export function summarizeDiagnostics(diagnostics: readonly ParsedDiagnostic[]): DiagnosticSummary {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  diagnostics.forEach((entry) => {
    if (entry.severity === 'error') {
      errorCount += 1;
      return;
    }
    if (entry.severity === 'warning') {
      warningCount += 1;
      return;
    }
    infoCount += 1;
  });
  return {
    errorCount,
    warningCount,
    infoCount,
    totalCount: diagnostics.length
  };
}

function toSeverity(value: ParsedDiagnostic['severity']): vscode.DiagnosticSeverity {
  if (value === 'error') {
    return vscode.DiagnosticSeverity.Error;
  }
  if (value === 'warning') {
    return vscode.DiagnosticSeverity.Warning;
  }
  return vscode.DiagnosticSeverity.Information;
}

function parseDiagnosticLine(line: string, workspacePath: string): ParsedDiagnostic | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  const gccWithColumn = /^(.*):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i.exec(trimmed);
  if (gccWithColumn) {
    return buildParsed({
      filePath: toAbsolutePath(gccWithColumn[1], workspacePath),
      line: toInt(gccWithColumn[2]),
      column: toInt(gccWithColumn[3]),
      severity: toParsedSeverity(gccWithColumn[4]),
      source: 'compiler',
      message: gccWithColumn[5]
    });
  }

  const gccNoColumn = /^(.*):(\d+):\s*(fatal error|error|warning|note):\s*(.+)$/i.exec(trimmed);
  if (gccNoColumn) {
    return buildParsed({
      filePath: toAbsolutePath(gccNoColumn[1], workspacePath),
      line: toInt(gccNoColumn[2]),
      column: 1,
      severity: toParsedSeverity(gccNoColumn[3]),
      source: 'compiler',
      message: gccNoColumn[4]
    });
  }

  const iar = /^"(.+?)",(\d+)\s+(Warning|Error|Remark)(?:\[[^\]]+\])?:\s*(.+)$/i.exec(trimmed);
  if (iar) {
    return buildParsed({
      filePath: toAbsolutePath(iar[1], workspacePath),
      line: toInt(iar[2]),
      column: 1,
      severity: toParsedSeverity(iar[3]),
      source: 'iar',
      message: iar[4]
    });
  }

  const msvc = /^(.*)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)\s*[A-Z0-9]*:?\s*(.+)$/i.exec(trimmed);
  if (msvc) {
    return buildParsed({
      filePath: toAbsolutePath(msvc[1], workspacePath),
      line: toInt(msvc[2]),
      column: toInt(msvc[3] ?? '1'),
      severity: toParsedSeverity(msvc[4]),
      source: 'msvc',
      message: msvc[5]
    });
  }

  const ghs = /^"?(.*?)"?,\s*line\s+(\d+):\s*(warning|error)\s*#?\d*:?\s*(.+)$/i.exec(trimmed);
  if (ghs) {
    return buildParsed({
      filePath: toAbsolutePath(ghs[1], workspacePath),
      line: toInt(ghs[2]),
      column: 1,
      severity: toParsedSeverity(ghs[3]),
      source: 'ghs',
      message: ghs[4]
    });
  }

  return undefined;
}

function buildParsed(input: ParsedDiagnostic): ParsedDiagnostic | undefined {
  if (!input.filePath || Number.isNaN(input.line) || input.line <= 0) {
    return undefined;
  }
  const column = Number.isNaN(input.column) || input.column <= 0 ? 1 : input.column;
  return {
    ...input,
    column
  };
}

function toAbsolutePath(candidate: string, workspacePath: string): string {
  const normalized = stripQuotes(candidate.trim());
  if (!normalized) {
    return normalized;
  }
  if (path.isAbsolute(normalized)) {
    return path.normalize(normalized);
  }
  return path.normalize(path.join(workspacePath, normalized));
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
    return value.slice(1, -1);
  }
  return value;
}

function toInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toParsedSeverity(value: string): ParsedDiagnostic['severity'] {
  const normalized = value.toLowerCase();
  if (normalized.includes('error')) {
    return 'error';
  }
  if (normalized.includes('warn')) {
    return 'warning';
  }
  return 'info';
}
