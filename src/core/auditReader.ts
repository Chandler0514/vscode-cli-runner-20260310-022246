import * as path from 'path';
import { promises as fs } from 'fs';
import { AuditRecord } from './audit';

export async function readAuditRecords(
  workspacePath: string,
  auditLogFile: string,
  options: {
    readonly limit?: number;
  } = {}
): Promise<AuditRecord[]> {
  if (!workspacePath || !auditLogFile) {
    return [];
  }

  const fullPath = path.isAbsolute(auditLogFile)
    ? auditLogFile
    : path.join(workspacePath, auditLogFile);

  let content = '';
  try {
    content = await fs.readFile(fullPath, 'utf8');
  } catch {
    return [];
  }

  const records: AuditRecord[] = [];
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  lines.forEach((line) => {
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (isAuditRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Ignore malformed line and continue.
    }
  });

  const limit = options.limit ?? 0;
  if (limit > 0 && records.length > limit) {
    return records.slice(records.length - limit);
  }
  return records;
}

function isAuditRecord(value: AuditRecord | unknown): value is AuditRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === 'string'
    && typeof record.kind === 'string'
    && typeof record.title === 'string'
    && typeof record.success === 'boolean';
}
