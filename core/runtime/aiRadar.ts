/**
 * AI Radar: what changed in the local-AI tools Pandesh depends on or could use, compared with what is installed on this
 * PC and with what Pandesh already does.
 *
 * Deterministic and local-first. Sources are official GitHub releases and published security advisories for a curated
 * watchlist; nothing private is sent anywhere (only public GET requests for public repositories). Every finding is
 * classified by fixed rules — no model decides what is "new" or "relevant":
 *
 *   already_implemented  Pandesh already uses it and the installed version is current
 *   update_available     Pandesh uses it and a newer stable release than the installed one exists
 *   worth_testing        an integration Pandesh supports but is not installed, or a close alternative to one it uses
 *   missing_capability   a capability Pandesh does not have yet
 *   not_relevant         does not fit this PC (platform, hardware) or Pandesh's scope
 *
 * State (findings, first/last seen, the user's decisions, scan history) lives in <dataDir>/ai-radar.json. Nothing is
 * installed or upgraded here; "Prepare update" only ever prepares.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareVersions, isPrerelease, normalizeVersion } from './software/updates';

export type RadarClass = 'already_implemented' | 'update_available' | 'worth_testing' | 'missing_capability' | 'not_relevant';
export type RadarStatus = 'new' | 'seen' | 'investigating' | 'update_prepared' | 'dismissed';
export type Region = 'Americas' | 'Europe' | 'Asia-Pacific';

export interface RadarSource {
  id: string;
  repo: string;
  name: string;
  region: Region;
  category: 'local_runtime' | 'inference_engine' | 'coding_agent' | 'agent_framework' | 'mcp' | 'model_library';
  /** How Pandesh relates to it today. */
  pandesh: 'core' | 'integrated' | 'optional' | 'covered_by' | 'none';
  /** One sentence: what Pandesh does with it, or which existing capability already covers it. */
  note: string;
  /** Installed software names that are this tool. */
  match: RegExp;
  /** Fixed reason it does not fit this PC, when it does not. */
  notRelevant?: string;
}

export const RADAR_SOURCES: readonly RadarSource[] = [
  { id: 'ollama', repo: 'ollama/ollama', name: 'Ollama', region: 'Americas', category: 'local_runtime', pandesh: 'core', note: 'Pandesh runs every local model through Ollama.', match: /^ollama(\.ollama)?$|^ollama version\b/i },
  { id: 'llama-cpp', repo: 'ggml-org/llama.cpp', name: 'llama.cpp', region: 'Europe', category: 'inference_engine', pandesh: 'covered_by', note: 'Ollama is built on llama.cpp, so engine improvements reach Pandesh through Ollama releases.', match: /^llama[.-]?cpp$|^ggml\.llamacpp$|^llama-server$/i },
  { id: 'aider', repo: 'Aider-AI/aider', name: 'Aider', region: 'Americas', category: 'coding_agent', pandesh: 'integrated', note: 'Aider is Pandesh’s local external coding agent (delegate_to_coding_agent).', match: /^aider(-chat)?$/i },
  { id: 'opencode', repo: 'sst/opencode', name: 'OpenCode', region: 'Americas', category: 'coding_agent', pandesh: 'optional', note: 'OpenCode is an optional coding engine (delegate_to_opencode).', match: /^opencode(-ai)?$|^@opencode\/cli$/i },
  { id: 'hermes', repo: 'NousResearch/hermes-agent', name: 'Hermes Agent', region: 'Americas', category: 'agent_framework', pandesh: 'optional', note: 'Hermes is an opt-in coding agent, off by default.', match: /^hermes(-agent)?$/i },
  { id: 'qwen-code', repo: 'QwenLM/qwen-code', name: 'Qwen Code', region: 'Asia-Pacific', category: 'coding_agent', pandesh: 'none', note: 'A terminal coding agent tuned for Qwen models; Pandesh has no adapter for it yet.', match: /^qwen-code$|^@qwen-code\/qwen-code$/i },
  { id: 'codex', repo: 'openai/codex', name: 'Codex CLI', region: 'Americas', category: 'coding_agent', pandesh: 'optional', note: 'Codex CLI is a supported coding agent but switched off (apply_patch issue on 0.156).', match: /^codex$|^@openai\/codex$/i },
  { id: 'goose', repo: 'block/goose', name: 'Goose', region: 'Americas', category: 'agent_framework', pandesh: 'none', note: 'A local agent framework with MCP extensions; overlaps with Pandesh’s own agents.', match: /^goose$/i },
  { id: 'mcp', repo: 'modelcontextprotocol/modelcontextprotocol', name: 'Model Context Protocol', region: 'Americas', category: 'mcp', pandesh: 'none', note: 'Pandesh lists MCP servers but has no MCP client registry yet.', match: /^$/ },
  { id: 'transformers', repo: 'huggingface/transformers', name: 'Transformers', region: 'Europe', category: 'model_library', pandesh: 'covered_by', note: 'Pandesh runs models through Ollama; Transformers matters only for models Ollama does not package yet.', match: /^transformers$/i },
  { id: 'vllm', repo: 'vllm-project/vllm', name: 'vLLM', region: 'Americas', category: 'inference_engine', pandesh: 'none', note: 'A high-throughput server engine.', match: /^vllm$/i, notRelevant: 'vLLM targets Linux servers; on this Windows PC it runs only under WSL, and Pandesh is single-user.' },
  { id: 'mistral-inference', repo: 'mistralai/mistral-inference', name: 'Mistral inference', region: 'Europe', category: 'inference_engine', pandesh: 'covered_by', note: 'Mistral models are used through Ollama.', match: /^mistral-inference$/i },
];

