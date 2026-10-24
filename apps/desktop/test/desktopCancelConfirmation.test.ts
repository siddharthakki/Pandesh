/**
 * The desktop's Stop contract.
 *
 * A Stop is a *request*; the authoritative state is the attempt's persisted
 * terminal state. The old behaviour accepted the request and then showed
 * "Stopping…" for ever when Core never settled the attempt, which is exactly
 * what the user saw on the stuck attempt. The desktop now waits (bounded) for
 * the real state and says plainly when the stop was not confirmed.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

interface EmittedEvent {
  kind: string;
  summary?: string;
  attemptId?: string;
}

function sessionWithActiveTurn(dataDir: string, options: { cancelConfirmTimeoutMs?: number } = {}) {
  const host = new DesktopSession({
    productRoot: process.cwd(),
    dataDir,
    cancelConfirmTimeoutMs: options.cancelConfirmTimeoutMs ?? 150,
  });
  const events: EmittedEvent[] = [];
  const internal = host as unknown as {
    folder: string | null;
    coreState: string;
    client: unknown;
    active: unknown;
    emit: (event: EmittedEvent) => void;
  };
  internal.folder = 'C:\\Projects\\fixture-repo';
  internal.coreState = 'connected';
  internal.active = {
    attemptId: 'att-1', requestId: 'req-1', conversationId: 'conv-1', goal: 'g', tokenBuffer: '', terminal: false,
  };
  internal.emit = (event: EmittedEvent) => { events.push(event); };
  return { host, events, internal };
}

describe('DesktopSession.cancel', () => {
  it('reports a stop that Core could not confirm, instead of pretending the task stopped', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cancel-unconfirmed-'));
    const { host, events, internal } = sessionWithActiveTurn(dataDir);
    // Core accepts the request but never settles the attempt.
    internal.client = { cancelAttempt: vi.fn(async () => undefined) };

    await host.cancel();

    const errors = events.filter((event) => event.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].summary).toMatch(/has not confirmed it stopped/i);
    expect(errors[0].summary).toMatch(/press Stop again/i);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('says nothing when Core confirms the terminal state while the desktop waits', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cancel-confirmed-'));
    const { host, events, internal } = sessionWithActiveTurn(dataDir);
    internal.client = {
      cancelAttempt: vi.fn(async () => {
        // The attempt reaches its terminal state (cancelled) a moment later.
        setTimeout(() => {
          (internal.active as { terminal: boolean }).terminal = true;
        }, 20);
        return undefined;
      }),
    };

    await host.cancel();

    expect(events.filter((event) => event.kind === 'error')).toHaveLength(0);
    expect(events.some((event) => event.kind === 'status' && /Cancel requested/.test(event.summary ?? ''))).toBe(true);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses to cancel when nothing is running', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-cancel-nothing-'));
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    await expect(host.cancel()).rejects.toThrow(/no running task/i);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
