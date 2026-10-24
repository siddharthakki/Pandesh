import { describe, expect, it } from 'vitest';
import {
  authorizeDesktopTaskScope,
  classifyDesktopApproval,
  classifyDesktopCommand,
  describeDesktopTaskScope,
} from '../src/host/desktopTaskScope';
import { RENDERER_VISIBLE_KEYS } from '../src/ipc';

describe('desktop task scope', () => {
  const scope = authorizeDesktopTaskScope(describeDesktopTaskScope('C:\\\\tmp\\\\tip-calculator')!);

  it('shows repository, permitted actions, and local-commit delivery', () => {
    expect(scope.repository).toContain('tip-calculator');
    expect(scope.permittedActions.join(' ')).toMatch(/read_file/);
    expect(scope.permittedActions.join(' ')).toMatch(/propose_file_change/);
    expect(scope.permittedActions.join(' ')).toMatch(/inspect_page/);
    expect(scope.deliveryDestination).toMatch(/local git commit/);
    expect(scope.pushAuthorized).toBe(false);
    expect(scope.authorized).toBe(true);
  });

  it('keeps file mutations review-required and auto-approves in-scope tests and local commits', () => {
    expect(classifyDesktopApproval(scope, {
      toolName: 'authorize_mission',
      paths: [],
      scope: 'Authorize autonomous mission',
      detail: 'Repository: tip-calculator',
    })).toBe('prompt');
    expect(classifyDesktopApproval(scope, {
      toolName: 'propose_file_change',
      paths: ['app.js'],
      scope: 'propose_file_change app.js',
      detail: 'diff',
    })).toBe('prompt');
    expect(classifyDesktopCommand('npm test')).toBe('auto_approve');
    expect(classifyDesktopCommand('node --test tests/calculate.test.js')).toBe('auto_approve');
    expect(classifyDesktopCommand('git add -A && git commit -m "Add round up option"')).toBe('auto_approve');
    expect(classifyDesktopCommand('dir /s /b')).toBe('auto_approve');
    expect(classifyDesktopApproval(scope, {
      toolName: 'inspect_page',
      paths: ['index.html'],
      scope: 'inspect_page index.html',
      detail: '{"path":"index.html"}',
    })).toBe('auto_approve');
  });

  it('still prompts for push and other out-of-scope commands', () => {
    expect(classifyDesktopCommand('git push origin HEAD')).toBe('prompt');
    expect(classifyDesktopCommand('git add -A && git push')).toBe('prompt');
    expect(classifyDesktopCommand('curl https://example.com')).toBe('prompt');
    expect(classifyDesktopCommand('dir "C:\\Program Files (x86)\\Microsoft\\Edge\\Application"')).toBe('prompt');
    expect(classifyDesktopCommand('mkdir C:\\kdikha\\tipcalc-browser-check && npm init -y && npm install puppeteer-core')).toBe('prompt');
    expect(classifyDesktopCommand('npm install lodash')).toBe('prompt');
    expect(classifyDesktopCommand('wget https://example.com')).toBe('prompt');
    expect(classifyDesktopCommand('powershell -Command Get-ChildItem')).toBe('prompt');
    expect(classifyDesktopCommand('npx playwright install')).toBe('prompt');
    expect(classifyDesktopApproval(scope, {
      toolName: 'propose_file_change',
      paths: ['src/../../outside.txt'],
      scope: 'propose_file_change src/../../outside.txt',
      detail: 'diff',
    })).toBe('prompt');
    expect(classifyDesktopApproval(scope, {
      toolName: 'inspect_page',
      paths: ['C:\\kdikha\\tipcalc-browser-check'],
      scope: 'inspect_page C:\\kdikha\\tipcalc-browser-check',
      detail: '',
    })).toBe('prompt');
    expect(classifyDesktopApproval(scope, {
      toolName: 'run_command',
      paths: [],
      scope: 'run_command git push origin test/desktop-round-up',
      detail: 'git push origin test/desktop-round-up',
    })).toBe('prompt');
  });

  it('does not auto-approve before the task scope is authorized', () => {
    const pending = describeDesktopTaskScope('C:\\\\tmp\\\\tip-calculator')!;
    expect(pending.authorized).toBe(false);
    expect(classifyDesktopApproval(pending, {
      toolName: 'propose_file_change',
      paths: ['app.js'],
      scope: 'propose_file_change app.js',
      detail: 'diff',
    })).toBe('prompt');
  });
});

describe('desktop snapshot contract', () => {
  it('exposes task scope without leaking Core envelope secrets', () => {
    expect(RENDERER_VISIBLE_KEYS).toContain('taskScope');
    expect(RENDERER_VISIBLE_KEYS.join(',')).not.toMatch(/token|digest|frozenContextHash|authorization/i);
  });
});
