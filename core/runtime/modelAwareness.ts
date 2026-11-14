/**
 * Pandesh's live knowledge of the models on this PC: which are installed, which are loaded right now, which one is
 * active for this turn, what each can do, and whether it fits this PC's graphics memory.
 *
 * It adds no inventory of its own. Installed models and their capabilities come from `localInstalledModels` (Ollama's
 * own /api/tags + /api/show, the same data `capabilityInventory` and escalation already use); this module adds only
 * what those do not carry: what is loaded right now (/api/ps) and which model is selected.
 *
 * Six words are kept apart, because blurring them is how a model comes to promise what it cannot do:
 *   installed   the model is on this PC
 *   loaded      it is in memory right now (using it costs no load)
 *   selected    it is the model running this turn
 *   available   the model server answers
 *   usable      it reports the capability a task needs and fits this PC's graphics memory
 *   authorized  the user permits the action. NOT a property of a model: a model that can see is not permitted to read a
 *               private screen, and a model that can call tools is not permitted to call them. Authorization stays
 *               with the approval gates; nothing in this module grants, widens or replaces one.
 */
import { detectGpu, type GpuInfo } from './hardwareCapacity';
import { gpuBudgetBytes } from './ollamaModelInfo';
import { localInstalledModels, type InstalledModel } from './escalation';

/** Models never chosen automatically: modified "uncensored" variants are the owner's to pick by hand. */
const NOT_AUTO = /abliterat|uncensor|heretic|jailbr/i;

export interface ModelFact {
  name: string;
  paramsB?: number;
  capabilities: string[];
  canSee: boolean;
  canUseTools: boolean;
  isEmbedding: boolean;
  /** GPU memory it needs at Pandesh's context size; undefined when unknown. */
  estimatedBytes?: number;
  loaded: boolean;
  /** Bytes of GPU memory it occupies right now (loaded models only). */
  vramBytes?: number;
  selected: boolean;
  /** True/false when its size and the GPU budget are known, null when not. */
  fitsGpu: boolean | null;
  /** False for models only the owner may pick by hand. */
  autoEligible: boolean;
}

export interface ModelSnapshot {
  at: string;
  /** The model server answered. When false, nothing else here is known. */
  available: boolean;
  gpu: GpuInfo | null;
  budgetBytes?: number;
  /** The model running this turn, when known. */
  selected: string | null;
  /** 'cloud' when the turn runs on a cloud model the user picked: its abilities are not listed here. */
  selectedKind: 'local' | 'cloud' | 'unknown';
  models: ModelFact[];
}

export interface SnapshotOptions {
  baseUrl?: string;
  selectedModel?: string | null;
  /** 'ollama' (or undefined) is local; anything else is a cloud provider. */
  provider?: string | null;
  fetchFn?: typeof fetch;
  gpu?: GpuInfo | null;
  /** Test seam: replaces the installed-model lookup. */
  installed?: () => Promise<InstalledModel[] | undefined>;
  now?: () => number;
}

const SNAPSHOT_TTL_MS = 8_000;
let cache: { key: string; at: number; value: ModelSnapshot } | null = null;
let lastActive: { name: string; kind: 'local' | 'cloud' } | null = null;

/** Records the model a turn runs on, so a tool that explains capabilities can say which one is active. */
export function noteActiveModel(name: string | null | undefined, provider?: string | null): void {
  if (!name) return;
  lastActive = { name, kind: provider && provider !== 'ollama' ? 'cloud' : 'local' };
}
export function clearModelAwarenessCache(): void { cache = null; lastActive = null; }

function factOf(m: InstalledModel, loaded: Map<string, number>, selected: string | null, budget: number | undefined): ModelFact {
  const caps = m.capabilities;
  const isEmbedding = caps.includes('embedding') || /embed|rerank/i.test(m.name);
  return {
    name: m.name,
    ...(m.paramsB !== undefined ? { paramsB: m.paramsB } : {}),
    capabilities: caps,
    canSee: caps.includes('vision'),
    canUseTools: caps.includes('tools'),
    isEmbedding,
    ...(m.estimatedBytes !== undefined ? { estimatedBytes: m.estimatedBytes } : {}),
    loaded: loaded.has(m.name),
    ...(loaded.has(m.name) ? { vramBytes: loaded.get(m.name) } : {}),
    selected: selected !== null && m.name === selected,
    fitsGpu: m.estimatedBytes !== undefined && budget !== undefined ? m.estimatedBytes <= budget : null,
    autoEligible: !NOT_AUTO.test(m.name) && !isEmbedding,
  };
}

