/**
 * Writes or changes a Design workshop page with the conversation's own LOCAL model (Ollama structured output; never
 * a cloud model). The chat model only passes the user's words ("a landing page with a heading and a contact
 * button", "make the heading larger"); this call has one job and a JSON schema to fill, and Core checks the result
 * (core/shared/workshop/design.ts) before anything is saved.
 */
import { applyDesignEdits, checkDesignHtml, designTitle } from '../shared/workshop/design';
import { DEFAULT_OLLAMA_URL } from './modelBackend';

export interface WriterOptions {
  model: string;
  ollamaUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  numCtx?: number;
  onStage?: (stage: string) => void;
}

async function askJson(system: string, user: string, schema: unknown, options: WriterOptions, history: Array<{ role: string; content: string }> = []): Promise<{ ok: true; value: Record<string, unknown>; raw: string } | { ok: false; error: string }> {
  const url = `${(options.ollamaUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '')}/api/chat`;
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal ?? AbortSignal.timeout(240_000),
      body: JSON.stringify({ model: options.model, stream: false, think: false, format: schema, options: { temperature: 0.3, num_ctx: options.numCtx ?? 32_768 }, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: user }] }),
    });
    if (!res.ok) return { ok: false, error: `the local model answered ${res.status}` };
    const raw = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
    try { return { ok: true, value: JSON.parse(raw) as Record<string, unknown>, raw }; } catch { return { ok: false, error: 'the answer was not JSON' }; }
  } catch (err) {
    return { ok: false, error: options.signal?.aborted ? 'cancelled' : `the local model did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const PAGE_RULES = 'You write one self-contained HTML5 page: all CSS inline in a <style> element, no external URLs (no CDN, no web fonts, no remote images; use system fonts and CSS shapes or inline SVG), responsive (a mobile-first layout with a max-width container), accessible (semantic headings, labelled buttons, good contrast). No script unless the request needs behaviour. Answer only with JSON matching the schema.';

export async function writeDesign(description: string, options: WriterOptions): Promise<{ ok: true; html: string; title: string; warnings: string[] } | { ok: false; error: string }> {
  const schema = { type: 'object', properties: { title: { type: 'string' }, html: { type: 'string' } }, required: ['title', 'html'] };
  options.onStage?.(`Writing the page with ${options.model} on this PC`);
  let history: Array<{ role: string; content: string }> = [];
  let last = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await askJson(PAGE_RULES, `Page: ${description.slice(0, 1_000)}`, schema, options, history);
    if (!r.ok) return r;
    const html = String(r.value.html ?? '');
    const check = checkDesignHtml(html);
    if (check.ok) return { ok: true, html, title: String(r.value.title ?? '').trim().slice(0, 120) || designTitle(html), warnings: check.warnings };
    last = check.errors.join('; ');
    history = [{ role: 'assistant', content: r.raw.slice(0, 6_000) }, { role: 'user', content: `That page cannot be shown: ${last}. Answer again with the whole JSON.` }];
  }
  return { ok: false, error: last };
}

export async function reviseDesign(html: string, instruction: string, options: WriterOptions): Promise<{ ok: true; html: string; summary: string } | { ok: false; error: string }> {
  const schema = { type: 'object', properties: { replacements: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } } }, required: ['replacements'] };
  const system = `${PAGE_RULES}\nYou change an existing page as asked, with the smallest exact edits: each "find" is text copied exactly from the page (unique, a whole line or CSS rule is best) and "replace" is its new text.`;
  options.onStage?.(`Changing the page with ${options.model} on this PC`);
  let history: Array<{ role: string; content: string }> = [];
  let last = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = await askJson(system, `Page:\n${html.slice(0, 60_000)}\n\nChange: ${instruction.slice(0, 500)}`, schema, options, history);
    if (!r.ok) return r;
    const applied = applyDesignEdits(html, { replacements: r.value.replacements });
    if (applied.ok) return { ok: true, html: applied.html, summary: applied.summary };
    last = applied.errors.join('; ');
    history = [{ role: 'assistant', content: r.raw.slice(0, 6_000) }, { role: 'user', content: `Pandesh could not apply that: ${last}. Answer again.` }];
  }
  return { ok: false, error: last };
}
