import { describe, expect, it } from 'vitest';
import { EvidenceLedger } from '../platform/evidenceLedger';
import {
  STATIC_PREVIEW_CSP, buildHtmlPreview, buildJsonTree, buildMarkdownPreview, buildOutputPreview, buildSvgPreview, buildTable, buildTaskResult, buildWebPreview,
  classifyArtifactPath, previewFor, sanitizeHtmlForPreview, sanitizeSvg, validationsFromLedger, type Artifact,
} from '../platform/artifacts/taskResult';

const art = (over: Partial<Artifact>): Artifact => ({ id: 'a1', type: 'html', title: 'index.html', evidenceIds: [], createdAt: '2026-10-06T00:00:00Z', ...over });

describe('TaskResult: validation comes only from recorded evidence', () => {
  it('no recorded run → none_recorded (not a pass, not a failure); a green run → passed with its evidence', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ kind: 'file_written', subject: 'index.html', summary: 'wrote index.html', ok: true });
    const none = buildTaskResult({ status: 'completed', summary: 'Made a page.', ledger, artifacts: [art({ evidenceIds: ['ev-1'] })] });
    expect(none.validationStatus).toBe('none_recorded');
    expect(none.validations).toEqual([]);

    ledger.record({ kind: 'test_run', subject: 'npm test', summary: 'vitest: 12 passed', ok: true, exitCode: 0 });
    const passed = buildTaskResult({ status: 'completed', summary: 'Done.', ledger, artifacts: [] });
    expect(passed.validationStatus).toBe('passed');
    expect(passed.validations).toEqual([expect.objectContaining({ kind: 'test', ok: true, exitCode: 0, evidenceId: 'ev-2' })]);
    expect(passed.evidence.map(e => e.id)).toEqual(['ev-1', 'ev-2']);
  });

  it('a failing run, and a pass invalidated by a later write, are never reported as passed', () => {
    const failing = new EvidenceLedger();
    failing.record({ kind: 'test_run', subject: 'npm test', summary: '2 failed', ok: false, exitCode: 1 });
    expect(buildTaskResult({ status: 'failed', summary: 'x', ledger: failing, artifacts: [] }).validationStatus).toBe('failed');

    const stale = new EvidenceLedger();
    stale.record({ kind: 'test_run', subject: 'npm test', summary: 'green', ok: true, exitCode: 0 });
    stale.record({ kind: 'file_written', subject: 'src/a.ts', summary: 'edit', ok: true });
    expect(buildTaskResult({ status: 'completed', summary: 'x', ledger: stale, artifacts: [] }).validationStatus).toBe('failed');
  });

  it('unfinished/unobserved runs are not validations; actions are derived from artifacts and the run target needs approval', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ kind: 'command_run', subject: 'node x.js', summary: 'started' });
    expect(validationsFromLedger(ledger)).toEqual([]);
    const result = buildTaskResult({
      status: 'completed', summary: 's', ledger,
      artifacts: [art({ id: 'h', type: 'html', path: 'index.html' }), art({ id: 'p', type: 'pdf', title: 'r.pdf', path: 'r.pdf' }), art({ id: 'o', type: 'terminal-output', title: 'output' })],
      runTarget: { label: 'Run app', url: 'http://localhost:3000' },
    });
    expect(result.actions.map(a => a.kind)).toEqual(expect.arrayContaining(['preview', 'open-file', 'open-externally', 'run-target', 'open-output']));
    expect(result.actions.find(a => a.kind === 'run-target')).toMatchObject({ requiresApproval: true });
    expect(result.actions.filter(a => a.kind === 'preview').every(a => a.requiresApproval === false)).toBe(true);
  });

  it('classifies artifact paths', () => {
    expect(classifyArtifactPath('a/b.html').type).toBe('html');
    expect(classifyArtifactPath('x.SVG').type).toBe('svg');
    expect(classifyArtifactPath('x.csv').type).toBe('table');
    expect(classifyArtifactPath('x.py').type).toBe('file');
  });
});

