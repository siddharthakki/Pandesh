/**
 * PDF export (audit D5): a Markdown or text report becomes a real PDF on this PC.
 *
 * The Markdown is rendered to a self-contained HTML page by the small renderer
 * below (every character is escaped; links become plain text; a CSP forbids any
 * fetch), and the page is printed by the Edge/Chrome binary Windows already has,
 * in headless mode with a throw-away profile. Nothing is installed and nothing
 * leaves the PC. The result is only reported as done after the file is verified:
 * it exists, starts with a PDF header and, when Poppler is installed, its text
 * layer is not empty.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLocalTool } from './documentOcr';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const EXPORTABLE_SOURCE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline Markdown on already-escaped text: code, bold, italic; links become "text (url)". */
function renderInline(raw: string): string {
  const codeSpans: string[] = [];
  let text = escapeHtml(raw).replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  text = text
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)]);
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** A deliberately small Markdown renderer: headings, paragraphs, lists, tables, quotes, code, rules. */
export function renderMarkdownToHtmlBody(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    if (/^```/.test(trimmed)) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i].trim()); i += 1) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
    if (heading) { flush(); out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(trimmed)) { flush(); out.push('<hr>'); continue; }
    if (trimmed.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      flush();
      const header = splitRow(trimmed);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      const cell = (tag: string, text: string, k: number) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${renderInline(text)}</${tag}>`;
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i].trim().includes('|'); i += 1) {
        rows.push(`<tr>${splitRow(lines[i]).map((c, k) => cell('td', c, k)).join('')}</tr>`);
      }
      i -= 1;
      out.push(`<table><thead><tr>${header.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    const listMatch = /^([-*+]|\d+[.)])\s+/.exec(trimmed);
    if (listMatch) {
      flush();
      const ordered = /\d/.test(listMatch[1]);
      const items: string[] = [];
      for (; i < lines.length; i += 1) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(`<li>${renderInline(m[2])}</li>`);
      }
      i -= 1;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && lines[i].trim().startsWith('>'); i += 1) quote.push(lines[i].trim().replace(/^>\s?/, ''));
      i -= 1;
      out.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return out.join('\n');
}

const STYLE = `@page{size:A4;margin:18mm 16mm}
body{font-family:"Segoe UI",Arial,sans-serif;font-size:10.5pt;line-height:1.45;color:#1d2330;margin:0}
h1{font-size:20pt;margin:0 0 6pt;color:#14213d;border-bottom:2px solid #14213d;padding-bottom:4pt}
h2{font-size:13.5pt;margin:14pt 0 5pt;color:#14213d}h3{font-size:11.5pt;margin:10pt 0 4pt}
p{margin:0 0 7pt}table{border-collapse:collapse;width:100%;margin:4pt 0 10pt}
th,td{border:1px solid #c9ced8;padding:4pt 7pt;text-align:left;vertical-align:top}
th{background:#eef1f6;font-weight:600}tr:nth-child(even) td{background:#f8f9fb}
code{font-family:Consolas,monospace;background:#f1f3f6;padding:0 2pt}pre{background:#f1f3f6;padding:6pt;white-space:pre-wrap}
blockquote{margin:0 0 8pt;padding-left:8pt;border-left:3px solid #c9ced8;color:#4a5160}hr{border:0;border-top:1px solid #c9ced8;margin:10pt 0}`;

export function renderReportHtml(markdown: string, title: string, plainText = false): string {
  const body = plainText ? `<pre style="font-family:inherit;white-space:pre-wrap;background:none">${escapeHtml(markdown)}</pre>` : renderMarkdownToHtmlBody(markdown);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>
${body}
</body></html>`;
}

export interface PdfVerification { bytes: number; pages: number | null; textChars: number | null }

export class PdfExportError extends Error {
  constructor(message: string, readonly reason: string) { super(message); }
}

/** Prints self-contained HTML to `outputPath` with a headless browser and verifies the file. */
export async function printHtmlToPdf(html: string, outputPath: string, options: {
  browserBin: string;
  pdftotext?: string | null;
  pdfinfo?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<PdfVerification> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-pdf-'));
  const tempPdf = path.join(work, 'out.pdf');
  try {
    const htmlFile = path.join(work, 'report.html');
    fs.writeFileSync(htmlFile, html, 'utf8');
    const run = await runLocalTool(options.browserBin, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-sync', '--disable-background-networking', '--disable-component-update', '--no-pdf-header-footer',
      `--user-data-dir=${path.join(work, 'profile')}`, `--print-to-pdf=${tempPdf}`, pathToFileURL(htmlFile).href,
    ], { timeoutMs: options.timeoutMs ?? 90_000, signal: options.signal });
    // A launcher may exit before the renderer has finished writing; give it a moment.
    for (let waited = 0; !fs.existsSync(tempPdf) && waited < 5_000; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!fs.existsSync(tempPdf)) {
      throw new PdfExportError(`the browser did not produce a PDF (exit ${run.code ?? 'none'}): ${run.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`.slice(0, 300), 'no_output');
    }
    const head = Buffer.alloc(5);
    const fd = fs.openSync(tempPdf, 'r');
    try { fs.readSync(fd, head, 0, 5, 0); } finally { fs.closeSync(fd); }
    if (head.toString('latin1') !== '%PDF-') throw new PdfExportError('the browser wrote a file that is not a PDF', 'not_pdf');
    let textChars: number | null = null;
    if (options.pdftotext) {
      const text = await runLocalTool(options.pdftotext, ['-enc', 'UTF-8', tempPdf, '-'], { timeoutMs: 30_000 }).catch(() => null);
      if (text && text.code === 0) {
        textChars = text.stdout.replace(/\s+/g, '').length;
        if (textChars === 0) throw new PdfExportError('the PDF was written but has no readable text', 'empty_pdf');
      }
    }
    let pages: number | null = null;
    if (options.pdfinfo) {
      const info = await runLocalTool(options.pdfinfo, [tempPdf], { timeoutMs: 30_000 }).catch(() => null);
      const m = info && info.code === 0 ? /^Pages:\s+(\d+)/m.exec(info.stdout) : null;
      if (m) pages = Number(m[1]);
    }
    fs.copyFileSync(tempPdf, outputPath);
    return { bytes: fs.statSync(outputPath).size, pages, textChars };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }
  }
}