/** What is true about the models on this PC right now. Cached for a few seconds so one turn asks Ollama once. */
export async function snapshotModels(options: SnapshotOptions = {}): Promise<ModelSnapshot> {
  const now = (options.now ?? Date.now)();
  const root = (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const selectedName = options.selectedModel ?? lastActive?.name ?? null;
  const kind: ModelSnapshot['selectedKind'] = options.provider !== undefined && options.provider !== null
    ? (options.provider === 'ollama' ? 'local' : 'cloud')
    : (lastActive && selectedName === lastActive.name ? lastActive.kind : 'unknown');
  const key = `${root}|${selectedName}|${kind}`;
  if (!options.installed && !options.fetchFn && cache && cache.key === key && now - cache.at < SNAPSHOT_TTL_MS) return cache.value;
  const gpu = options.gpu !== undefined ? options.gpu : detectGpu();
  const budget = gpuBudgetBytes(gpu?.totalVramMb);
  const installed = await (options.installed ? options.installed() : localInstalledModels(root));
  let snapshot: ModelSnapshot;
  if (!installed) {
    snapshot = { at: new Date(now).toISOString(), available: false, gpu, ...(budget !== undefined ? { budgetBytes: budget } : {}), selected: selectedName, selectedKind: kind, models: [] };
  } else {
    const loaded = new Map<string, number>();
    try {
      const res = await (options.fetchFn ?? fetch)(`${root}/api/ps`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) for (const m of ((await res.json()) as { models?: Array<{ name?: string; size_vram?: number }> }).models ?? []) if (m.name) loaded.set(m.name, Number(m.size_vram ?? 0));
    } catch { /* unknown what is loaded: every model reads as not loaded */ }
    const localSelected = kind === 'cloud' ? null : selectedName;
    snapshot = {
      at: new Date(now).toISOString(), available: true, gpu, ...(budget !== undefined ? { budgetBytes: budget } : {}),
      selected: selectedName, selectedKind: kind,
      models: installed.map((m) => factOf(m, loaded, localSelected, budget)),
    };
  }
  if (!options.installed && !options.fetchFn) cache = { key, at: now, value: snapshot };
  return snapshot;
}

export interface ModelNeed { vision?: boolean; tools?: boolean }
export type ModelChoice =
  | { model: string; why: string; willLoad: boolean; alternatives: Array<{ name: string; whyNot: string }> }
  | { model: null; why: string; alternatives: Array<{ name: string; whyNot: string }> };

const needText = (n: ModelNeed) => [n.vision ? 'read images' : '', n.tools ? 'call tools' : ''].filter(Boolean).join(' and ') || 'chat';

/**
 * The local model that should do a job: the selected one if it already can (nothing is loaded), then one that is
 * already loaded, then the smallest that fits graphics memory. Only local models are ever returned: a private image or
 * text is never routed to a cloud model by this function.
 */
export function chooseModel(snap: ModelSnapshot, need: ModelNeed): ModelChoice {
  const alternatives: Array<{ name: string; whyNot: string }> = [];
  if (!snap.available) return { model: null, why: 'the local model server (Ollama) did not answer, so no installed model is known', alternatives };
  const ok: ModelFact[] = [];
  for (const m of snap.models) {
    if (m.isEmbedding) { alternatives.push({ name: m.name, whyNot: 'an embedding model, not a chat model' }); continue; }
    if (!m.autoEligible) { alternatives.push({ name: m.name, whyNot: 'a modified variant that only the owner picks by hand' }); continue; }
    if (need.vision && !m.canSee) { alternatives.push({ name: m.name, whyNot: 'does not report the vision capability' }); continue; }
    if (need.tools && !m.canUseTools) { alternatives.push({ name: m.name, whyNot: 'does not report tool use' }); continue; }
    ok.push(m);
  }
  if (ok.length === 0) {
    const have = snap.models.filter((m) => !m.isEmbedding).map((m) => m.name);
    return { model: null, why: `no installed local model can ${needText(need)}${have.length ? ` (installed: ${have.join(', ')})` : ''}`, alternatives };
  }
  const size = (m: ModelFact) => m.estimatedBytes ?? Number.POSITIVE_INFINITY;
  // Selected first (the user's own pick), then a loaded model that fits (free to use and fast). A loaded model that is
  // larger than graphics memory runs partly on the CPU (measured: 237 s for one screenshot), so it ranks below a fitting
  // model that would have to be loaded.
  const rank = (m: ModelFact) => [m.selected ? 0 : 1, m.loaded && m.fitsGpu !== false ? 0 : 1, m.fitsGpu === false ? 1 : 0, m.loaded ? 0 : 1, size(m)];
  ok.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; });
  const best = ok[0];
  for (const m of ok.slice(1)) alternatives.push({ name: m.name, whyNot: m.loaded ? 'also able, but the chosen model ranks higher' : 'also able, but not loaded or larger than the chosen one' });
  const why = best.selected ? `${best.name} is the active model and can ${needText(need)}: nothing needs to be loaded`
    : best.loaded ? `${best.name} is already loaded and can ${needText(need)}: nothing new is loaded`
      : best.fitsGpu === false ? `${best.name} can ${needText(need)} but is larger than this PC's graphics-memory budget, so it will run partly on the CPU and load slowly`
        : `${best.name} can ${needText(need)}${best.fitsGpu ? ' and fits this PC\'s graphics memory' : ''}; it is not loaded yet, so using it loads it`;
  return { model: best.name, why, willLoad: !best.loaded && !best.selected, alternatives };
}

