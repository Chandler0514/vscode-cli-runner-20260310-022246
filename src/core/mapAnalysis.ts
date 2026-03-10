import { promises as fs } from 'fs';
import * as path from 'path';

export interface MapSectionSummary {
  readonly name: string;
  readonly bytes: number;
}

export interface MapAnalysisResult {
  readonly mapPath: string;
  readonly sections: MapSectionSummary[];
  readonly totalBytes: number;
  readonly textBytes: number;
  readonly dataBytes: number;
  readonly bssBytes: number;
}

export async function analyzeMapFile(mapPath: string): Promise<MapAnalysisResult> {
  const resolved = path.normalize(mapPath);
  const content = await fs.readFile(resolved, 'utf8');
  return parseMapContent(resolved, content);
}

export function parseMapContent(mapPath: string, content: string): MapAnalysisResult {
  const sectionTotals = new Map<string, number>();
  const lines = content.split(/\r?\n/);

  lines.forEach((line) => {
    const match = /^\s*(\.[A-Za-z0-9_.]+)\s+0x[0-9a-fA-F]+\s+0x([0-9a-fA-F]+)\b/.exec(line);
    if (!match) {
      return;
    }
    const section = match[1].toLowerCase();
    const bytes = Number.parseInt(match[2], 16);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return;
    }
    sectionTotals.set(section, (sectionTotals.get(section) ?? 0) + bytes);
  });

  const sections = Array.from(sectionTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({ name, bytes }));

  const textBytes = sumByPrefixes(sectionTotals, ['.text', '.rodata', '.init', '.fini']);
  const dataBytes = sumByPrefixes(sectionTotals, ['.data', '.sdata']);
  const bssBytes = sumByPrefixes(sectionTotals, ['.bss', '.sbss']);
  const totalBytes = sections.reduce((sum, item) => sum + item.bytes, 0);

  return {
    mapPath,
    sections,
    totalBytes,
    textBytes,
    dataBytes,
    bssBytes
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function sumByPrefixes(source: Map<string, number>, prefixes: string[]): number {
  let total = 0;
  source.forEach((value, key) => {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      total += value;
    }
  });
  return total;
}
