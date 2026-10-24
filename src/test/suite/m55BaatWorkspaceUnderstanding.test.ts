import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { RepoFastPath } from '../../repository/RepoFastPath';
import { buildHtmlExcerpt, extractLinkedAssets, resolveKindReference } from '../../repository/HtmlEvidence';

vi.mock('../../extension', () => ({ getCoreManager: () => undefined }));

/**
 * M55: Baat Kar must be able to inspect an HTML file that is already in the open workspace, without the user naming a
 * path, without Git, without an index, and without pasting. These drive the production host retrieval
 * (AgentPanel.buildSupplementalRepositoryContext -> RepoFastPath) on real files in a temp workspace.
 */

const ctx = {
  subscriptions: [], extensionUri: vscode.Uri.file(process.cwd()),
  secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
  extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
} as unknown as vscode.ExtensionContext;

const SELECTION = { selectedModel: 'qwen3-coder:swift-27b', selectedProvider: 'ollama' };

function formPage(extraScript = ''): string {
  const filler = Array.from({ length: 2500 }, (_, i) => `.row${i}{margin:${i}px;padding:${i % 7}px;color:#${(i * 4099).toString(16).padStart(6, '0').slice(0, 6)}}`).join('\n');
  return [
    '<!doctype html><html><head><title>Event Form Studio</title>',
    `<style>\n${filler}\n</style></head><body>`,
    '<form id="guestForm" onsubmit="event.preventDefault();guestSubmit()"><input name="email"><button type="submit">Send</button></form>',
    '<script>',
    'function renderHome(){document.title="Home"}',
    'function collectGuest(f){',
    '  const errs=[];',
    '  const email=document.querySelector("[name=email]").value.trim();',
    '  if(!/^\\S+@\\S+\\.\\S+$/.test(email)){errs.push("Enter a valid email")}',
    '  if(!email){errs.push("This one is required")}',
    '  return {errs};',
    '}',
    'function guestSubmit(){',
    '  const r=collectGuest({});',
    '  if(r.errs.length){return}',
    '  localStorage.setItem("responses",JSON.stringify([]));',
    '  toast("Thanks, your response was recorded");',
    '}',
    extraScript,
    '</script></body></html>',
  ].join('\n');
}

