/**
 * SystemOneProvider adapter for Ollaya (and any Laya/Jev-compatible server
 * exposing the same `/v1/systemone` wire format). This is the ONLY file that
 * should know that wire format's shape.
 */
import { isLoopbackEndpoint } from './loopback';
import type {
  SystemOneDecisionRequest,
  SystemOneDecisionResponse,
  SystemOneDecisionValue,
  SystemOneHealth,
  SystemOneProvider,
} from './types';

interface OllayaAnswer {
  choice?: string;
  noul?: number;
  probabilities?: Record<string, number>;
}

interface OllayaResponseBody {
  answers?: Record<string, OllayaAnswer>;
  model?: string;
}

export class OllayaProvider implements SystemOneProvider {
  readonly name = 'ollaya';

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async decide(request: SystemOneDecisionRequest): Promise<SystemOneDecisionResponse> {
    const started = Date.now();
    if (!isLoopbackEndpoint(this.endpoint)) {
      return { decisions: {}, provider: this.name, model: request.model ?? null, latencyMs: 0, error: 'refused: non-loopback endpoint' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(50, request.timeoutMs));
    try {
      const body: Record<string, unknown> = { state: request.context, questions: request.questions };
      if (request.model) body.model = request.model;
      const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { decisions: {}, provider: this.name, model: request.model ?? null, latencyMs: Date.now() - started, error: `HTTP ${response.status}` };
      }
      const parsed = (await response.json()) as OllayaResponseBody;
      const decisions: SystemOneDecisionResponse['decisions'] = {};
      for (const [key, answer] of Object.entries(parsed.answers ?? {})) {
        const value = readAnswerValue(answer);
        if (value === undefined) continue;
        decisions[key as keyof SystemOneDecisionResponse['decisions']] = value;
      }
      return {
        decisions,
        provider: this.name,
        model: parsed.model ?? request.model ?? null,
        latencyMs: Date.now() - started,
        raw: parsed,
      };
    } catch (error) {
      return {
        decisions: {},
        provider: this.name,
        model: request.model ?? null,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<SystemOneHealth> {
    if (!isLoopbackEndpoint(this.endpoint)) return { ok: false, detail: 'non-loopback endpoint' };
    try {
      const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, '')}/v1/systemone`, { method: 'OPTIONS' });
      return { ok: response.ok || response.status === 405, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

function readAnswerValue(answer: OllayaAnswer | undefined): SystemOneDecisionValue | undefined {
  if (!answer) return undefined;
  if (typeof answer.choice === 'string') {
    const confidence = answer.probabilities?.[answer.choice];
    return { value: answer.choice, confidence: typeof confidence === 'number' ? confidence : null };
  }
  if (typeof answer.noul === 'number') {
    return { value: String(answer.noul >= 0.5), confidence: answer.noul };
  }
  return undefined;
}
