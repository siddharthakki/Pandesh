import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  STATIC_HTML_CONFIDENCE,
  isStaticHtmlPath,
  summarizeStaticHtmlCheck,
  validateStaticHtml,
} from '../runtime/staticHtmlValidation';

const GOOD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>t</title><style>body{margin:0}</style></head>
<body><h1>Hi</h1><script>const answer = 42; document.title = String(answer);</script></body></html>`;

describe('static HTML structural validation (no browser, no new dependency)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-html-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const write = (name: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };

  it('recognises HTML paths only', () => {
    expect(isStaticHtmlPath('index.html')).toBe(true);
    expect(isStaticHtmlPath('dist/App.HTM')).toBe(true);
    expect(isStaticHtmlPath('app.ts')).toBe(false);
    expect(isStaticHtmlPath('notes.html.txt')).toBe(false);
  });

  it('passes a sound page and says it is structural, not a behavioural test', () => {
    write('index.html', GOOD);
    const result = validateStaticHtml(dir, 'index.html');
    expect(result.structurallySound).toBe(true);
    expect(result.examined).toContain('syntax of 1 inline script');
    const summary = summarizeStaticHtmlCheck(result);
    expect(summary).toContain(STATIC_HTML_CONFIDENCE);
    expect(summary).toContain('no structural problems found');
    expect(summary).toContain('not a behavioural test');
    expect(summary).not.toMatch(/\bpassed\b/i);
  });

  it('rejects a missing, empty or outside-the-workspace file', () => {
    expect(validateStaticHtml(dir, 'missing.html').findings).toContain('the file does not exist');
    write('empty.html', '');
    expect(validateStaticHtml(dir, 'empty.html').findings).toContain('the file is empty');
    expect(validateStaticHtml(dir, '../elsewhere.html').structurallySound).toBe(false);
  });

  it('finds a syntax error in an inline script without executing it', () => {
    const marker = path.join(dir, 'ran.txt');
    write('bad.html', `<html><body><script>require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); const = ;</script></body></html>`);
    const result = validateStaticHtml(dir, 'bad.html');
    expect(result.structurallySound).toBe(false);
    expect(result.findings.some(finding => finding.startsWith('inline script 1 has a syntax error'))).toBe(true);
    // Compiled only: nothing ran, even the valid statements before the error.
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not run valid inline scripts either', () => {
    const marker = path.join(dir, 'ran.txt');
    write('ok.html', `<html><body><script>globalThis.__kkdRan = true; require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');</script></body></html>`);
    expect(validateStaticHtml(dir, 'ok.html').structurallySound).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect((globalThis as Record<string, unknown>).__kkdRan).toBeUndefined();
  });

  it('flags a missing document skeleton and unbalanced script/style tags', () => {
    write('frag.html', '<div>just a fragment</div>');
    expect(validateStaticHtml(dir, 'frag.html').findings).toEqual(expect.arrayContaining(['no <html> element', 'no <body> element']));
    write('open.html', '<html><body><script>var a = 1;</body></html>');
    expect(validateStaticHtml(dir, 'open.html').findings.some(finding => finding.includes('unbalanced <script>'))).toBe(true);
  });

  it('checks local asset references and ignores URLs, anchors and data URIs', () => {
    write('page.html', `<html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://cdn.example/x.css"></head>
<body><script src="app.js"></script><script src="//cdn.example/y.js"></script><a href="#top">x</a><script src="data:text/javascript,1"></script></body></html>`);
    let result = validateStaticHtml(dir, 'page.html');
    expect(result.findings).toEqual(expect.arrayContaining(['referenced file is missing: style.css', 'referenced file is missing: app.js']));
    expect(result.findings.some(finding => finding.includes('cdn.example') || finding.includes('data:'))).toBe(false);
    write('style.css', 'body{}');
    write('app.js', 'var a;');
    result = validateStaticHtml(dir, 'page.html');
    expect(result.structurallySound).toBe(true);
  });

  it('does not syntax-check module scripts or JSON data blocks, and says so', () => {
    write('mod.html', `<html><body><script type="module">import x from './x.js'; export const y = 1;</script><script type="application/json">{"a": 1}</script></body></html>`);
    const result = validateStaticHtml(dir, 'mod.html');
    expect(result.structurallySound).toBe(true);
    expect(result.examined).toContain('1 module script not syntax-checked');
  });
});