export interface RadarRelease { tag: string; name: string; publishedAt: string; url: string; notes: string }
export interface RadarAdvisory { id: string; severity: string | null; summary: string; url: string; publishedAt: string | null }

export interface RadarFinding {
  id: string;
  sourceId: string;
  name: string;
  repo: string;
  region: Region;
  category: RadarSource['category'];
  kind: 'release' | 'security';
  title: string;
  url: string;
  publishedAt: string | null;
  installed: string | null;
  available: string | null;
  classification: RadarClass;
  urgent: boolean;
  why: string;
  action: string;
  status: RadarStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  decisions: Array<{ at: string; action: 'investigate' | 'prepare_update' | 'dismiss'; note: string | null }>;
}

export interface RadarState {
  findings: Record<string, RadarFinding>;
  scans: Array<{ at: string; newFindings: number; errors: string[]; urgent: number }>;
  /** Last successful GitHub responses per repo: GitHub allows 60 unauthenticated requests an hour. */
  cache?: Record<string, { at: string; release: RadarRelease | null; advisories: RadarAdvisory[] }>;
}

/** A repo read within this window is not fetched again; the stored answer is reclassified against what is installed now. */
export const RADAR_CACHE_MS = 6 * 3_600_000;

export interface InstalledTool { name: string; version: string | null }

