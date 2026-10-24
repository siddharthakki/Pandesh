import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultCommandPolicyEnvelope,
  evaluateGovernedAction,
  evaluateRunCommand,
  splitCompoundCommand,
} from '../runtime/commandPolicy';

const envelope = defaultCommandPolicyEnvelope(path.join(os.tmpdir(), 'kdk-policy-root'));

describe('compound command splitting', () => {
  it('evaluates each operation, not one regex on the whole string', () => {
    expect(splitCompoundCommand('npm test && npm install puppeteer-core')).toEqual([
      'npm test',
      'npm install puppeteer-core',
    ]);
    expect(splitCompoundCommand('git add -A && git commit -m "x" || git push')).toEqual([
      'git add -A',
      'git commit -m "x"',
      'git push',
    ]);
  });
});

describe('fail-closed command policy', () => {
  it('rejects a C:\\kdikha package install', () => {
    const result = evaluateRunCommand(
      'mkdir C:\\kdikha\\tipcalc-browser-check && cd /d C:\\kdikha\\tipcalc-browser-check && npm init -y && npm install puppeteer-core',
      envelope,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/outside the selected repository|package installation|browser installation/);
  });

  it('rejects npm install, curl, wget, powershell, and browser install', () => {
    expect(evaluateRunCommand('npm install lodash', envelope).decision).toBe('deny');
    expect(evaluateRunCommand('curl https://example.com', envelope).decision).toBe('deny');
    expect(evaluateRunCommand('wget https://example.com/file', envelope).decision).toBe('deny');
    expect(evaluateRunCommand('powershell -Command Get-ChildItem', envelope).decision).toBe('deny');
    expect(evaluateRunCommand('npx playwright install', envelope).decision).toBe('deny');
    expect(evaluateRunCommand('npm install puppeteer-core', envelope).reason).toMatch(/browser installation|package installation/);
  });

  it('rejects a compound command when one segment is unsafe', () => {
    const result = evaluateRunCommand('npm test && npm install puppeteer-core', envelope);
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/install/);
  });

  it('rejects git push unless the envelope authorizes it', () => {
    expect(evaluateRunCommand('git push origin HEAD', envelope).decision).toBe('deny');
    expect(evaluateRunCommand('git push origin HEAD', { ...envelope, pushAuthorized: true }).decision).toBe('allow');
  });

  it('allows in-scope tests, diff, and local commit', () => {
    expect(evaluateRunCommand('npm test', envelope).decision).toBe('allow');
    expect(evaluateRunCommand('node --test tests/app.test.js', envelope).decision).toBe('allow');
    expect(evaluateRunCommand('git diff', envelope).decision).toBe('allow');
    expect(evaluateRunCommand('git add -A && git commit -m "fix helper"', envelope).decision).toBe('allow');
  });
});

describe('path policy', () => {
  it('rejects absolute writes and parent-directory file paths', () => {
    expect(evaluateGovernedAction({
      toolName: 'propose_file_change',
      arguments: { path: 'C:\\kdikha\\evil.txt', content: 'x' },
      envelope,
    }).decision).toBe('deny');
    expect(evaluateGovernedAction({
      toolName: 'read_file',
      arguments: { path: '../secrets.txt' },
      envelope,
    }).decision).toBe('deny');
    expect(evaluateGovernedAction({
      toolName: 'propose_file_change',
      arguments: { path: 'src/../../outside.txt', content: 'x' },
      envelope,
    }).decision).toBe('deny');
  });

  it('rejects host-owned investigation paths', () => {
    expect(evaluateGovernedAction({
      toolName: 'read_file',
      arguments: { path: '.karkedikha/verification-plan.json' },
      envelope,
    }).decision).toBe('deny');
    expect(evaluateGovernedAction({
      toolName: 'propose_file_change',
      arguments: { path: '.karkedikha/verification-plan.json', content: '{}' },
      envelope,
    }).decision).toBe('deny');
  });

  it('defers invented absolute reads to repository path recovery', () => {
    const result = evaluateGovernedAction({
      toolName: 'read_file',
      arguments: { path: 'C:\\invented\\target.ts' },
      envelope,
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/repository recovery/);
  });

  it('allows an in-scope relative edit', () => {
    expect(evaluateGovernedAction({
      toolName: 'propose_file_change',
      arguments: { path: 'src/app.js', content: 'ok' },
      envelope,
    }).decision).toBe('allow');
  });
});
