import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

describe('Desktop governed weather', () => {
  it('routes a chat-typed weather question through the governed get_weather approval', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-'));
    const dispatchCapability = vi.fn()
      .mockResolvedValueOnce({
        outcome: 'approval_required', attemptId: 'attempt-weather',
        approval: {
          id: 'approval-weather', attemptId: 'attempt-weather', expectedAttemptRevision: 1,
          expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'digest-weather',
          frozenContextHash: 'context-weather', presentation: { location: 'Ulm' },
        },
      })
      .mockResolvedValueOnce({
        outcome: 'executed', attemptId: 'attempt-weather',
        toolInvocation: { status: 'succeeded', evidence: { output: 'Ulm, Baden-Württemberg, Germany: clear sky, 18°C, humidity 55%' } },
      });
    const resolveCapabilityApproval = vi.fn(async () => ({}));
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      createConversation: async () => ({ id: 'conversation-weather' }),
      dispatchCapability, resolveCapabilityApproval,
    };
    internal.coreState = 'connected';

    const submitted = await host.submitTask("what's the weather in Ulm?");
    expect(submitted.model).toBe('weather');
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    expect(dispatchCapability.mock.calls[0][0]).toMatchObject({
      toolName: 'get_weather',
      arguments: { location: 'Ulm' },
    });
    expect(host.snapshot().pendingWeatherApproval).toEqual({
      approvalId: 'approval-weather', attemptId: 'attempt-weather',
      presentation: { location: 'Ulm' },
    });

    const events: Array<{ kind?: string; text?: string }> = [];
    host.onEvent((event) => events.push(event));
    const resolved = await host.resolveWeatherApproval('approval-weather', 'approved');
    expect(resolveCapabilityApproval).toHaveBeenCalledWith('approval-weather', expect.objectContaining({ resolution: 'approved', requestedActionDigest: 'digest-weather' }));
    expect(dispatchCapability).toHaveBeenCalledTimes(2);
    expect(dispatchCapability.mock.calls[1][0]).toEqual(dispatchCapability.mock.calls[0][0]);
    expect(resolved).toEqual({ outcome: 'executed', attemptId: 'attempt-weather', message: 'Ulm, Baden-Württemberg, Germany: clear sky, 18°C, humidity 55%' });
    expect(events.some((e) => e.kind === 'result' && e.text === 'Ulm, Baden-Württemberg, Germany: clear sky, 18°C, humidity 55%')).toBe(true);
    expect(host.snapshot().pendingWeatherApproval).toBeNull();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects a pending weather approval without dispatching a second time', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-reject-'));
    const dispatchCapability = vi.fn().mockResolvedValueOnce({
      outcome: 'approval_required', attemptId: 'attempt-weather-reject',
      approval: {
        id: 'approval-weather-reject', attemptId: 'attempt-weather-reject', expectedAttemptRevision: 1,
        expectedAttemptStatus: 'waiting_for_approval', requestedActionDigest: 'digest',
        frozenContextHash: 'context', presentation: { location: 'Paris' },
      },
    });
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      createConversation: async () => ({ id: 'conversation-weather-reject' }),
      dispatchCapability,
      resolveCapabilityApproval: async () => ({}),
    };
    internal.coreState = 'connected';

    await host.submitTask('what is the weather in Paris');
    const resolved = await host.resolveWeatherApproval('approval-weather-reject', 'rejected');
    expect(resolved).toEqual({ outcome: 'denied', attemptId: 'attempt-weather-reject', reason: 'rejected by operator' });
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('asks for a location rather than guessing one when the question has none', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-nolocation-'));
    const dispatchCapability = vi.fn();
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = { createConversation: async () => ({ id: 'c' }), dispatchCapability };
    internal.coreState = 'connected';

    const events: Array<{ kind?: string; text?: string }> = [];
    host.onEvent((event) => events.push(event));
    const submitted = await host.submitTask('what is the weather like today');
    expect(submitted.model).toBe('weather');
    expect(dispatchCapability).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'result' && /which location/i.test(e.text ?? ''))).toBe(true);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reuses the last resolved location for a bare follow-up question', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-followup-'));
    const dispatchCapability = vi.fn()
      .mockResolvedValueOnce({
        outcome: 'executed', attemptId: 'attempt-weather-1',
        toolInvocation: { status: 'succeeded', evidence: { output: 'Ulm, Baden-Württemberg, Germany: clear sky, 18°C, humidity 55%' } },
      })
      .mockResolvedValueOnce({
        outcome: 'executed', attemptId: 'attempt-weather-2',
        toolInvocation: { status: 'succeeded', evidence: { output: 'Ulm, Baden-Württemberg, Germany: light rain, 15°C, humidity 80%' } },
      });
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = { createConversation: async () => ({ id: 'conversation-weather-followup' }), dispatchCapability };
    internal.coreState = 'connected';

    await host.submitTask("what's the weather in Ulm?");
    expect(dispatchCapability).toHaveBeenCalledTimes(1);

    const events: Array<{ kind?: string; text?: string }> = [];
    host.onEvent((event) => events.push(event));
    await host.submitTask('will it rain?');
    expect(dispatchCapability).toHaveBeenCalledTimes(2);
    expect(dispatchCapability.mock.calls[1][0]).toMatchObject({
      toolName: 'get_weather',
      arguments: { location: 'Ulm' },
    });
    expect(events.some((e) => e.kind === 'result' && /light rain/i.test(e.text ?? ''))).toBe(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('forgets the remembered location on a new conversation', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-newconvo-'));
    const dispatchCapability = vi.fn().mockResolvedValueOnce({
      outcome: 'executed', attemptId: 'attempt-weather',
      toolInvocation: { status: 'succeeded', evidence: { output: 'Ulm, Baden-Württemberg, Germany: clear sky, 18°C, humidity 55%' } },
    });
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = { createConversation: async () => ({ id: 'conversation-weather-newconvo' }), dispatchCapability };
    internal.coreState = 'connected';

    await host.submitTask("what's the weather in Ulm?");
    await host.newConversation();

    const events: Array<{ kind?: string; text?: string }> = [];
    host.onEvent((event) => events.push(event));
    await host.submitTask('will it rain?');
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.kind === 'result' && /which location/i.test(e.text ?? ''))).toBe(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('treats a bare place-name reply to "Which location?" as the answer', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-bareanswer-'));
    const dispatchCapability = vi.fn().mockResolvedValueOnce({
      outcome: 'executed', attemptId: 'attempt-weather',
      toolInvocation: { status: 'succeeded', evidence: { output: 'Ulm, Baden-Württemberg, Germany: clear sky, 18°C, humidity 55%' } },
    });
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = { createConversation: async () => ({ id: 'conversation-weather-bareanswer' }), dispatchCapability };
    internal.coreState = 'connected';

    // "what is the weather today" has no location -> Jarvis asks which one.
    await host.submitTask('what is the weather today');
    expect(dispatchCapability).not.toHaveBeenCalled();

    // The natural reply to a direct question is just the place name, with
    // no weather keyword of its own — this must not fall through to
    // ordinary chat.
    const events: Array<{ kind?: string; text?: string }> = [];
    host.onEvent((event) => events.push(event));
    const submitted = await host.submitTask('in Ulm');
    expect(submitted.model).toBe('weather');
    expect(dispatchCapability).toHaveBeenCalledTimes(1);
    expect(dispatchCapability.mock.calls[0][0]).toMatchObject({
      toolName: 'get_weather',
      arguments: { location: 'Ulm' },
    });
    expect(events.some((e) => e.kind === 'result' && /clear sky/i.test(e.text ?? ''))).toBe(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not misroute a real new question as a location answer', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weather-session-notanswer-'));
    const dispatchCapability = vi.fn();
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const internal = host as unknown as { client: unknown; coreState: string };
    internal.client = {
      createConversation: async () => ({ id: 'conversation-weather-notanswer' }),
      dispatchCapability,
    };
    internal.coreState = 'connected';

    await host.submitTask('what is the weather today');
    // A genuinely unrelated follow-up must not be swallowed as a "location"
    // and dispatched as a (wrong) weather lookup. It may still fail deeper
    // in the ordinary chat pipeline here (the mock client is intentionally
    // minimal) — what matters is that it never reaches get_weather.
    await host.submitTask('what time is it right now in general').catch(() => undefined);
    expect(dispatchCapability).not.toHaveBeenCalled();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
