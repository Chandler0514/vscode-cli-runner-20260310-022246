import { AutomotiveConfig, DiagnosticSummary, QualityGateResult } from './types';

export function listScenarioNames(config: AutomotiveConfig): string[] {
  return Object.keys(config.scenarios).sort((a, b) => a.localeCompare(b));
}

export function listVariantNames(config: AutomotiveConfig): string[] {
  return Object.keys(config.variantMatrix).sort((a, b) => a.localeCompare(b));
}

export function getScenarioValues(config: AutomotiveConfig): Record<string, string> {
  const activeName = config.activeScenario;
  const base = activeName ? (config.scenarios[activeName] ?? {}) : {};
  const values: Record<string, string> = {
    scenarioName: activeName || ''
  };
  Object.entries(base).forEach(([key, value]) => {
    values[key] = value;
  });
  return withEncodedValues(values);
}

export function getVariantValues(config: AutomotiveConfig, variantName: string): Record<string, string> {
  const values: Record<string, string> = {
    variantName
  };
  const entry = config.variantMatrix[variantName] ?? {};
  Object.entries(entry).forEach(([key, value]) => {
    values[key] = value;
  });
  return withEncodedValues(values);
}

export function mergeValueSources(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  sources.forEach((source) => {
    if (!source) {
      return;
    }
    Object.entries(source).forEach(([key, value]) => {
      merged[key] = value;
      const encodedKey = `${key}Encoded`;
      if (!(encodedKey in merged)) {
        merged[encodedKey] = encodeURIComponent(value);
      }
    });
  });
  return merged;
}

export function findMissingEnvVars(requiredEnvVars: string[]): string[] {
  const unique = new Set(requiredEnvVars.map((item) => item.trim()).filter((item) => item.length > 0));
  const missing: string[] = [];
  unique.forEach((name) => {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
      missing.push(name);
    }
  });
  return missing.sort((a, b) => a.localeCompare(b));
}

export function evaluateQualityGate(summary: DiagnosticSummary, config: AutomotiveConfig): QualityGateResult {
  const reasons: string[] = [];
  if (summary.errorCount > config.qualityGateMaxErrors) {
    reasons.push(`errors ${summary.errorCount} > limit ${config.qualityGateMaxErrors}`);
  }
  if (summary.warningCount > config.qualityGateMaxWarnings) {
    reasons.push(`warnings ${summary.warningCount} > limit ${config.qualityGateMaxWarnings}`);
  }
  return {
    passed: reasons.length === 0,
    maxErrors: config.qualityGateMaxErrors,
    maxWarnings: config.qualityGateMaxWarnings,
    summary,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined
  };
}

function withEncodedValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  Object.entries(values).forEach(([key, value]) => {
    out[key] = value;
    out[`${key}Encoded`] = encodeURIComponent(value);
  });
  return out;
}
