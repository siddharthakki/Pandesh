/**
 * Reads a picture with a vision model that runs on THIS PC (Ollama), and nowhere else.
 *
 * Used by `desktop_screenshot` when the user asked Pandesh to analyze what is on the screen. The boundary is code, not
 * a prompt: the endpoint must be a loopback address, no cloud provider is ever consulted, the image is sent only in the
 * body of one request to that local endpoint, and nothing here records the image or its description anywhere. A failure
 * is returned as a reason, never as a description.
 */
import * as fs from 'node:fs';
import { chooseModel, snapshotModels, type ModelChoice, type ModelSnapshot } from './modelAwareness';

export type InspectResult =
  | { ok: true; model: string; text: string }
  | { ok: false; reason: string };

export interface InspectArgs { path: string; question: string }
export type ImageInspector = (args: InspectArgs) => Promise<InspectResult>;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_DESCRIPTION_CHARS = 6_000;

/** True only for an address that cannot leave this machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

export function createLocalVisionInspector(options: { baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number; snapshot?: () => Promise<ModelSnapshot> } = {}): ImageInspector {
  return async ({ path: imagePath, question }) => {
    const root = (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
    if (!isLoopbackUrl(root)) return { ok: false, reason: `the model endpoint ${root} is not on this PC, and a private screenshot is never sent off this PC without separate consent` };
    const fetchFn = options.fetchFn ?? fetch;
    let bytes: Buffer;
    try {
      const stat = fs.statSync(imagePath);
      if (stat.size > MAX_IMAGE_BYTES) return { ok: false, reason: `the capture is ${stat.size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit for local analysis` };
      bytes = fs.readFileSync(imagePath);
    } catch (err) { return { ok: false, reason: `the capture could not be read: ${err instanceof Error ? err.message : String(err)}` }; }
    // Which model reads is decided from the same live facts the rest of Pandesh uses (installed, loaded, selected, fits).
    let choice: ModelChoice;
    try { choice = chooseModel(await (options.snapshot ? options.snapshot() : snapshotModels({ baseUrl: root })), { vision: true }); } catch (err) { return { ok: false, reason: `the local model server did not answer: ${err instanceof Error ? err.message : String(err)}` }; }
    if (choice.model === null) return { ok: false, reason: `${choice.why}; install or select one that can, for example a vision model in Ollama, to analyze screenshots on this PC` };
    const model = choice.model;
    try {
      const res = await fetchFn(`${root}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false,
          messages: [
            { role: 'system', content: 'You read a screenshot of a Windows desktop for its owner. Say only what is actually visible: the application windows, their titles and the text you can read. If something is unreadable or cut off, say so. Never guess or invent text.' },
            { role: 'user', content: question, images: [bytes.toString('base64')] },
          ],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!res.ok) return { ok: false, reason: `the local vision model ${model} returned HTTP ${res.status}` };
      const text = String(((await res.json()) as { message?: { content?: string } }).message?.content ?? '').trim();
      if (!text) return { ok: false, reason: `the local vision model ${model} returned no description` };
      return { ok: true, model, text: text.slice(0, MAX_DESCRIPTION_CHARS) };
    } catch (err) { return { ok: false, reason: `the local vision model ${model} failed: ${err instanceof Error ? err.message : String(err)}` }; }
  };
}
