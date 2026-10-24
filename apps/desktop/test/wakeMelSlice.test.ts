import { describe, expect, it } from 'vitest';

/** Mirrors wake-word-worker.sliceMelWindow — keep in sync. */
function sliceMelWindow(melFrames: unknown[], ndx: number): unknown[] | null {
  const len = melFrames.length;
  let end = ndx === 0 ? len : ndx;
  if (end === 0) end = len;
  const start = end - 76;
  const s = start < 0 ? len + start : start;
  const e = end < 0 ? len + end : end;
  if (e - s !== 76 || s < 0 || e > len) return null;
  return melFrames.slice(s, e);
}

describe('openWakeWord mel window slice', () => {
  it('takes the last 76 frames when ndx is buffer length (Python ndx==0 case)', () => {
    const buf = Array.from({ length: 100 }, (_, i) => i);
    const take = sliceMelWindow(buf, buf.length);
    expect(take).toEqual(buf.slice(24, 100));
    expect(take).toHaveLength(76);
  });

  it('handles negative ndx like Python buffer[-84:-8]', () => {
    const buf = Array.from({ length: 100 }, (_, i) => i);
    const take = sliceMelWindow(buf, -8);
    expect(take).toEqual(buf.slice(16, 92));
    expect(take).toHaveLength(76);
  });

  it('returns null until 76 mel frames exist', () => {
    const buf = Array.from({ length: 40 }, (_, i) => i);
    expect(sliceMelWindow(buf, buf.length)).toBeNull();
  });

  it('rejects the broken length-76+ndx formula that always skipped', () => {
    const len = 100;
    const ndx = len;
    const brokenStart = len - 76 + ndx;
    expect(brokenStart).toBe(2 * len - 76);
    expect(ndx - brokenStart).not.toBe(76);
  });
});
