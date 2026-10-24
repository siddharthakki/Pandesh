import * as fs from 'fs/promises';
import * as path from 'path';

export type SecurityFindingSeverity = 'info' | 'warning' | 'error' | 'critical';
export type SecurityFindingCategory = 'secret' | 'dependency' | 'license' | 'configuration' | 'source';

export interface SecurityFinding {
  id: string;
  category: SecurityFindingCategory;
  severity: SecurityFindingSeverity;
  message: string;
  file?: string;
  line?: number;
  package?: string;
  version?: string;
  remediation?: string;
}

export interface DependencyAdvisory {
  id: string;
  severity: SecurityFindingSeverity;
  message: string;
  remediation?: string;
}

export interface DependencyInspector {
  advisories(packageName: string, version: string, signal: AbortSignal): Promise<DependencyAdvisory[]>;
  license(packageName: string, version: string, signal: AbortSignal): Promise<string | undefined>;
}

export interface SecurityScannerOptions {
  allowedLicenses?: string[];
  deniedLicenses?: string[];
  excludedDirectories?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface SecurityScanReport {
  schemaVersion: 1;
  generatedAt: string;
  passed: boolean;
  scannedFiles: number;
  scannedDependencies: number;
  findings: SecurityFinding[];
}

export class SecurityScanner {
  private readonly allowedLicenses?: Set<string>;
  private readonly deniedLicenses: Set<string>;
  private readonly excludedDirectories: Set<string>;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly workspaceRoot: string,
    private readonly dependencyInspector?: DependencyInspector,
    options: SecurityScannerOptions = {},
  ) {
    this.allowedLicenses = options.allowedLicenses
      ? new Set(options.allowedLicenses.map(normalizeLicense))
      : undefined;
    this.deniedLicenses = new Set((options.deniedLicenses ?? []).map(normalizeLicense));
    this.excludedDirectories = new Set(options.excludedDirectories ?? [
      '.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.ollama-agent',
    ]);
    this.maxFiles = options.maxFiles ?? 20_000;
    this.maxFileBytes = options.maxFileBytes ?? 2_000_000;
  }

  async scan(signal: AbortSignal = new AbortController().signal): Promise<SecurityScanReport> {
    const findings: SecurityFinding[] = [];
    const files = await this.collectFiles();
    let scannedFiles = 0;
    for (const filename of files) {
      if (signal.aborted) throw cancellationError();
      const stat = await fs.stat(filename);
      if (stat.size > this.maxFileBytes) continue;
      const content = await fs.readFile(filename, 'utf8');
      scannedFiles += 1;
      findings.push(...scanContent(this.relative(filename), content));
    }

    const dependencies = await this.readDependencies();
    if (this.dependencyInspector) {
      for (const [name, version] of dependencies) {
        if (signal.aborted) throw cancellationError();
        const advisories = await this.dependencyInspector.advisories(name, version, signal);
        findings.push(...advisories.map(advisory => ({
          id: `dependency:${name}:${advisory.id}`,
          category: 'dependency' as const,
          severity: advisory.severity,
          message: advisory.message,
          package: name,
          version,
          remediation: advisory.remediation,
        })));
        const license = await this.dependencyInspector.license(name, version, signal);
        if (license && !this.licenseAllowed(license)) {
          findings.push({
            id: `license:${name}:${normalizeLicense(license)}`,
            category: 'license',
            severity: 'error',
            message: `Dependency license ${license} is not allowed.`,
            package: name,
            version,
            remediation: 'Replace the dependency or update the reviewed organization license policy.',
          });
        }
      }
    }

    findings.sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.id.localeCompare(right.id));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      passed: !findings.some(finding => finding.severity === 'error' || finding.severity === 'critical'),
      scannedFiles,
      scannedDependencies: dependencies.length,
      findings,
    };
  }

  private async collectFiles(): Promise<string[]> {
    const output: string[] = [];
    const pending = [path.resolve(this.workspaceRoot)];
    while (pending.length > 0 && output.length < this.maxFiles) {
      const current = pending.pop()!;
      let entries: Array<import('fs').Dirent>;
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (output.length >= this.maxFiles) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!this.excludedDirectories.has(entry.name)) pending.push(full);
        } else if (entry.isFile() && isTextFile(entry.name)) {
          output.push(full);
        }
      }
    }
    return output.sort();
  }

  private async readDependencies(): Promise<Array<[string, string]>> {
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(this.workspaceRoot, 'package.json'), 'utf8'),
      ) as PackageManifest;
      const dependencies = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
      };
      return Object.entries(dependencies)
        .map(([name, version]) => [name, version.replace(/^[~^<>=\s]+/, '')] as [string, string])
        .sort(([left], [right]) => left.localeCompare(right));
    } catch {
      return [];
    }
  }

  private licenseAllowed(license: string): boolean {
    const normalized = normalizeLicense(license);
    if (this.deniedLicenses.has(normalized)) return false;
    if (this.allowedLicenses && !this.allowedLicenses.has(normalized)) return false;
    return true;
  }

  private relative(filename: string): string {
    return path.relative(this.workspaceRoot, filename).replace(/\\/g, '/');
  }
}

function scanContent(filename: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<{
    id: string;
    expression: RegExp;
    category: SecurityFindingCategory;
    severity: SecurityFindingSeverity;
    message: string;
    remediation: string;
  }> = [
    {
      id: 'private-key',
      expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      category: 'secret',
      severity: 'critical',
      message: 'Private key material appears in source.',
      remediation: 'Remove the key, rotate it, and use secret storage.',
    },
    {
      id: 'credential-assignment',
      expression: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["'][^"']{8,}["']/i,
      category: 'secret',
      severity: 'error',
      message: 'A credential-like value appears to be assigned in source.',
      remediation: 'Move the value to VS Code SecretStorage or an excluded local environment file.',
    },
    {
      id: 'unsafe-eval',
      expression: /\beval\s*\(|new\s+Function\s*\(/,
      category: 'source',
      severity: 'error',
      message: 'Dynamic code evaluation is present.',
      remediation: 'Replace dynamic evaluation with a typed parser or explicit dispatch.',
    },
    {
      id: 'shell-enabled',
      expression: /\bshell\s*:\s*true\b/,
      category: 'configuration',
      severity: 'error',
      message: 'Process execution enables a shell.',
      remediation: 'Use direct executable invocation with shell disabled.',
    },
    {
      id: 'tls-disabled',
      expression: /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0|rejectUnauthorized\s*:\s*false/,
      category: 'configuration',
      severity: 'critical',
      message: 'TLS verification appears disabled.',
      remediation: 'Restore certificate verification and configure trusted certificates explicitly.',
    },
  ];

  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      if (!pattern.expression.test(lines[index])) continue;
      findings.push({
        id: `${pattern.category}:${pattern.id}:${filename}:${index + 1}`,
        category: pattern.category,
        severity: pattern.severity,
        message: pattern.message,
        file: filename,
        line: index + 1,
        remediation: pattern.remediation,
      });
    }
  }
  return findings;
}

function isTextFile(filename: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|env|md|txt|html|css|xml|properties|ini|cfg|conf|sh|ps1|py|java|kt|cs|go|rs)$/i.test(filename) ||
    /^\.(?:env|npmrc|yarnrc)$/i.test(filename);
}

function normalizeLicense(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '-');
}

function severityRank(value: SecurityFindingSeverity): number {
  return value === 'critical' ? 3 : value === 'error' ? 2 : value === 'warning' ? 1 : 0;
}

function cancellationError(): Error {
  const error = new Error('Security scan cancelled.');
  error.name = 'AbortError';
  return error;
}
