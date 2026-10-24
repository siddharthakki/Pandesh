import { describe, expect, it } from 'vitest';

/** Mirrors renderer voiceCapture.resampleFloat32 — keep in sync. */
function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!input?.length) return new Float32Array(0);
  if (!fromRate || !toRate || fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIndex - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

describe('wake audio resample', () => {
  it('passes through when rates match', () => {
    const input = Float32Array.from([0, 0.5, -0.5, 1]);
    expect(Array.from(resampleFloat32(input, 16000, 16000))).toEqual(Array.from(input));
  });

  it('downsamples 48 kHz to 16 kHz at 1/3 length', () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 40);
    const out = resampleFloat32(input, 48000, 16000);
    expect(out.length).toBe(1600);
  });

  it('keeps energy shape after 48→16 downsample (not silence)', () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i += 1) input[i] = i % 2 === 0 ? 0.4 : -0.4;
    const out = resampleFloat32(input, 48000, 16000);
    let sum = 0;
    for (let i = 0; i < out.length; i += 1) sum += Math.abs(out[i]);
    expect(sum / out.length).toBeGreaterThan(0.1);
  });
});
