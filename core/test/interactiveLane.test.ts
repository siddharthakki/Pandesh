import { describe, expect, it } from 'vitest';
import { InteractiveLane, classifyAttemptLane, DEFAULT_MAX_TOOL_YIELD_MS } from '../runtime/interactiveLane';

describe('interactive lane', () => {
  it('classifies chat as interactive and coding, autonomous and scheduled work as background', () => {
    expect(classifyAttemptLane({ kind: 'baat_kar', clientId: 'desktop' })).toBe('interactive');
    expect(classifyAttemptLane({ kind: 'saath_kar' })).toBe('background');
    expect(classifyAttemptLane({ kind: 'karke_dikha' })).toBe('background');
    expect(classifyAttemptLane({ kind: 'baat_kar', clientId: 'core:scheduler' })).toBe('background');
  });

  it('does not delay a background attempt when no interactive attempt is active', async () => {
    const lane = new InteractiveLane();
    expect(await lane.yieldToInteractive('bg')).toEqual({ waitedMs: 0, timedOut: false });
  });

  it('holds the next background model call until the interactive attempt releases, without aborting anything', async () => {
    const lane = new InteractiveLane();
    const release = lane.begin('chat');
    let resumed = false;
    const pending = lane.yieldToInteractive('bg', undefined, 5_000).then((r) => { resumed = true; return r; });
    await new Promise((r) => setTimeout(r, 40));
    expect(resumed).toBe(false);
    release();
    release(); // idempotent
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(30);
  });

  it('never makes an interactive attempt wait for itself or other interactive work', async () => {
    const lane = new InteractiveLane();
    lane.begin('chat');
    expect((await lane.yieldToInteractive('chat')).waitedMs).toBe(0);
  });

  it('bounds the wait so background work is not starved, and releases on abort', async () => {
    const lane = new InteractiveLane();
    lane.begin('chat');
    const bounded = await lane.yieldToInteractive('bg', undefined, 60);
    expect(bounded.timedOut).toBe(true);
    const ac = new AbortController();
    const aborted = lane.yieldToInteractive('bg2', ac.signal, 5_000);
    setTimeout(() => ac.abort(), 20);
    expect((await aborted).timedOut).toBe(false);
    expect(lane.stats().timeouts).toBe(1);
  });

  it('yieldToInteractiveAtTool uses shorter default timeout', async () => {
    const lane = new InteractiveLane();
    lane.begin('chat');
    const bounded = await lane.yieldToInteractiveAtTool('bg', undefined, 60);
    expect(bounded.timedOut).toBe(true);
  });

  it('tool yield is independent of model yield timeout', async () => {
    const lane = new InteractiveLane();
    lane.begin('chat');
    // Use short timeouts for test speed
    const shortMs = 100;
    // Model yield has longer default timeout
    const modelYield = await lane.yieldToInteractive('bg', undefined, shortMs);
    // Tool yield uses shorter default
    const toolYield = await lane.yieldToInteractiveAtTool('bg', undefined, shortMs);
    expect(modelYield.timedOut).toBe(true); // 100ms elapsed
    expect(toolYield.timedOut).toBe(true); // 100ms elapsed
  });
});
