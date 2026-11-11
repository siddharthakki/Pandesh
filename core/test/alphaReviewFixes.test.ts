import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { delegationChangedNothing, renderDelegationReport, snapshotFiles, verifyDelegation } from '../runtime/delegationVerification';
import { withholdUnsupportedActionClaims } from '../runtime/actionClaims';
import { inspectPageArgs, isDesktopOpenCommand, isModelListingRequest, resolveOpenableFile } from '../runtime/piAgentEngine';

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

  it('a place in Pandesh that navigate_to really opened is not marked "Not done" (micro-test D-NAV-1)', () => {
    for (const reply of ["I've opened the Connections page for you.", 'I have opened Tools & Skills on the Connectors tab.', 'I have switched to the Board view.', "I've taken you to the Settings section."]) {
      const r = withholdUnsupportedActionClaims(reply, ['navigate_to']);
      expect(r.withheld).toEqual([]);
      expect(r.text).toBe(reply);
    }
    // Without a confirmed navigation the same sentence is still a claim no tool supports.
    expect(withholdUnsupportedActionClaims("I've opened the Connections page for you.", []).withheld.map((w) => w.kind)).toEqual(['navigation']);
    expect(withholdUnsupportedActionClaims('I have switched to the Board view.', ['gmail_search']).text).toMatch(/\[Not done: no navigation was performed/);
    // A navigation is not evidence that a file was opened.
    expect(withholdUnsupportedActionClaims('I have opened report.pdf for you.', ['navigate_to']).withheld.map((w) => w.kind)).toEqual(['open']);
  });
});

describe('what is in the mailbox is claimed only after a mailbox read that succeeded (micro-test D-GML-2)', () => {
  it('a failed search does not let the reply say what it saw', () => {
    const gml011 = 'I see that there is a "test newsletter" in your Gmail.';
    const gml019 = 'I found some mentions of "Alex" in your Gmail, but I don\'t have permission to read the messages.';
    for (const reply of [gml011, gml019, 'There are three unread invoices in your inbox.']) {
      const r = withholdUnsupportedActionClaims(reply, ['navigate_to']); // gmail_search failed, so it is not listed
      expect(r.withheld.map((w) => w.kind)).toEqual(['mailbox']);
      expect(r.text).toMatch(/\[Not done: no mailbox read was performed/);
    }
    expect(withholdUnsupportedActionClaims(gml011, ['gmail_search']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I found 2 messages from Alex in your inbox.', ['gmail_read_thread']).withheld).toEqual([]);
  });
  it('honest answers about an empty or unreachable mailbox are untouched', () => {
    for (const reply of [
      "I couldn't find anything in your inbox.",
      'I see no new emails in your inbox.',
      'There are no unread emails in your inbox.',
      'I see that you want me to check your inbox, but Gmail is not connected.',
      'I found nothing in your mailbox about the invoice.',
    ]) expect(withholdUnsupportedActionClaims(reply, []).withheld).toEqual([]);
  });
});

describe('a task is created or changed only by a tool that stores tasks (micro-tests D-TSK-1, D-TSK-4)', () => {
  it('the turn bookkeeping or a time lookup is no evidence for a to-do change', () => {
    const tsk001 = 'I\'ve created the task "Review insurance letter" and marked it as in progress.';
    const tsk002 = 'I\'ve updated the "Review insurance letter" task with a deadline of Friday, November 13th, 2026.';
    expect(withholdUnsupportedActionClaims(tsk001, ['update_task_outcome']).withheld.map((w) => w.kind)).toEqual(['task']);
    expect(withholdUnsupportedActionClaims(tsk002, ['resolve_time', 'update_task_outcome']).withheld.map((w) => w.kind)).toEqual(['task']);
    expect(withholdUnsupportedActionClaims('The task has been added to your Home project.', ['update_task_outcome']).withheld.map((w) => w.kind)).toEqual(['task']);
  });
  it('a project with its tasks, a commitment or a schedule really stored is not withheld', () => {
    expect(withholdUnsupportedActionClaims('I\'ve created the Kitchen project with three tasks.', ['create_project']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I\'ve added the task to your commitments.', ['create_commitment']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I\'ve scheduled the task for every Monday at 07:00.', ['schedule_task']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I could not create the task: there is no tool for it.', []).withheld).toEqual([]);
  });
  it('a sentence where the task is not what changed is left to the other checks', () => {
    expect(withholdUnsupportedActionClaims('I\'ve updated the README with the task list.', ['write_file']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I\'ve completed the tasks you asked for.', ['write_file']).withheld).toEqual([]);
  });
});

describe('model questions are answered, not replaced by the model list (micro-test D-MOD-1)', () => {
  it('a question about one model or a property is not a request for the inventory', () => {
    for (const q of [
      'Which model answered my last question?',
      'What model did my previous tool call use?',
      "What's the context length configured for this model?",
      'Can you use a model that is not installed?',
      'Which tools can this model invoke?',
      'What are the context lengths of my models?',
    ]) expect(isModelListingRequest(q)).toBe(false);
  });
  it('a request for the list still gets the verified inventory', () => {
    for (const q of ['Which models are installed?', 'What models do I have?', 'List my models', 'Show me the installed models', 'Which models can I use?', 'ollama list', 'models available on this PC?']) {
      expect(isModelListingRequest(q)).toBe(true);
    }
    expect(isModelListingRequest('Compare the strongest models for my RTX card')).toBe(false); // the comparison path
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
