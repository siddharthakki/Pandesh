/**
 * Picks a model that can actually see an attached image.
 *
 * Core refuses an image attachment unless the frozen model selection says the
 * model has vision (it will not silently fall back to text-only), and its
 * routing evidence never sets that flag by itself — so the desktop host, which
 * already knows which Ollama models are installed, asks Ollama what each can do
 * and builds that selection explicitly. The renderer is told plainly when the
 * model used for a turn differs from the one the user selected, and why.
 */
import type { ExecutionCapabilityRequirements, ModelSelectionEvidence } from '../../../../core/shared/wireTypes';

export type VisionFetch = (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const capabilityCache = new Map<string, boolean>();

/** Models that can both chat and look at images, per Ollama's own capability list. Best effort; failures yield "unknown", never "yes". */
export async function fetchOllamaVisionModels(baseUrl: string, installed: readonly string[], fetchFn: VisionFetch = fetch as unknown as VisionFetch): Promise<string[]> {
  const root = baseUrl.replace(/\/$/, '');
  const found: string[] = [];
  await Promise.all(installed.map(async (model) => {
    const cached = capabilityCache.get(`${root}|${model}`);
    if (cached !== undefined) {
      if (cached) found.push(model);
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      try {
        const response = await fetchFn(`${root}/api/show`, { method: 'POST', body: JSON.stringify({ model }), signal: controller.signal });
        if (!response.ok) return;
        const body = (await response.json()) as { capabilities?: unknown };
        const caps = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
        const ok = caps.includes('vision') && caps.includes('completion');
        capabilityCache.set(`${root}|${model}`, ok);
        if (ok) found.push(model);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      /* unknown: not offered */
    }
  }));
  return installed.filter((m) => found.includes(m));
}

export function clearVisionCapabilityCache(): void {
  capabilityCache.clear();
}

/** Larger general models first; anything else in installed order. */
const PREFERENCE = [/gemma4/i, /qwen3\.5/i, /qwen2\.5vl/i, /qwen3\.8/i, /llava/i, /muse/i, /qwen3-coder/i];

export interface VisionChoice {
  model: string;
  /** True when this is not the model the person selected (they selected a text-only model). */
  differsFromSelection: boolean;
  reason: string;
}

export function chooseVisionModel(input: { selectedModel: string; isAuto: boolean; visionModels: readonly string[] }): VisionChoice | null {
  const { selectedModel, isAuto, visionModels } = input;
  if (visionModels.length === 0) return null;
  if (!isAuto && visionModels.includes(selectedModel)) {
    return { model: selectedModel, differsFromSelection: false, reason: 'Your selected model can see images.' };
  }
  const ranked = [...visionModels].sort((a, b) => {
    const ra = PREFERENCE.findIndex((re) => re.test(a));
    const rb = PREFERENCE.findIndex((re) => re.test(b));
    return (ra === -1 ? 99 : ra) - (rb === -1 ? 99 : rb);
  });
  const model = ranked[0];
  return isAuto
    ? { model, differsFromSelection: false, reason: `Auto chose ${model} because this message includes an image.` }
    : { model, differsFromSelection: true, reason: `${selectedModel} can't see images, so ${model} is answering this message.` };
}

/** Frozen selection evidence with the vision flag Core requires for image attachments. */
export function visionSelectionEvidence(input: { mode: 'baat_kar' | 'saath_kar' | 'karke_dikha'; model: string; reason: string; userOverrode: boolean }): ModelSelectionEvidence {
  const { mode, model, reason, userOverrode } = input;
  const requiredCapabilities: ExecutionCapabilityRequirements = {
    readOnlyExplanation: mode === 'baat_kar',
    repositoryExploration: mode !== 'baat_kar',
    toolCalling: mode === 'saath_kar',
    fileModification: mode === 'karke_dikha',
    codingComplexity: mode === 'karke_dikha' ? 'medium' : mode === 'saath_kar' ? 'low' : 'none',
    contextRequirement: mode === 'karke_dikha' ? 'large' : mode === 'saath_kar' ? 'medium' : 'small',
    vision: true,
    validationAndRepair: mode === 'karke_dikha',
  };
  return {
    requiredCapabilities,
    selectedProvider: 'ollama',
    selectedModel: model,
    selectionReason: reason,
    suitabilitySummary: 'Using a model that can see images',
    userOverrode,
    candidates: [{ provider: 'ollama', model, available: true, capable: true, costRank: 0, rejectionReasons: [] }],
    escalationCandidates: [],
  };
}