const gb = (b?: number) => (b === undefined ? '?' : `${(b / 1e9).toFixed(1)} GB`);
const abilities = (m: ModelFact) => [m.canSee ? 'sees images' : '', m.canUseTools ? 'uses tools' : '', m.capabilities.includes('thinking') ? 'reasons' : '', m.capabilities.includes('audio') ? 'hears audio' : ''].filter(Boolean).join(', ') || 'chat only';

/** The compact, model-facing summary. Detail is on demand (capability_explain). */
export function renderModelSummary(snap: ModelSnapshot): string {
  if (!snap.available) return 'MODELS ON THIS PC: the local model server did not answer just now, so which models are installed or loaded is not known. Do not promise one.';
  const lines: string[] = ['MODELS ON THIS PC (live):'];
  const active = snap.models.find((m) => m.selected);
  if (snap.selectedKind === 'cloud' && snap.selected) lines.push(`- Active: ${snap.selected} (a cloud model the user picked; its abilities are not listed here; private files, screens and messages are never given to it).`);
  else if (active) lines.push(`- Active: ${active.name}${active.loaded ? ' (loaded)' : ''} — ${abilities(active)}.`);
  else if (snap.selected) lines.push(`- Active: ${snap.selected} (not found among the installed models).`);
  const others = snap.models.filter((m) => !m.selected && m.autoEligible);
  const seers = others.filter((m) => m.canSee);
  if (seers.length) lines.push(`- Also able to read images: ${seers.map((m) => `${m.name} (${gb(m.estimatedBytes)}${m.loaded ? ', loaded' : ', not loaded'})`).join(', ')}.`);
  const loadedOthers = others.filter((m) => m.loaded && !m.canSee);
  if (loadedOthers.length) lines.push(`- Also loaded: ${loadedOthers.map((m) => m.name).join(', ')}.`);
  lines.push(`- ${others.length} other installed model(s); ask capability_explain for the full list, what fits, and why one would or would not be chosen.`);
  if (snap.gpu) lines.push(`- Graphics memory: ${snap.gpu.name}, ${(snap.gpu.totalVramMb / 1024).toFixed(0)} GB total, ${(snap.gpu.freeVramMb / 1024).toFixed(1)} GB free now.`);
  lines.push('A model being able to do something is not permission to: every tool still follows the user\'s approvals, and a private screenshot is read only by a local model.');
  return lines.join('\n');
}

/** The full account, for "what can you do / why can't you": per-model abilities, state, fit, and the reasoning of a choice. */
export function renderModelDetail(snap: ModelSnapshot, need?: ModelNeed): string {
  if (!snap.available) return 'The local model server (Ollama) did not answer, so installed and loaded models are unknown right now. Nothing here is promised.';
  const lines = [`Models (${snap.at})${snap.gpu ? ` — GPU ${snap.gpu.name}: ${(snap.gpu.totalVramMb / 1024).toFixed(0)} GB total, ${(snap.gpu.freeVramMb / 1024).toFixed(1)} GB free` : ' — no GPU detected'}`];
  for (const m of snap.models) {
    const states = [m.selected ? 'ACTIVE' : '', m.loaded ? `loaded (${gb(m.vramBytes)} in GPU memory)` : 'not loaded', m.fitsGpu === null ? 'fit unknown' : m.fitsGpu ? 'fits GPU' : 'larger than the GPU budget', m.autoEligible ? '' : 'owner-picked only'].filter(Boolean).join(', ');
    lines.push(`- ${m.name}: ${m.isEmbedding ? 'embedding model' : abilities(m)}; ${gb(m.estimatedBytes)}${m.paramsB ? `, ${m.paramsB}B` : ''}; ${states}`);
  }
  if (snap.selectedKind === 'cloud') lines.push(`The active model ${snap.selected} is a cloud model: it never receives private files, screens, messages or screenshots.`);
  for (const n of need ? [need] : [{ vision: true }, { tools: true }]) {
    const c = chooseModel(snap, n);
    lines.push(`To ${needText(n)}: ${c.model ? `use ${c.model} — ${c.why}` : c.why}.`);
  }
  lines.push('Abilities are not permissions: whether a tool may run, a screen may be captured or a message may be sent is decided by the user\'s approvals, never by what a model can do.');
  return lines.join('\n');
}

/** The model facts skill resolution needs, from the same snapshot: the active local model's abilities, or undefined when unknown or cloud. */
export function skillModelContext(snap: ModelSnapshot): { vision: boolean; tools: boolean } | undefined {
  if (snap.selectedKind === 'cloud') return undefined;
  const active = snap.models.find((m) => m.selected);
  return active ? { vision: active.canSee, tools: active.canUseTools } : undefined;
}

/** When the active model cannot do what a skill or task needs: which installed local model could, and why. Null when no switch is needed or possible. */
export function modelSwitchHint(snap: ModelSnapshot, need: ModelNeed): string | null {
  const choice = chooseModel(snap, need);
  if (choice.model === null) return `no installed local model can ${needText(need)}`;
  const active = snap.models.find((m) => m.selected);
  return active && active.name === choice.model ? null : `switch to ${choice.model}: ${choice.why}`;
}
