import * as fs from 'fs/promises';
import * as path from 'path';

export type ReleaseCheckStatus = 'passed' | 'warning' | 'failed';

export interface ReleaseCheckResult {
  id: string;
  status: ReleaseCheckStatus;
  message: string;
  detail?: string;
}

export interface ReleaseReadinessReport {
  schemaVersion: 1;
  generatedAt: string;
  ready: boolean;
  checks: ReleaseCheckResult[];
}

interface PackageManifest {
  name?: unknown;
  displayName?: unknown;
  version?: unknown;
  publisher?: unknown;
  license?: unknown;
  main?: unknown;
  engines?: { vscode?: unknown };
  activationEvents?: unknown;
  scripts?: Record<string, unknown>;
  contributes?: Record<string, unknown>;
}

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^credentials.*\.json$/i,
  /^secrets.*\.json$/i,
  /^id_(?:rsa|ed25519)(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

export class ReleaseReadiness {
  constructor(private readonly root: string) {}

  async inspect(): Promise<ReleaseReadinessReport> {
    const checks: ReleaseCheckResult[] = [];
    const manifest = await this.readManifest(checks);
    if (manifest) {
      checks.push(checkString('manifest.name', manifest.name, /^[a-z0-9][a-z0-9._-]+$/, 'Extension name is valid.'));
      checks.push(checkString('manifest.displayName', manifest.displayName, /\S/, 'Display name is present.'));
      checks.push(checkString('manifest.version', manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Version is valid semver.'));
      checks.push(checkString('manifest.publisher', manifest.publisher, /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/, 'Publisher is present.'));
      checks.push(checkString('manifest.main', manifest.main, /^\.\/out\/extension\.js$/, 'Compiled entrypoint is configured.'));
      checks.push(checkString('manifest.engine', manifest.engines?.vscode, /^\^?\d+\.\d+\.\d+/, 'VS Code engine is pinned.'));
      checks.push(checkString('manifest.license', manifest.license, /^(?:UNLICENSED|[A-Za-z0-9-.+]+)$/, 'License policy is explicit.'));
      checks.push(checkArrayContains('manifest.activation', manifest.activationEvents, 'onStartupFinished'));
      for (const script of ['compile', 'test', 'validate', 'package', 'release:check', 'e2e:check']) {
        checks.push(checkScript(manifest.scripts, script));
      }
      const configuration = manifest.contributes?.['configuration'];
      checks.push({
        id: 'manifest.configuration',
        status: configuration && typeof configuration === 'object' ? 'passed' : 'failed',
        message: configuration && typeof configuration === 'object'
          ? 'Configuration schema is declared.'
          : 'Configuration schema is missing.',
      });
    }

    const ignore = await this.readOptional('.vscodeignore');
    checks.push(checkIgnore(ignore, 'node_modules'));
    checks.push(checkIgnore(ignore, 'src'));
    checks.push(checkIgnore(ignore, '.ollama-agent'));
    checks.push(checkIgnore(ignore, '**/*.test.*'));

    const html = await this.readOptional(path.join('media', 'chat.html'));
    checks.push({
      id: 'security.csp',
      status: html.includes('Content-Security-Policy') && !html.includes("'unsafe-eval'") ? 'passed' : 'failed',
      message: html.includes('Content-Security-Policy') && !html.includes("'unsafe-eval'")
        ? 'Webview CSP is present and blocks unsafe eval.'
        : 'Webview CSP is missing or permits unsafe eval.',
    });
    checks.push(await this.secretPackagingCheck(ignore));
    checks.push(await this.fileCheck('README.md', true));
    checks.push(await this.fileCheck('SECURITY.md', true));
    checks.push(await this.fileCheck('CHANGELOG.md', true));

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      ready: checks.every(check => check.status !== 'failed'),
      checks,
    };
  }

  private async readManifest(checks: ReleaseCheckResult[]): Promise<PackageManifest | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.root, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as PackageManifest;
      checks.push({ id: 'manifest.parse', status: 'passed', message: 'package.json is valid JSON.' });
      return parsed;
    } catch (error) {
      checks.push({
        id: 'manifest.parse',
        status: 'failed',
        message: 'package.json could not be parsed.',
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async readOptional(relative: string): Promise<string> {
    try { return await fs.readFile(path.join(this.root, relative), 'utf8'); }
    catch { return ''; }
  }

  private async fileCheck(relative: string, required: boolean): Promise<ReleaseCheckResult> {
    try {
      const stat = await fs.stat(path.join(this.root, relative));
      return {
        id: `file.${relative}`,
        status: stat.isFile() && stat.size > 0 ? 'passed' : required ? 'failed' : 'warning',
        message: stat.isFile() && stat.size > 0 ? `${relative} is present.` : `${relative} is empty or invalid.`,
      };
    } catch {
      return {
        id: `file.${relative}`,
        status: required ? 'failed' : 'warning',
        message: `${relative} is missing.`,
      };
    }
  }

  private async secretPackagingCheck(ignoreContent: string): Promise<ReleaseCheckResult> {
    const secretFiles = await this.findSecretBearingRootFiles();
    if (secretFiles.length === 0) {
      return {
        id: 'security.inline-secrets',
        status: 'passed',
        message: 'No common secret-bearing files are present in the package root.',
      };
    }

    const ignorePatterns = parseIgnorePatterns(ignoreContent);
    const exposed = secretFiles.filter(filename => !ignorePatterns.some(pattern => globMatches(pattern, filename)));
    if (exposed.length === 0) {
      return {
        id: 'security.inline-secrets',
        status: 'passed',
        message: 'Local secret-bearing files are explicitly excluded from packaging.',
        detail: secretFiles.join(', '),
      };
    }

    return {
      id: 'security.inline-secrets',
      status: 'failed',
      message: 'Potential secret-bearing files could be included in the extension package.',
      detail: exposed.join(', '),
    };
  }

  private async findSecretBearingRootFiles(): Promise<string[]> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(entry => entry.isFile() && SECRET_FILE_PATTERNS.some(pattern => pattern.test(entry.name)))
      .map(entry => entry.name)
      .sort();
  }
}

function checkString(id: string, value: unknown, pattern: RegExp, success: string): ReleaseCheckResult {
  const valid = typeof value === 'string' && pattern.test(value);
  return { id, status: valid ? 'passed' : 'failed', message: valid ? success : `${id} is missing or invalid.` };
}

function checkArrayContains(id: string, value: unknown, expected: string): ReleaseCheckResult {
  const valid = Array.isArray(value) && value.includes(expected);
  return { id, status: valid ? 'passed' : 'failed', message: valid ? `${expected} activation is declared.` : `${expected} activation is missing.` };
}

function checkScript(scripts: Record<string, unknown> | undefined, name: string): ReleaseCheckResult {
  const valid = typeof scripts?.[name] === 'string' && String(scripts[name]).trim().length > 0;
  return { id: `script.${name}`, status: valid ? 'passed' : 'failed', message: valid ? `${name} script is configured.` : `${name} script is missing.` };
}

function checkIgnore(content: string, token: string): ReleaseCheckResult {
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const valid = lines.some(line => line === token || line === `${token}/` || line.includes(token));
  return { id: `ignore.${token}`, status: valid ? 'passed' : 'failed', message: valid ? `${token} is excluded from packaging.` : `${token} is not excluded from packaging.` };
}

function parseIgnorePatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));
}

function globMatches(pattern: string, filename: string): boolean {
  const normalized = pattern.replace(/^\.\//, '').replace(/^\//, '').replace(/^\*\*\//, '');
  if (normalized.endsWith('/')) return false;
  const expression = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${expression}$`, 'i').test(filename);
}