describe('safe previews: generated content is never rendered with privilege', () => {
  const HOSTILE = `<html><head><title>x</title><script>fetch('//evil')</script><base href="//evil/"><meta http-equiv="refresh" content="0;url=//evil"><link rel="stylesheet" href="//evil/x.css"></head><body onload="steal()"><h1 onclick="x()">Hi</h1><a href="javascript:alert(1)">l</a><a href='  JaVaScRiPt:alert(2)'>m</a><img src="https://evil/pixel.png" onerror="y()"><iframe src="//evil"></iframe><form action="//evil"><input></form><object data="x"></object><style>@import url(//evil/a.css); .a{background:url(https://evil/b.png)}</style><p>kept</p></body></html>`;

  it('HTML: scripts, handlers, frames, forms, base/meta/link, javascript: URLs and remote loads are removed; CSP and empty sandbox are prescribed', () => {
    const { html, removed } = sanitizeHtmlForPreview(HOSTILE);
    for (const bad of ['<script', 'fetch(', 'onload', 'onclick', 'onerror', 'javascript:', 'JaVaScRiPt', '<iframe', '<form', '<object', '<base', 'http-equiv="refresh"', '<link', '@import', 'evil/pixel', 'evil/b.png']) expect(html, bad).not.toContain(bad);
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<p>kept</p>');
    expect(removed).toEqual(expect.arrayContaining(['script', 'iframe', 'form', 'event-handler', 'javascript-url', 'remote-resource']));
    const model = buildHtmlPreview(HOSTILE);
    expect(model.sandbox).toBe(''); // an empty sandbox attribute: no scripts, no same-origin, no forms, no popups
    expect(model.csp).toBe(STATIC_PREVIEW_CSP);
    expect(model.csp).not.toMatch(/script-src/);
    expect(model.srcdoc).toContain(`content="${STATIC_PREVIEW_CSP}"`);
    expect(model.srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(model.srcdoc.indexOf('<h1>'));
    expect(buildHtmlPreview('<p>bare</p>').srcdoc).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
  });

  it('SVG: shown through an <img> data URL after removing script, handlers, foreignObject and external references', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>alert(1)</script><foreignObject><div/></foreignObject><image href="https://evil/x.png"/><use href="#ok"/><circle r="5"/></svg>';
    const { svg: clean, removed } = sanitizeSvg(svg);
    for (const bad of ['<script', 'onload', 'foreignObject', 'evil/x.png']) expect(clean).not.toContain(bad);
    expect(clean).toContain('<circle r="5"/>');
    expect(removed).toEqual(expect.arrayContaining(['script', 'foreignobject', 'event-handler', 'external-reference']));
    const model = buildSvgPreview(svg);
    expect(model.dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Buffer.from(model.dataUrl.split(',')[1], 'base64').toString()).not.toContain('<script');
  });

  it('JSON becomes a bounded tree; invalid JSON is reported, not thrown', () => {
    const tree = buildJsonTree(JSON.stringify({ a: 1, b: { c: [1, 2, { d: 'x'.repeat(500) }] }, e: null, f: true }));
    expect(tree.root).toMatchObject({ type: 'object', size: 4 });
    const b = tree.root.children!.find(n => n.key === 'b')!;
    expect(b.children![0]).toMatchObject({ key: 'c', type: 'array', size: 3 });
    const deep = b.children![0].children![2].children![0];
    expect(deep.value!.length).toBeLessThanOrEqual(201);
    expect(buildJsonTree('{oops').error).toMatch(/Not valid JSON/);
    expect(buildJsonTree(JSON.stringify(Array.from({ length: 1000 }, (_, i) => i))).root).toMatchObject({ size: 1000, truncated: true });
    let nested = '1';
    for (let i = 0; i < 20; i++) nested = `[${nested}]`;
    expect(JSON.stringify(buildJsonTree(nested))).toContain('"truncated":true');
  });

  it('CSV/TSV become a bounded table with quoting and a truthful row count', () => {
    const t = buildTable('name,qty,note\nwidget,3,"has, comma"\n"gad""get",4,"multi\nline"\n');
    expect(t.columns).toEqual(['name', 'qty', 'note']);
    expect(t.rows).toEqual([['widget', '3', 'has, comma'], ['gad"get', '4', 'multi\nline']]);
    expect(t.totalRows).toBe(2);
    expect(buildTable('a\tb\n1\t2\n').columns).toEqual(['a', 'b']);
    const big = buildTable(`h\n${Array.from({ length: 2000 }, (_, i) => String(i)).join('\n')}\n`, { maxRows: 100 });
    expect(big.rows).toHaveLength(100);
    expect(big.truncated).toBe(true);
  });

  it('Markdown renders with escaping first: raw HTML and javascript: links cannot survive', () => {
    const { html } = buildMarkdownPreview('# Title\n\n<script>alert(1)</script> **bold** and `code <b>`\n\n- a\n- b\n\n1. one\n\n[ok](https://example.com) [bad](javascript:alert(1)) [x](data:text/html,hi)\n\n```\n<img src=x onerror=y>\n```\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('href="https://example.com"');
    expect(html.match(/href="#"/g)).toHaveLength(2);
    expect(html).toContain('&lt;img src=x onerror=y&gt;');
    expect(html).not.toMatch(/<img/);
  });

  it('terminal/python output strips ANSI, keeps exit code and generated files, and is bounded', () => {
    const out = buildOutputPreview({ stdout: '\u001b[31mred\u001b[0m ok', stderr: 'warn', exitCode: 2, files: ['plot.png'] });
    expect(out).toMatchObject({ stdout: 'red ok', stderr: 'warn', exitCode: 2, files: ['plot.png'], truncated: false });
    expect(buildOutputPreview({ stdout: 'x'.repeat(100) }, 10)).toMatchObject({ truncated: true });
  });

  it('web previews are local-only and always require a governed launch', () => {
    expect(buildWebPreview('http://localhost:3000/app')).toMatchObject({ mode: 'web', requiresGovernedLaunch: true });
    expect(buildWebPreview('http://127.0.0.1:8080')).toMatchObject({ mode: 'web' });
    expect(buildWebPreview('https://example.com')).toMatchObject({ mode: 'refused' });
    expect(buildWebPreview('file:///etc/passwd')).toMatchObject({ mode: 'refused' });
    expect(buildWebPreview('nonsense')).toMatchObject({ mode: 'refused' });
  });

  it('previewFor picks the right safe model per artifact type and never trusts a mislabelled image', () => {
    expect(previewFor(art({ type: 'html', content: '<script>x</script><b>y</b>' })).mode).toBe('sandboxed-html');
    expect(previewFor(art({ type: 'svg', content: '<svg/>' })).mode).toBe('image');
    expect(previewFor(art({ type: 'json', content: '{}' })).mode).toBe('json-tree');
    expect(previewFor(art({ type: 'table', content: 'a\n1' })).mode).toBe('table');
    expect(previewFor(art({ type: 'markdown', content: '# x' })).mode).toBe('markdown');
    expect(previewFor(art({ type: 'python-output' }), { output: { stdout: 'hi', files: ['a.png'] } })).toMatchObject({ mode: 'terminal', files: ['a.png'] });
    expect(previewFor(art({ type: 'web-preview', url: 'http://localhost:1' })).mode).toBe('web');
    expect(previewFor(art({ type: 'pdf', path: 'r.pdf', sizeBytes: 9 }))).toEqual({ mode: 'file', path: 'r.pdf', sizeBytes: 9 });
    expect(previewFor(art({ type: 'image', mimeType: 'image/png' }), { imageBase64: 'AAAA' })).toMatchObject({ mode: 'image', dataUrl: 'data:image/png;base64,AAAA' });
    expect(previewFor(art({ type: 'image', mimeType: 'text/html' }), { imageBase64: 'AAAA' }).mode).toBe('file');
  });
});
