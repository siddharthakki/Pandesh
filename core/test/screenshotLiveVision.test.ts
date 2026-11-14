import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { createLocalVisionInspector } from '../runtime/localVisionInspector';

/**
 * Live check against the real local Ollama, on a SYNTHETIC screenshot (drawn text, no real data). Skipped unless
 * LIVE_VISION_PNG names the image: `LIVE_VISION_PNG=D:\...\synthetic-whatsapp.png LIVE_VISION_OUT=out.json npx vitest run ...`
 */
const PNG = process.env.LIVE_VISION_PNG;
describe.skipIf(!PNG)('live local vision on a synthetic WhatsApp screenshot', () => {
  it('a local model reads the text that is in the image', async () => {
    const started = Date.now();
    const out = await createLocalVisionInspector({ timeoutMs: 400_000 })({ path: PNG!, question: "What's on the WhatsApp screen? Quote the messages." });
    if (process.env.LIVE_VISION_OUT) fs.writeFileSync(process.env.LIVE_VISION_OUT, JSON.stringify({ ms: Date.now() - started, out }, null, 2));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toMatch(/Alice/i);
      expect(out.text).toMatch(/PINEAPPLE/i);
    }
  }, 420_000);
});
