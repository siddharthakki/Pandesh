import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderMarkdownToHtmlBody } from '../runtime/documentExport';
import { createDocumentToolsAdapter } from '../runtime/documentToolsCapability';
import { resolveHostBrowserBin } from '../runtime/hostBrowserBin';
import { resolveWorkspaceRelativeArgs } from '../runtime/piAgentEngine';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-export-test-'));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

// The report the M4 re-run wrote with write_file (evidence/remediation-01a4d57/M4), reduced to its structure.
const CATERING_MD = `# Catering Project Report: Biryani Event

## Financial Overview
* **Total Revenue:** €730.00
* **Total Expenses:** €420.00
* **Net Profit:** €310.00

| Item | Quantity | Unit Price | Subtotal |
| :--- | :--- | :--- | ---: |
| Chicken Biryani | 40 | €12 | €480 |
| Vegetable Biryani | 25 | €10 | €250 |
`;

const run = (adapter: ReturnType<typeof createDocumentToolsAdapter>, name: string, args: Record<string, unknown>) =>
  adapter.run({ id: 't', name, arguments: args } as any, { cwd: process.cwd() });

describe('renderMarkdownToHtmlBody', () => {
  it('renders headings, lists, bold and tables', () => {
    const html = renderMarkdownToHtmlBody(CATERING_MD);
    expect(html).toContain('<h1>Catering Project Report: Biryani Event</h1>');
    expect(html).toContain('<li><strong>Total Revenue:</strong> €730.00</li>');
    expect(html).toContain('<th>Item</th>');
    expect(html).toContain('<td style="text-align:right">€480</td>');
  });

  it('escapes markup and turns links into plain text (nothing can be fetched)', () => {
    const html = renderMarkdownToHtmlBody('<script>alert(1)</script> see [site](https://example.com) ![x](http://evil/p.png)');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/<a |<img /);
    expect(html).toContain('site (https://example.com)');
  });

  it('leaves underscores inside file names alone', () => {
    expect(renderMarkdownToHtmlBody('saved as catering_report_final.pdf')).not.toContain('<em>');
  });
});

describe('resolveWorkspaceRelativeArgs (audit D10)', () => {
  it('resolves relative file arguments against the selected workspace, not the install folder', () => {
    const ws = path.join(work, 'ws');
    expect(resolveWorkspaceRelativeArgs({ path: 'catering_report.md', other: 'x' }, ws)).toEqual({ path: path.join(ws, 'catering_report.md'), other: 'x' });
    expect(resolveWorkspaceRelativeArgs({ source: 'a.md', output: 'out/a.pdf' }, ws)).toEqual({ source: path.join(ws, 'a.md'), output: path.join(ws, 'out', 'a.pdf') });
  });

  it('leaves absolute paths, URLs and calls without a workspace unchanged', () => {
    const abs = path.join(work, 'x.md');
    const args = { path: abs, url: 'https://example.com/a' };
    expect(resolveWorkspaceRelativeArgs(args, path.join(work, 'ws'))).toBe(args);
    const rel = { path: 'x.md' };
    expect(resolveWorkspaceRelativeArgs(rel, null)).toBe(rel);
  });

  it('document_read refuses a relative path instead of resolving it against the process folder', async () => {
    const result = await run(createDocumentToolsAdapter({ browserBin: null }), 'document_read', { path: 'catering_report.md' });
    expect(result.status).toBe('failed');
    expect(result.output).toMatch(/relative path/);
  });
});

describe('export_document_pdf (audit D5)', () => {
  const browser = resolveHostBrowserBin();

  it('refuses bad arguments without writing anything', async () => {
    const adapter = createDocumentToolsAdapter({ browserBin: browser ?? 'missing-browser' });
    fs.writeFileSync(path.join(work, 'r.docx'), 'x');
    expect((await run(adapter, 'export_document_pdf', {})).output).toMatch(/exactly one/);
    expect((await run(adapter, 'export_document_pdf', { markdown: '# x' })).output).toMatch(/"output" is required/);
    expect((await run(adapter, 'export_document_pdf', { source: path.join(work, 'r.docx') })).resultCategory).toBe('pdf_export_unsupported_source');
    expect((await run(adapter, 'export_document_pdf', { markdown: '# x', output: path.join(work, 'r.txt') })).output).toMatch(/must end in \.pdf/);
    expect((await run(adapter, 'export_document_pdf', { markdown: '# x', output: 'r.pdf' })).output).toMatch(/relative path/);
  });

  it('reports unavailable when no browser exists', async () => {
    const result = await run(createDocumentToolsAdapter({ browserBin: null }), 'export_document_pdf', { markdown: '# x', output: path.join(work, 'none.pdf') });
    expect(result.resultCategory).toBe('pdf_export_unavailable');
    expect(fs.existsSync(path.join(work, 'none.pdf'))).toBe(false);
  });

  it.skipIf(!browser)('prints a Markdown file to a verified PDF next to it, and never overwrites silently', async () => {
    const source = path.join(work, 'catering_report.md');
    fs.writeFileSync(source, CATERING_MD);
    const adapter = createDocumentToolsAdapter({ browserBin: browser });
    const result = await run(adapter, 'export_document_pdf', { source });
    const pdf = path.join(work, 'catering_report.pdf');
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain(`Saved PDF: ${pdf}`);
    expect(fs.readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const before = fs.statSync(pdf).mtimeMs;
    const again = await run(adapter, 'export_document_pdf', { source });
    expect(again.resultCategory).toBe('pdf_export_exists');
    expect(fs.statSync(pdf).mtimeMs).toBe(before);
  }, 120_000);
});