const FILE = 'ai-radar.json';
export function readRadarState(dataDir: string): RadarState {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) as RadarState; } catch { return { findings: {}, scans: [] }; }
}
function writeRadarState(dataDir: string, state: RadarState): void {
  const file = path.join(dataDir, FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  fs.renameSync(`${file}.tmp`, file);
}

/** Pure classification of one release against what is installed and what Pandesh does. */
export function classifyRelease(source: RadarSource, release: RadarRelease, installed: string | null): { classification: RadarClass; why: string; action: string } {
  if (source.notRelevant) return { classification: 'not_relevant', why: source.notRelevant, action: 'No action.' };
  if (source.pandesh === 'covered_by') return { classification: 'already_implemented', why: source.note, action: 'No action; watch the release notes of the tool that covers it.' };
  if (source.pandesh === 'core' || source.pandesh === 'integrated' || source.pandesh === 'optional') {
    if (!installed) {
      return source.pandesh === 'core'
        ? { classification: 'update_available', why: `${source.name} is required by Pandesh but was not found installed.`, action: `Install ${source.name} ${release.tag}.` }
        : { classification: 'worth_testing', why: `${source.note} It is not installed here.`, action: `Try ${source.name} ${release.tag} on a test workspace before enabling it.` };
    }
    const cmp = compareVersions(installed, release.tag);
    if (cmp !== null && cmp < 0) return { classification: 'update_available', why: `${source.note} Installed ${installed}, released ${normalizeVersion(release.tag)}.`, action: `Prepare an update of ${source.name} to ${normalizeVersion(release.tag)} (read the notes first; nothing is installed automatically).` };
    return { classification: 'already_implemented', why: `${source.note} Installed ${installed} is current${cmp === 1 ? ' (newer than the latest GitHub release)' : ''}.`, action: 'No action.' };
  }
  return source.category === 'mcp' || source.category === 'agent_framework'
    ? { classification: 'missing_capability', why: source.note, action: `Investigate whether ${source.name} would fill a gap in Pandesh, and what it would take.` }
    : { classification: 'worth_testing', why: source.note, action: `Compare ${source.name} with what Pandesh uses today on one real task.` };
}

/** A security advisory is urgent only when the affected tool is installed here and the advisory is recent. */
export function classifyAdvisory(source: RadarSource, advisory: RadarAdvisory, installed: string | null, now: Date): { urgent: boolean; why: string; action: string; classification: RadarClass } {
  const recent = advisory.publishedAt ? now.getTime() - Date.parse(advisory.publishedAt) < 30 * 86_400_000 : false;
  const severe = /^(high|critical)$/i.test(advisory.severity ?? '');
  if (!installed) return { urgent: false, classification: source.notRelevant ? 'not_relevant' : 'worth_testing', why: `${advisory.severity ?? 'Unrated'} advisory for ${source.name}, which is not installed here.`, action: 'No action unless you install it; check that the fixed version is used then.' };
  return {
    urgent: recent && severe,
    classification: 'update_available',
    why: `${advisory.severity ?? 'Unrated'} advisory for ${source.name}; installed ${installed}. Check whether the installed version is in the affected range.`,
    action: `Read the advisory, then prepare an update of ${source.name} if ${installed} is affected.`,
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetchFn: Fetch, url: string): Promise<unknown> {
  const res = await fetchFn(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'pandesh-ai-radar' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub rate limit (${res.status})`);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export async function latestStableRelease(fetchFn: Fetch, repo: string): Promise<RadarRelease | null> {
  const list = (await getJson(fetchFn, `https://api.github.com/repos/${repo}/releases?per_page=10`)) as Array<Record<string, unknown>>;
  for (const r of list ?? []) {
    const tag = String(r.tag_name ?? '');
    if (r.draft || r.prerelease || isPrerelease(tag) || /^sdk-/i.test(tag)) continue;
    return { tag, name: String(r.name || tag), publishedAt: String(r.published_at ?? ''), url: String(r.html_url ?? ''), notes: String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 400) };
  }
  return null;
}

export async function recentAdvisories(fetchFn: Fetch, repo: string): Promise<RadarAdvisory[]> {
  const list = (await getJson(fetchFn, `https://api.github.com/repos/${repo}/security-advisories?per_page=5&state=published`)) as Array<Record<string, unknown>>;
  return (list ?? []).map((a) => ({ id: String(a.ghsa_id ?? a.id), severity: (a.severity as string) ?? null, summary: String(a.summary ?? ''), url: String(a.html_url ?? ''), publishedAt: (a.published_at as string) ?? null }));
}

export interface RadarScanResult { scannedAt: string; newFindings: RadarFinding[]; urgent: RadarFinding[]; errors: string[]; state: RadarState }

/**
 * One scan: fetch, classify, merge into the stored state. A finding already seen keeps its id, its status and the
 * user's decisions; only its "installed" view and classification are refreshed. A dismissed finding stays dismissed.
 */
export async function scanAiRadar(input: { dataDir: string; installed: InstalledTool[]; fetchFn?: Fetch; now?: Date; sources?: readonly RadarSource[]; force?: boolean }): Promise<RadarScanResult> {
  const fetchFn = input.fetchFn ?? (fetch as Fetch);
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const state = readRadarState(input.dataDir);
  const errors: string[] = [];
  const newFindings: RadarFinding[] = [];
  const urgent: RadarFinding[] = [];
  const installedFor = (s: RadarSource) => input.installed.find((t) => s.match.test(t.name.trim()))?.version ?? null;
  const upsert = (f: Omit<RadarFinding, 'status' | 'firstSeenAt' | 'lastSeenAt' | 'decisions'>) => {
    const prev = state.findings[f.id];
    const merged: RadarFinding = prev
      ? { ...prev, installed: f.installed, classification: f.classification, why: f.why, action: f.action, urgent: f.urgent, lastSeenAt: at }
      : { ...f, status: 'new', firstSeenAt: at, lastSeenAt: at, decisions: [] };
    state.findings[f.id] = merged;
    if (!prev) newFindings.push(merged);
    if (merged.urgent && merged.status !== 'dismissed' && !prev) urgent.push(merged);
  };
  for (const source of input.sources ?? RADAR_SOURCES) {
    const installed = installedFor(source);
    const cached = state.cache?.[source.repo];
    const fresh = cached && !input.force && now.getTime() - Date.parse(cached.at) < RADAR_CACHE_MS ? cached : null;
    const entry: { release: RadarRelease | null; advisories: RadarAdvisory[] | null } = { release: fresh?.release ?? null, advisories: fresh?.advisories ?? null };
    try {
      const release = fresh ? fresh.release : await latestStableRelease(fetchFn, source.repo);
      entry.release = release;
      if (release) {
        const c = classifyRelease(source, release, installed);
        upsert({ id: `${source.id}@${release.tag}`, sourceId: source.id, name: source.name, repo: source.repo, region: source.region, category: source.category, kind: 'release', title: `${source.name} ${release.tag}`, url: release.url, publishedAt: release.publishedAt || null, installed, available: normalizeVersion(release.tag) ?? release.tag, urgent: false, ...c });
      }
    } catch (err) { errors.push(`${source.repo} releases: ${err instanceof Error ? err.message : String(err)}`); }
    try {
      const advisories = fresh ? fresh.advisories : await recentAdvisories(fetchFn, source.repo);
      entry.advisories = advisories;
      for (const adv of advisories.slice(0, 3)) {
        if (adv.publishedAt && now.getTime() - Date.parse(adv.publishedAt) > 180 * 86_400_000) continue;
        const c = classifyAdvisory(source, adv, installed, now);
        upsert({ id: `${source.id}#${adv.id}`, sourceId: source.id, name: source.name, repo: source.repo, region: source.region, category: source.category, kind: 'security', title: `${source.name}: ${adv.summary}`.slice(0, 200), url: adv.url, publishedAt: adv.publishedAt, installed, available: null, ...c });
      }
    } catch (err) { errors.push(`${source.repo} advisories: ${err instanceof Error ? err.message : String(err)}`); }
    if (!fresh && entry.release !== undefined && entry.advisories) (state.cache ??= {})[source.repo] = { at, release: entry.release, advisories: entry.advisories };
  }
  // Older releases of the same tool are superseded by the newest one: they stop counting as open findings.
  for (const f of Object.values(state.findings)) {
    if (f.kind !== 'release' || f.status === 'dismissed') continue;
    const newest = Object.values(state.findings).filter((g) => g.kind === 'release' && g.sourceId === f.sourceId).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0];
    if (newest && newest.id !== f.id && f.status === 'new') f.status = 'seen';
  }
  state.scans = [{ at, newFindings: newFindings.length, errors, urgent: urgent.length }, ...state.scans].slice(0, 60);
  writeRadarState(input.dataDir, state);
  return { scannedAt: at, newFindings, urgent, errors, state };
}

/** Records the user's decision. Investigate / Prepare update are carried out by the caller as a normal, governed chat. */
export function decideRadarFinding(dataDir: string, id: string, action: 'investigate' | 'prepare_update' | 'dismiss', note: string | null = null): RadarFinding {
  const state = readRadarState(dataDir);
  const f = state.findings[id];
  if (!f) throw new Error(`no radar finding '${id}'`);
  f.decisions.push({ at: new Date().toISOString(), action, note });
  f.status = action === 'dismiss' ? 'dismissed' : action === 'investigate' ? 'investigating' : 'update_prepared';
  writeRadarState(dataDir, state);
  return f;
}

/** The chat request a decision opens. It goes through Core like any user message: research consent and approvals apply. */
export function radarRequestText(f: RadarFinding, action: 'investigate' | 'prepare_update'): string {
  if (action === 'investigate') {
    return `Ask your Research specialist to investigate ${f.title} (${f.url}${f.publishedAt ? `, published ${f.publishedAt.slice(0, 10)}` : ''}): what changed, whether it matters for a local-first Windows assistant on an RTX 3090 with 24 GB, and the risks. Use official sources and cite them.`;
  }
  return `Prepare, but do not run, an update plan for ${f.name} from the installed ${f.installed ?? 'version'} to ${f.available ?? 'the latest release'} on this PC (${f.url}): the exact command, what could break, and how to roll back. Do not install or change anything.`;
}

/** One digest message for the new findings of a scan, grouped by class; null when nothing new is worth a message. */
export function renderRadarDigest(newFindings: RadarFinding[]): string | null {
  const shown = newFindings.filter((f) => f.classification !== 'not_relevant' && f.classification !== 'already_implemented');
  if (!shown.length) return null;
  const label: Record<RadarClass, string> = { update_available: 'Update available', worth_testing: 'Worth testing', missing_capability: 'Missing capability', already_implemented: 'Already implemented', not_relevant: 'Not relevant' };
  const lines = ['**AI Radar — new since the last scan**', ''];
  for (const cls of ['update_available', 'missing_capability', 'worth_testing'] as RadarClass[]) {
    const group = shown.filter((f) => f.classification === cls);
    if (!group.length) continue;
    lines.push(`**${label[cls]}**`);
    for (const f of group) lines.push(`- ${f.urgent ? '⚠ ' : ''}[${f.title}](${f.url})${f.publishedAt ? ` · ${f.publishedAt.slice(0, 10)}` : ''} · ${f.region}${f.installed ? ` · installed ${f.installed}` : ''} — ${f.action}`);
    lines.push('');
  }
  lines.push('_Open AI Radar to investigate, prepare an update or dismiss. Nothing is installed automatically._');
  return lines.join('\n');
}
