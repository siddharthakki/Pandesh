import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ReleaseReadiness } from '../../release/ReleaseReadiness';

describe('Phase 22 release readiness', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-release-'));
    await fs.mkdir(path.join(root, 'media'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('passes a complete secure extension manifest', async () => {
    await writeCompleteFixture(root, 'node_modules/\nsrc/\n.ollama-agent/\n**/*.test.*\n');
    const report = await new ReleaseReadiness(root).inspect();
    expect(report.ready, JSON.stringify(report.checks, null, 2)).toBe(true);
  });

  it('permits local secret files only when package exclusions cover them', async () => {
    await writeCompleteFixture(root, 'node_modules/\nsrc/\n.ollama-agent/\n**/*.test.*\n.env*\ncredentials*.json\n');
    await fs.writeFile(path.join(root, '.env.local'), 'TOKEN=value', 'utf8');
    await fs.writeFile(path.join(root, 'credentials.local.json'), '{"token":"value"}', 'utf8');

    const report = await new ReleaseReadiness(root).inspect();
    const secretCheck = report.checks.find(check => check.id === 'security.inline-secrets');
    expect(secretCheck?.status).toBe('passed');
    expect(secretCheck?.message).toMatch(/excluded/i);
    expect(secretCheck?.detail).toContain('.env.local');
    expect(secretCheck?.detail).toContain('credentials.local.json');
    expect(report.ready, JSON.stringify(report.checks, null, 2)).toBe(true);
  });

  it('blocks secret-bearing root files that are not excluded from packaging', async () => {
    await writeCompleteFixture(root, 'node_modules/\nsrc/\n.ollama-agent/\n**/*.test.*\n');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=value', 'utf8');

    const report = await new ReleaseReadiness(root).inspect();
    const secretCheck = report.checks.find(check => check.id === 'security.inline-secrets');
    expect(report.ready).toBe(false);
    expect(secretCheck?.status).toBe('failed');
    expect(secretCheck?.detail).toBe('.env');
  });
});

async function writeCompleteFixture(root: string, vscodeIgnore: string): Promise<void> {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'ollama-agent',
    displayName: 'Ollama Agent',
    version: '0.1.0',
    publisher: 'ollama-agent',
    license: 'UNLICENSED',
    main: './out/extension.js',
    engines: { vscode: '^1.85.0' },
    activationEvents: ['onStartupFinished'],
    scripts: {
      compile: 'tsc', test: 'vitest run', validate: 'npm test', package: 'vsce package',
      'release:check': 'node out/release/cli.js', 'e2e:check': 'node out/e2e/cli.js',
    },
    contributes: { configuration: { properties: {} } },
  }), 'utf8');
  await fs.writeFile(path.join(root, '.vscodeignore'), vscodeIgnore, 'utf8');
  await fs.writeFile(path.join(root, 'media', 'chat.html'), '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# Readme', 'utf8');
  await fs.writeFile(path.join(root, 'SECURITY.md'), '# Security', 'utf8');
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), '# Changelog', 'utf8');
}
