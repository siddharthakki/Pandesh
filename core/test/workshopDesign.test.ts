/**
 * The Design workshop: a page is one self-contained HTML file, kept as Core artifacts like every workshop version.
 * Edits land only where their exact text is (unique or refused), pages come from the chat's own LOCAL model (never a
 * cloud model), and an approval card shows a page's size and title bound to its exact text by digest.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { listWorkshops, readWorkshopVersion, recordWorkshopFocus } from '../domain/workshops';
import { createWorkshopCapabilityAdapter } from '../runtime/workshopCapability';
import { MAX_DESIGN_BYTES, applyDesignEdits, checkDesignHtml, designTitle, lineDiff } from '../shared/workshop/design';
import type { ToolExecutionResult } from '../runtime/toolRunner';

const PAGE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>Kha ke dikha</title>',
  '<style>',
  'h1 { font-size: 32px; color: #222; }',
  '.cta { background: #c0392b; color: #fff; }',
  '</style>',
  '</head>',
  '<body>',
  '<main>',
  '<h1>Fresh biryani, made today</h1>',
  '<p>Order for pickup.</p>',
  '<a class="cta" href="mailto:hello@example.com">Contact us</a>',
  '</main>',
  '</body>',
  '</html>',
].join('\n');

describe('a design page: what it needs, and the only edits that can be made to it', () => {
  it('accepts a self-contained page and says up front what will not work offline', () => {
    expect(checkDesignHtml(PAGE)).toEqual({ ok: true, errors: [], warnings: [] });
    expect(checkDesignHtml('').ok).toBe(false);
    expect(checkDesignHtml('just some words').errors.join(' ')).toMatch(/does not look like an HTML page/);
    expect(checkDesignHtml(`<main>${'x'.repeat(MAX_DESIGN_BYTES)}</main>`).errors.join(' ')).toMatch(/the limit is 300 KB/);
    const online = checkDesignHtml('<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><script src="https://cdn.example.com/x.js"></script></head><body><form><button>Send</button></form></body></html>');
    expect(online.ok).toBe(true);
    expect(online.warnings.join(' ')).toMatch(/2 resource\(s\) come from other addresses/);
    expect(online.warnings.join(' ')).toMatch(/forms do not submit/);
  });

  it('changes only text that occurs exactly once, and says what changed', () => {
    const larger = applyDesignEdits(PAGE, { replacements: [{ find: 'h1 { font-size: 32px;', replace: 'h1 { font-size: 48px;' }] });
    expect(larger.ok).toBe(true);
    if (!larger.ok) return;
    expect(larger.html).toContain('h1 { font-size: 48px; color: #222; }');
    expect(larger.html.replace('48px', '32px')).toBe(PAGE);
    expect(larger.summary).toMatch(/32px.*→.*48px/);
    const missing = applyDesignEdits(PAGE, { replacements: [{ find: 'h2 { font-size', replace: 'x' }] });
    expect(missing.ok === false && missing.errors[0]).toMatch(/is not in the page; quote the current text exactly/);
    const ambiguous = applyDesignEdits(PAGE, { replacements: [{ find: 'h1', replace: 'h2' }] });
    expect(ambiguous.ok === false && ambiguous.errors[0]).toMatch(/appears 3 times/);
    expect(applyDesignEdits(PAGE, { html: PAGE }).ok).toBe(false);
    expect(applyDesignEdits(PAGE, { replacements: [] }).ok).toBe(false);
    expect(applyDesignEdits(PAGE, { replacements: Array.from({ length: 31 }, () => ({ find: 'a', replace: 'b' })) }).ok).toBe(false);
    // A replacement text with $ signs is inserted literally (no regex replacement patterns).
    const dollars = applyDesignEdits(PAGE, { replacements: [{ find: 'Order for pickup.', replace: 'Only $5 — $& $1' }] });
    expect(dollars.ok && dollars.html).toContain('Only $5 — $& $1');
  });

  it('a line diff shows exactly the changed line with a little context', () => {
    const after = PAGE.replace('32px', '48px');
    const d = lineDiff(PAGE, after, 1);
    expect(d.filter((l) => l.kind === '-').map((l) => l.text)).toEqual(['h1 { font-size: 32px; color: #222; }']);
    expect(d.filter((l) => l.kind === '+').map((l) => l.text)).toEqual(['h1 { font-size: 48px; color: #222; }']);
    expect(d.filter((l) => l.kind === ' ').map((l) => l.text)).toEqual(['<style>', '.cta { background: #c0392b; color: #fff; }']);
    expect(lineDiff(PAGE, PAGE)).toEqual([]);
  });

  it('names a page by its title, else its first heading', () => {
    expect(designTitle(PAGE)).toBe('Kha ke dikha');
    expect(designTitle('<main><h1>Hello <em>there</em></h1></main>')).toBe('Hello there');
    expect(designTitle('<main></main>')).toBe('Untitled page');
  });
});

describe('the Design workshop through the governed tools', () => {
  let dir: string; let db: CoreDatabase; let conversationId: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-design-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ctx = () => ({ cwd: dir, correlationId: conversationId, attemptId: 'att_test' });
  const seedRequest = (provider: string, model: string) => submitRequest(db, {
    clientId: 'desktop', currentMessage: 'Create a simple local landing page with a heading and a contact button.', requestedMode: 'baat_kar', conversationId, workspaceRoot: dir,
    requestedProvider: provider, requestedModel: model, selectedModel: model, toolPermissionPolicy: { profile: 'confirm-mutations' }, capability: { hasWorkspace: false, gitCapable: false },
    correlationId: `c-${Math.random()}`,
  });

  it('creates a page as version 1 (text/html, checked), then an exact edit makes version 2 and keeps version 1', async () => {
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, commandTimeoutMs: 200 });
    const run = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => adapter.run({ name, arguments: args }, ctx());
    const created = await run('create_design', { html: PAGE });
    expect(created.status).toBe('succeeded');
    expect(created.output).toMatch(/^CREATED: version 1 of a new design page/);
    const [w] = listWorkshops(db, { conversationId });
    expect(w).toMatchObject({ type: 'design', title: 'Kha ke dikha' });
    const v1 = readWorkshopVersion(db, w.latestArtifactId);
    expect(v1.artifact.mimeType).toBe('text/html');
    expect(v1.bytes.toString('utf8')).toBe(PAGE);
    expect(v1.meta.verification?.checks[0]).toMatch(/^PASS \d+ bytes of HTML, under the 300 KB limit/);
    expect(v1.meta.notes?.[0]).toMatch(/sandboxed, offline preview/);

    recordWorkshopFocus(db, { conversationId, workshopId: w.workshopId, artifactId: w.latestArtifactId, open: true, actor: 'window' });
    const edited = await run('workshop_edit', { replacements: [{ find: 'h1 { font-size: 32px;', replace: 'h1 { font-size: 48px;' }], summary: 'make the heading larger' });
    expect(edited.status).toBe('succeeded');
    expect(edited.output).toMatch(/^CHANGED: .*\(1 line\(s\) added, 1 removed\)/);
    const after = listWorkshops(db, { conversationId })[0];
    expect(after.versions).toHaveLength(2);
    expect(readWorkshopVersion(db, after.latestArtifactId).bytes.toString('utf8')).toContain('font-size: 48px');
    expect(readWorkshopVersion(db, after.versions[0].artifactId).bytes.toString('utf8')).toBe(PAGE);
    expect(after.versions[1].meta.parentArtifactId).toBe(after.versions[0].artifactId);

    const refused = await run('workshop_edit', { replacements: [{ find: 'h1', replace: 'h2' }] });
    expect(refused.status).toBe('failed');
    expect(refused.output).toMatch(/NOT CHANGED: .*appears \d+ times/);
    expect(listWorkshops(db, { conversationId })[0].versions).toHaveLength(2);
  });

  it('writes and revises with the chat\'s own local model, and records which model did it', async () => {
    seedRequest('ollama', 'gemma4:12b');
    const asked: string[] = [];
    const adapter = createWorkshopCapabilityAdapter({
      db, dataDir: dir, commandTimeoutMs: 200,
      pageWriter: async (description, opts) => { asked.push(`write ${opts.model}: ${description}`); opts.onStage?.('Writing the page'); return { ok: true, html: PAGE, title: 'Kha ke dikha', warnings: [] }; },
      pageReviser: async (html, instruction, opts) => {
        asked.push(`revise ${opts.model}: ${instruction} (${html.length} chars)`);
        const r = applyDesignEdits(html, { replacements: [{ find: 'font-size: 32px', replace: 'font-size: 52px' }] });
        return r.ok ? { ok: true, html: r.html, summary: r.summary } : { ok: false, error: r.errors.join('; ') };
      },
    });
    const run = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => adapter.run({ name, arguments: args }, ctx());
    expect((await run('create_design', { description: 'a landing page with a heading and a contact button' })).status).toBe('succeeded');
    const w = listWorkshops(db, { conversationId })[0];
    expect(w.versions[0].meta.engine).toMatchObject({ tool: 'create_design', model: 'gemma4:12b', provider: 'local', costUsd: 0 });
    recordWorkshopFocus(db, { conversationId, workshopId: w.workshopId, artifactId: w.latestArtifactId, open: true, actor: 'window' });
    const edited = await run('workshop_edit', { instruction: 'make the heading larger' });
    expect(edited.status).toBe('succeeded');
    expect(asked).toEqual([
      'write gemma4:12b: a landing page with a heading and a contact button',
      `revise gemma4:12b: make the heading larger (${PAGE.length} chars)`,
    ]);
    const after = listWorkshops(db, { conversationId })[0];
    expect(readWorkshopVersion(db, after.latestArtifactId).bytes.toString('utf8')).toContain('font-size: 52px');
    expect(after.versions[1].meta.engine.model).toBe('gemma4:12b');
  });

  it('never uses a cloud model: without a local model it refuses and sends nothing', async () => {
    seedRequest('openrouter', 'provider::some-cloud-model');
    let called = false;
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, pageWriter: async () => { called = true; throw new Error('must not run'); } });
    const r = await adapter.run({ name: 'create_design', arguments: { description: 'a landing page' } }, ctx());
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/needs a local \(Ollama\) model/);
    expect(called).toBe(false);
    expect(listWorkshops(db, { conversationId })).toHaveLength(0);
  });

  it('is approval-gated, and the card shows the page size and title bound to the exact text by digest', () => {
    const adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir });
    expect(adapter.classify('create_design')).toBe('consequential');
    // A short page is readable on the card as it is; a longer one is summarised and bound by digest.
    expect(adapter.redactArguments!('create_design', { html: PAGE })).toEqual({ html: PAGE });
    const long = PAGE.replace('<p>Order for pickup.</p>', `<p>${'Fresh every day. '.repeat(30)}</p>`);
    const shown = adapter.redactArguments!('create_design', { html: long, title: 'Kha ke dikha' }) as Record<string, unknown>;
    expect(shown.html).toBe(`a page of ${long.length} characters ("Kha ke dikha")`);
    expect(shown.htmlSha256).toMatch(/^[0-9a-f]{64}$/);
    const other = adapter.redactArguments!('create_design', { html: `${long} `, title: 'Kha ke dikha' }) as Record<string, unknown>;
    expect(other.htmlSha256).not.toBe(shown.htmlSha256);
    expect(adapter.redactArguments!('create_design', { description: 'a landing page' })).toEqual({ description: 'a landing page' });
  });
});
