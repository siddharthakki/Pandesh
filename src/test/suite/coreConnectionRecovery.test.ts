/**
 * The Core connection may fail. What must not happen is an endless retry
 * loop that shows the operator a climbing counter.
 *
 * These tests pin three claims:
 *   1. The client stops reconnecting on its own after a bounded number of
 *      attempts and says so in words.
 *   2. The user-visible status never contains an internal counter or a
 *      backoff figure — it is a sentence a person can act on.
 *   3. A deliberate "Retry" resets the attempt count and tries again
 *      immediately, so the recovery is a human action, not a background job.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoreClient } from '../../core-client/CoreClient';
import type { CoreConnectionStatus } from '../../core-client/ConnectionState';

const ws = vi.hoisted(() => {
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    on(event: string, handler: (...args: any[]) => void) {
      (this as any)[`on_${event}`] = handler;
    }
    send() { /* no-op */ }
    terminate() { /* no-op */ }
    close() { (this as any).on_close?.(); }
    /** Simulates the server side going away. */
    drop() { (this as any).on_close?.(); }
    constructor(public url: string, public options: any) {
      FakeWebSocket.instances.push(this);
    }
  }
  return { FakeWebSocket };
});

vi.mock('ws', () => ({ WebSocket: ws.FakeWebSocket }));

const FakeWebSocket = ws.FakeWebSocket;

let statuses: CoreConnectionStatus[] = [];

function makeClient(): CoreClient {
  statuses = [];
  return new CoreClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 'test-token',
    clientId: 'test-client',
    clientType: 'desktop',
    onStatusChange: (status) => statuses.push({ ...status }),
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the Core connection', () => {
  it('never puts a retry counter or a backoff figure in the operator-visible status', async () => {
    const client = makeClient();
    // The client is started without a reachable Core, so it cannot even
    // register; go straight to the socket path.
    (client as any).connectWebSocket();
    const socket = FakeWebSocket.instances[0];
    socket.drop();
    vi.advanceTimersByTime(60_000);

    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.detail ?? '').not.toMatch(/attempt \d+/i);
      expect(status.detail ?? '').not.toMatch(/\d+ms/);
    }
    expect(statuses.some((status) => status.state === 'reconnecting')).toBe(true);
  });

  it('stops retrying on its own after a bounded number of attempts', async () => {
    const client = makeClient();
    (client as any).connectWebSocket();

    // Every socket that opens is immediately dropped: the Core is not there.
    for (let i = 0; i < 40; i += 1) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.drop();
      vi.advanceTimersByTime(60_000);
    }

    const opened = FakeWebSocket.instances.length;
    const final = statuses[statuses.length - 1];
    expect(final.state).toBe('disconnected');
    expect(final.detail).toMatch(/stopped retrying/i);
    // Bounded: the loop really did stop, instead of running forever.
    expect(opened).toBeLessThanOrEqual(12);
  });

  it('reconnects immediately when the operator asks for a retry', async () => {
    const client = makeClient();
    (client as any).connectWebSocket();
    for (let i = 0; i < 40; i += 1) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.drop();
      vi.advanceTimersByTime(60_000);
    }
    expect(statuses[statuses.length - 1].state).toBe('disconnected');

    const before = FakeWebSocket.instances.length;
    client.retryConnection();
    expect(FakeWebSocket.instances.length).toBe(before + 1);
    expect(statuses[statuses.length - 1].state).toBe('reconnecting');
  });

  it('resets the attempt count when the Core comes back', async () => {
    const client = makeClient();
    (client as any).connectWebSocket();
    const socket = FakeWebSocket.instances[0];
    socket.drop();
    vi.advanceTimersByTime(60_000);
    expect((client as any).reconnectAttempt).toBeGreaterThan(0);

    // The Core answers again: the 'connected' frame resets the counter.
    const next = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    (next as any).on_message?.(JSON.stringify({ type: 'connected' }));
    expect((client as any).reconnectAttempt).toBe(0);
    expect(statuses[statuses.length - 1].state).toBe('connected');
  });
});
