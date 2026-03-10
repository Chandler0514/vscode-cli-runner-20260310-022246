import * as path from 'path';
import { promises as fs } from 'fs';

export interface AuditRecord {
  readonly timestamp: string;
  readonly kind: 'process' | 'rest' | 'workflow';
  readonly title: string;
  readonly scenarioName?: string;
  readonly variantName?: string;
  readonly success: boolean;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly status?: number;
  readonly detail?: string;
}

export async function appendAuditRecord(
  workspacePath: string,
  auditLogFile: string,
  record: AuditRecord
): Promise<void> {
  if (!workspacePath || !auditLogFile) {
    return;
  }
  const fullPath = path.isAbsolute(auditLogFile)
    ? auditLogFile
    : path.join(workspacePath, auditLogFile);
  const folder = path.dirname(fullPath);
  await fs.mkdir(folder, { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await fs.appendFile(fullPath, line, 'utf8');
}
