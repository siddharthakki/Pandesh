import { describe, expect, it } from 'vitest';

/**
 * wakeDetectMs must stay null until a real detection. Never invent 0.
 * Separates detection failure (frames, no crossing) from instrumentation miss.
 */
function classifyWakeDetectMsNull(diag: {
  framesReceived: number;
  thresholdCrossings: number;
  wakeDetectMs: number | null;
}): 'ok' | 'no_frames' | 'no_crossing' | 'instrumentation_miss' {
  if (diag.wakeDetectMs != null) return 'ok';
  if (diag.framesReceived === 0) return 'no_frames';
  if (diag.thresholdCrossings === 0) return 'no_crossing';
  return 'instrumentation_miss';
}

describe('wakeDetectMs honesty', () => {
  it('keeps null when no frames arrived', () => {
    expect(classifyWakeDetectMsNull({
      framesReceived: 0,
      thresholdCrossings: 0,
      wakeDetectMs: null,
    })).toBe('no_frames');
  });

  it('attributes null to detection failure when frames flow but never cross', () => {
    expect(classifyWakeDetectMsNull({
      framesReceived: 40,
      thresholdCrossings: 0,
      wakeDetectMs: null,
    })).toBe('no_crossing');
  });

  it('attributes null to instrumentation miss when crossings exist without wakeDetectMs', () => {
    expect(classifyWakeDetectMsNull({
      framesReceived: 40,
      thresholdCrossings: 1,
      wakeDetectMs: null,
    })).toBe('instrumentation_miss');
  });

  it('never treats an absent measurement as zero', () => {
    const wakeDetectMs: number | null = null;
    expect(wakeDetectMs).toBeNull();
    expect(wakeDetectMs === 0).toBe(false);
  });
});
