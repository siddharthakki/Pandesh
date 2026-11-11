/**
 * Designs a 3D Workshop scene from a plain description with the conversation's own LOCAL model (Ollama on this
 * PC; never a cloud model). The model fills a JSON schema (Ollama structured output), so it cannot answer with
 * prose or code; Core then validates every number (core/shared/workshop/scene3d.ts) and asks once more with the
 * reasons when nothing usable came back.
 *
 * Why a separate call: choosing among 20+ tools AND writing a valid component list in one step is where small local
 * models fail. Here the chat model only passes the user's words, and this call has exactly one job.
 */
import { COMPONENT_KINDS, COMPONENT_PARAMS, MATERIAL_PRESET_IDS, validateGeneratedScene, type Scene3D } from '../shared/workshop/scene3d';
import { DEFAULT_OLLAMA_URL } from './modelBackend';

export interface DesignOptions {
  model: string;
  ollamaUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** The context the chat runs with, so Ollama does not reload the model at another size. */
  numCtx?: number;
  timeoutMs?: number;
  onStage?: (stage: string) => void;
}

export type DesignResult =
  | { ok: true; scene: Scene3D; warnings: string[]; attempts: number; ms: number; model: string }
  | { ok: false; error: string; attempts: number; ms: number; model: string };

const PARAM_NAMES = [...new Set(Object.values(COMPONENT_PARAMS).flatMap((p) => Object.keys(p)))];

/** The JSON schema Ollama constrains the answer to. */
export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    components: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: [...COMPONENT_KINDS] },
          params: { type: 'object', properties: Object.fromEntries(PARAM_NAMES.map((n) => [n, { type: 'number' }])) },
          position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          material: { type: 'string', enum: [...MATERIAL_PRESET_IDS] },
          group: { type: 'string' },
          meshWith: { type: 'string' },
          angle: { type: 'number' },
        },
        required: ['id', 'name', 'kind', 'params', 'position', 'material'],
      },
    },
  },
  required: ['title', 'components'],
} as const;

const SHAPES = Object.entries(COMPONENT_PARAMS).map(([kind, params]) => `${kind}(${Object.keys(params).join(', ')})`).join('; ');

export const DESIGNER_RULES = [
  'You design a 3D model for an interactive viewer as a list of simple parametric parts. Answer only with JSON that matches the schema.',
  `Shapes and their parameters (millimetres): ${SHAPES}.`,
  'Y is up. Cylinders, tubes, cones, capsules, tori and gears stand on the Y axis (their flat faces point up and down). position is the centre of the part.',
  'Gears: radius is the pitch radius; to make two gears mesh, give the second "meshWith": "<id of the first>" and an "angle" in degrees, and leave out its position and radius — Pandesh places it so the teeth touch.',
  'Use realistic proportions, 4 to 20 parts, a short id per part, names a person would use ("Outer case", "Drive gear"), and group parts into sub-assemblies with "group".',
  `Materials: ${MATERIAL_PRESET_IDS.join(', ')}.`,
].join('\n');

export async function designScene(description: string, options: DesignOptions): Promise<DesignResult> {
  const started = Date.now();
  const fetcher = options.fetchImpl ?? fetch;
  const url = `${(options.ollamaUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '')}/api/chat`;
  const ask = description.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: DESIGNER_RULES },
    { role: 'user', content: `Design: ${ask}` },
  ];
  let lastError = 'no answer';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    options.onStage?.(attempt === 1 ? `Designing the parts with ${options.model} on this PC` : `Asking ${options.model} again: ${lastError.slice(0, 80)}`);
    let content = '';
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 240_000),
        body: JSON.stringify({ model: options.model, stream: false, think: false, format: SCENE_SCHEMA, messages, options: { temperature: 0.2, num_ctx: options.numCtx ?? 32_768 } }),
      });
      if (!res.ok) { lastError = `the local model answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`; break; }
      const body = await res.json() as { message?: { content?: string } };
      content = body.message?.content ?? '';
    } catch (err) {
      if (options.signal?.aborted) return { ok: false, error: 'cancelled', attempts: attempt, ms: Date.now() - started, model: options.model };
      lastError = `the local model did not answer: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    let raw: unknown;
    try { raw = JSON.parse(content); } catch { lastError = 'the answer was not JSON'; messages.push({ role: 'assistant', content: content.slice(0, 2_000) }, { role: 'user', content: 'That was not valid JSON. Answer again with JSON only.' }); continue; }
    options.onStage?.('Checking the parts');
    const v = validateGeneratedScene(raw);
    if (v.ok) return { ok: true, scene: v.value, warnings: v.warnings, attempts: attempt, ms: Date.now() - started, model: options.model };
    lastError = v.errors.join('; ');
    messages.push({ role: 'assistant', content: content.slice(0, 4_000) }, { role: 'user', content: `Pandesh could not build that: ${lastError.slice(0, 600)}. Fix it and answer again with the whole JSON.` });
  }
  return { ok: false, error: lastError, attempts: 2, ms: Date.now() - started, model: options.model };
}