describe('M55 Baat Kar workspace understanding (production host retrieval)', () => {
  let root: string;

  const panelFor = (active?: string) => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = active
      ? { document: { uri: vscode.Uri.file(path.join(root, active)), fileName: active } }
      : undefined;
    return new AgentPanel(ctx, root, true) as unknown as {
      buildSupplementalRepositoryContext(text: string, kind: 'baat_kar', mode: string, sel: typeof SELECTION, attachments: number): Promise<{ context: { prompt: string }; evidence: { paths: string[]; fileCount: number } } | undefined>;
    };
  };
  const ask = (panel: ReturnType<typeof panelFor>, text: string) => panel.buildSupplementalRepositoryContext(text, 'baat_kar', 'chat', SELECTION, 0);

  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'm55-baat-')); });
  afterEach(async () => {
    (vscode.window as unknown as { activeTextEditor?: unknown }).activeTextEditor = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('answers "How does this app work?" in a workspace whose only content is one HTML page (no README, manifest or Git)', async () => {
    await fs.writeFile(path.join(root, 'event_forms.html'), formPage());
    const result = await ask(panelFor('event_forms.html'), 'How does this app work?');
    expect(result?.evidence.paths).toContain('event_forms.html');
    expect(result?.context.prompt).toContain('function guestSubmit');
  });

  it('inspects the HTML for "check the html, identify functionalities" without a filename', async () => {
    await fs.writeFile(path.join(root, 'event_forms.html'), formPage());
    const result = await ask(panelFor('event_forms.html'), 'check the html, iddentify functionalities');
    expect(result?.evidence.paths).toEqual(['event_forms.html']);
    expect(result?.context.prompt).toMatch(/functions \(line\| name\)[^]*collectGuest/);
  });

  it('keeps the file in focus for follow-ups and locates validation, then submission, in a large HTML file', async () => {
    await fs.writeFile(path.join(root, 'event_forms.html'), formPage());
    const panel = panelFor('event_forms.html');
    await ask(panel, 'check the html, iddentify functionalities');
    const validation = await ask(panel, 'where is the validation logic?');
    expect(validation?.context.prompt).toContain('Enter a valid email');
    const submit = await ask(panel, 'explain what happens on submit');
    expect(submit?.context.prompt).toContain('function guestSubmit');
    expect(submit?.context.prompt).toContain('localStorage.setItem');
    // Bounded: the 2500 CSS rows are not sent whole, and the omitted ranges are declared.
    expect(submit!.context.prompt.length).toBeLessThan(60_000);
    expect(submit?.context.prompt).toMatch(/NOT included: lines/);
  });

  it('uses the active editor for "this file" and does not spend context on an unrelated file', async () => {
    await fs.writeFile(path.join(root, 'a.html'), formPage());
    await fs.writeFile(path.join(root, 'b.html'), '<html><body><p>other page</p></body></html>');
    const result = await ask(panelFor('b.html'), 'explain this file');
    expect(result?.evidence.paths).toEqual(['b.html']);
  });

  it('reads multiple distinct HTML files when the kind is ambiguous, and does not repeat byte-identical copies', async () => {
    await fs.writeFile(path.join(root, 'one.html'), formPage());
    await fs.writeFile(path.join(root, 'two.html'), '<html><body><script>function twoOnly(){return 2}</script></body></html>');
    const both = await ask(panelFor(), 'check the html and list the functionalities');
    expect(both?.evidence.paths.sort()).toEqual(['one.html', 'two.html']);
    await fs.writeFile(path.join(root, 'two.html'), formPage());
    const twins = await ask(panelFor(), 'check the html and list the functionalities');
    expect(twins?.evidence.paths).toHaveLength(1);
    expect(twins?.context.prompt).toContain('byte-identical');
  });

  it('reports a missing or renamed file instead of describing it, and names similar files that exist', async () => {
    await fs.writeFile(path.join(root, 'event_forms_v2.html'), formPage());
    const result = await ask(panelFor(), 'check event_forms.html and tell me what it does');
    expect(result?.context.prompt).toContain('No file matching "event_forms.html" exists');
    expect(result?.context.prompt).toContain('event_forms_v2.html');
    expect(result?.context.prompt).toMatch(/do not describe the contents of a file that was not read/i);
  });

  it('finds a file created after the file list was cached (stale listing) with a direct read', async () => {
    await fs.writeFile(path.join(root, 'first.html'), formPage());
    const fast = new RepoFastPath(root);
    await fast.repoQuery('check first.html', { maxChars: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 650));
    await fs.writeFile(path.join(root, 'later.html'), formPage('function laterOnly(){return 1}'));
    const result = await fast.repoQuery('check later.html', { maxChars: 20_000 });
    expect(result?.files.map(file => file.path)).toContain('later.html');
    expect(result?.prompt).toContain('laterOnly');
  });

  it('reads linked local JavaScript, and lists (never fetches) remote scripts', async () => {
    await fs.mkdir(path.join(root, 'js'));
    await fs.writeFile(path.join(root, 'js', 'app.js'), 'function validateGuest(){ return "from-linked-js"; }\n');
    await fs.writeFile(path.join(root, 'index.html'), '<html><head><script src="https://cdn.example.com/lib.js"></script></head><body><script src="js/app.js"></script></body></html>');
    const result = await ask(panelFor('index.html'), 'check index.html and find the validation logic');
    expect(result?.evidence.paths).toEqual(expect.arrayContaining(['index.html', 'js/app.js']));
    expect(result?.context.prompt).toContain('from-linked-js');
    expect(result?.context.prompt).toContain('external (not fetched): https://cdn.example.com/lib.js');
  });

  it('stays read-only: retrieval never creates, modifies or deletes workspace files', async () => {
    await fs.writeFile(path.join(root, 'event_forms.html'), formPage());
    const before = await fs.stat(path.join(root, 'event_forms.html'));
    const panel = panelFor('event_forms.html');
    await ask(panel, 'check the html, iddentify functionalities');
    await ask(panel, 'where is the validation logic?');
    const after = await fs.stat(path.join(root, 'event_forms.html'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readdir(root)).toEqual(['event_forms.html']);
  });

  it('leaves unrelated chat alone (no retrieval for a question with no workspace subject)', async () => {
    await fs.writeFile(path.join(root, 'event_forms.html'), formPage());
    expect(await ask(panelFor('event_forms.html'), 'What is the capital of France?')).toBeUndefined();
  });

  describe('pure helpers', () => {
    it('resolves a file kind to the active editor, the single file of that kind, or the shallowest candidates', () => {
      const files = ['a.html', 'sub/c.html', 'b.css'];
      expect(resolveKindReference('check the html', files, 'sub/c.html')).toEqual(['sub/c.html']);
      expect(resolveKindReference('check the stylesheet', files)).toEqual(['b.css']);
      expect(resolveKindReference('check the html', files)).toEqual(['a.html']);
      expect(resolveKindReference('check the html', ['x.html', 'y.html'])).toEqual(['x.html', 'y.html']);
      expect(resolveKindReference('check the html', ['a.css'])).toEqual([]);
    });

    it('only links local assets that exist inside the workspace', () => {
      const html = '<link rel="stylesheet" href="css/site.css"><script src="../outside.js"></script><script src="js/a.js?v=2"></script><script src="https://x.test/y.js"></script>';
      const linked = extractLinkedAssets(html, 'index.html', ['css/site.css', 'js/a.js']);
      expect(linked.styles).toEqual(['css/site.css']);
      expect(linked.scripts).toEqual(['js/a.js']);
      expect(linked.remote).toEqual(['https://x.test/y.js']);
    });

    it('targets script functions by stem and ignores generic question words', () => {
      const raw = formPage();
      const targeted = buildHtmlExcerpt(raw, 6_000, ['validation', 'functionalities']);
      expect(targeted.text).toContain('Enter a valid email');
    });
  });
});
