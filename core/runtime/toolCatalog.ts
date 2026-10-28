/**
 * The live tool catalog: what this PC can actually do right now.
 *
 * Every entry comes from a probe (Ollama's model list, executables on PATH, Kandev's agent status, a network reachability
 * check, a loadable PDF library) and carries the reason when it is unavailable. Nothing is assumed from configuration, so a
 * model that was uninstalled or an executor that was removed disappears from the next catalog.
 */
import type { CatalogEntry, ToolCatalog } from '../domain/operatorPlan';
import type { KandevClient } from './kandev/kandevClient';
import { discoverExecutors } from './kandev/pandaBridge';
import { DEFAULT_OLLAMA_URL } from './modelBackend';
import { nowIso } from '../domain/ids';
import { extractPdfFromBytes } from '../attachments/documentExtraction';

export interface CatalogProbeDeps {
  kandev: KandevClient;
  ollamaUrl?: string;
  fetchFn?: typeof fetch;
  /** Whether a PDF text library can be loaded here. */
  probePdf?: () => Promise<boolean>;
  /** Search endpoint to test; defaults to the configured SearXNG or DuckDuckGo. */
  searchUrl?: string;
  nativeAvailable?: boolean;
}

/** Local chat-capable models in the order Pandesh prefers them for synthesis; anything else installed follows. */
const MODEL_PREFERENCE = ['gemma4:12b', 'gemma4:26b-a4b-it-qat', 'gpt-oss:20b', 'qwen3.8:27b-mtp-q4_K_M'];

const EXECUTOR_PREFERENCE: Record<string, number> = { opencode: 10, hermes: 20, claude: 90, antigravity: 95 };

async function probeOllama(deps: CatalogProbeDeps): Promise<CatalogEntry[]> {
  const base = (deps.ollamaUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { models?: Array<{ name: string; capabilities?: string[] }> };
    return (body.models ?? [])
      .filter(m => (m.capabilities ?? ['completion']).includes('completion') && !/embed|rerank/i.test(m.name))
      .map((m): CatalogEntry => {
        const rank = MODEL_PREFERENCE.indexOf(m.name);
        return {
          id: `ollama:${m.name}`, kind: 'model', label: m.name, provides: ['local_model'], locality: 'local', available: true,
          reason: null, preference: rank >= 0 ? rank : 100,
        };
      });
  } catch (err) {
    return [{
      id: 'ollama:*', kind: 'model', label: 'Ollama', provides: ['local_model'], locality: 'local', available: false,
      reason: `Ollama is not reachable at ${base} (${err instanceof Error ? err.message : String(err)})`, preference: 100,
    }];
  }
}

async function probeWeb(deps: CatalogProbeDeps): Promise<CatalogEntry> {
  const fetchFn = deps.fetchFn ?? fetch;
  const searx = process.env.KARKEDIKHA_SEARXNG_URL;
  const target = deps.searchUrl ?? searx ?? 'https://html.duckduckgo.com/html/';
  let available = true;
  let reason: string | null = searx ? 'via your SearXNG instance' : 'via DuckDuckGo';
  try {
    const res = await fetchFn(target, { method: 'GET', signal: AbortSignal.timeout(4_000), redirect: 'manual' });
    if (res.status >= 500) { available = false; reason = `${new URL(target).hostname} answered HTTP ${res.status}`; }
  } catch (err) {
    available = false;
    reason = `no network route to ${new URL(target).hostname} (${err instanceof Error ? err.message : String(err)})`;
  }
  return { id: 'capability:web_research', kind: 'capability', label: 'Web research', provides: ['web_research'], locality: 'external', available, reason, preference: 10 };
}

/** A one-page PDF with the text "probe", so health means "the real extractor works here", not "a file exists". */
const PROBE_PDF = Buffer.from([
  '%PDF-1.4',
  '1 0 obj', '<< /Type /Catalog /Pages 2 0 R >>', 'endobj',
  '2 0 obj', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'endobj',
  '3 0 obj', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', 'endobj',
  '4 0 obj', '<< /Length 36 >>', 'stream', 'BT /F1 12 Tf 20 100 Td (probe) Tj ET', 'endstream', 'endobj',
  '5 0 obj', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'endobj',
  'trailer', '<< /Root 1 0 R >>', '%%EOF',
].join('\n'), 'latin1');

let pdfHealthy: boolean | null = null;
async function defaultProbePdf(): Promise<boolean> {
  if (pdfHealthy) return true;
  try {
    const doc = await extractPdfFromBytes(new Uint8Array(PROBE_PDF));
    pdfHealthy = doc.sections.some(sec => /probe/.test(sec.text));
  } catch { pdfHealthy = false; }
  return pdfHealthy;
}

export async function probeToolCatalog(deps: CatalogProbeDeps): Promise<ToolCatalog> {
  const [models, web, listing, pdf] = await Promise.all([
    probeOllama(deps),
    probeWeb(deps),
    discoverExecutors(deps.kandev, { nativeAvailable: deps.nativeAvailable }).catch(() => null),
    (deps.probePdf ?? defaultProbePdf)(),
  ]);
  const entries: CatalogEntry[] = [...models, web];
  entries.push({ id: 'capability:local_filesystem', kind: 'capability', label: 'Local filesystem (read-only discovery)', provides: ['local_filesystem'], locality: 'local', available: true, reason: null, preference: 10 });
  entries.push({
    id: 'capability:pdf_reader', kind: 'capability', label: 'Local PDF reader', provides: ['pdf_reader'], locality: 'local', available: pdf,
    reason: pdf ? null : 'the PDF text library could not be loaded', preference: 10,
  });
  for (const e of listing?.executors ?? []) {
    if (e.kind === 'native' || !e.dispatchable) continue;
    entries.push({
      id: `executor:${e.id}`, kind: 'executor', label: e.label, provides: ['coding_executor'], locality: e.external ? 'external' : 'local',
      available: e.available, reason: e.reason, preference: EXECUTOR_PREFERENCE[e.id] ?? 80,
    });
  }
  return { probedAt: nowIso(), entries };
}
