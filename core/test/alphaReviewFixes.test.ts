import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { delegationChangedNothing, renderDelegationReport, snapshotFiles, verifyDelegation } from '../runtime/delegationVerification';
import { withholdUnsupportedActionClaims } from '../runtime/actionClaims';
import { inspectPageArgs, isDesktopOpenCommand, resolveOpenableFile } from '../runtime/piAgentEngine';

const noRun = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-alpha-'));

describe('alpha review: OpenCode in a plain folder', () => {
  it('reports "no file was created" when OpenCode changed nothing', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    const before = snapshotFiles(dir);
    const v = await verifyDelegation(dir, new Set(), noRun, undefined, before);
    expect(v.source).toBe('snapshot');
    expect(delegationChangedNothing(v)).toBe(true);
    expect(renderDelegationReport(v)).toContain('No file was created, changed or deleted');
  });

  it('reports the file OpenCode really created (the old report said "Changed files: none")', async () => {
    const dir = tmp();
    const before = snapshotFiles(dir);
    fs.writeFileSync(path.join(dir, 'cat_garden.html'), '<html></html>');
    const v = await verifyDelegation(dir, new Set(), noRun, undefined, before);
    expect(delegationChangedNothing(v)).toBe(false);
    expect(v.newUntracked).toEqual(['cat_garden.html']);
    expect(renderDelegationReport(v)).toContain('Created: `cat_garden.html`');
  });
});

describe('alpha review: false "created" and "opened" claims', () => {
  it('a missing file is withheld when only a hand-off mentioned it', () => {
    const r = withholdUnsupportedActionClaims('The file dashboard.html was successfully created in your workspace.', ['update_task_outcome'], { fileExists: () => false });
    expect(r.withheld.map((w) => w.kind)).toContain('missing_file');
  });

  it('"I have opened the file" without an open tool is withheld', () => {
    const r = withholdUnsupportedActionClaims('I have opened the file in my internal System View so I can confirm it renders.', ['delegate_to_opencode']);
    expect(r.withheld.map((w) => w.kind)).toContain('open');
    const ok = withholdUnsupportedActionClaims('I have opened dashboard.html in your browser.', ['open_local_file']);
    expect(ok.withheld).toEqual([]);
  });
});

describe('alpha review: opening a file for the user', () => {
  it('opens only existing, allowed files inside the selected folder', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'dashboard.html'), '<html></html>');
    fs.writeFileSync(path.join(dir, 'run.bat'), 'echo');
    expect(resolveOpenableFile('dashboard.html', dir)).toEqual({ ok: true, file: path.join(dir, 'dashboard.html') });
    expect(resolveOpenableFile(path.join(dir, 'dashboard.html'), dir).ok).toBe(true);
    expect(resolveOpenableFile(`file:///${path.join(dir, 'dashboard.html').replace(/\\/g, '/')}`, dir).ok).toBe(true);
    expect(resolveOpenableFile('missing.html', dir)).toMatchObject({ ok: false, reason: expect.stringContaining('does not exist') });
    expect(resolveOpenableFile('run.bat', dir)).toMatchObject({ ok: false });
    expect(resolveOpenableFile(path.join(os.tmpdir(), 'elsewhere.html'), dir)).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
    expect(resolveOpenableFile('dashboard.html', null)).toMatchObject({ ok: false });
  });

  it('run_checks refuses desktop-open commands that hang (start "x")', () => {
    expect(isDesktopOpenCommand('start "cat_garden.html"')).toBe(true);
    expect(isDesktopOpenCommand('explorer.exe dashboard.html')).toBe(true);
    expect(isDesktopOpenCommand('cmd /c start "" x.html')).toBe(true);
    expect(isDesktopOpenCommand('npm test')).toBe(false);
    expect(isDesktopOpenCommand('npm start')).toBe(false);
  });

  it('inspect_page keeps a workspace-relative path', () => {
    const dir = tmp();
    expect(inspectPageArgs({ path: 'dashboard.html' }, dir)).toEqual({ path: 'dashboard.html' });
    expect(inspectPageArgs({ path: path.join(dir, 'sub', 'a.html') }, dir)).toEqual({ path: 'sub/a.html' });
    const outside = path.join(os.tmpdir(), 'x.html');
    expect(inspectPageArgs({ path: outside }, dir)).toEqual({ path: outside });
  });
});
