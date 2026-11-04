/**
 * The host reports what the operating system really did: delivered only when the toast was accepted,
 * failed (with the reason) otherwise, and nothing is shown when notifications are unsupported.
 */
import { describe, it, expect, vi } from 'vitest';
import { DesktopSession } from '../src/host/desktopSession';

function sessionWith(options: Record<string, unknown>, deliverable: Array<{ id: string; kind: string; title: string; body: string }>) {
  const reports: Array<{ id: string; body: Record<string, unknown> }> = [];
  const channels: Array<Record<string, unknown>> = [];
  const client = {
    registerNotificationChannel: vi.fn(async (input: Record<string, unknown>) => { channels.push(input); return {}; }),
    getNotifications: vi.fn(async () => ({ deliverable })),
    reportNotificationDelivery: vi.fn(async (id: string, body: Record<string, unknown>) => { reports.push({ id, body }); return {}; }),
  };
  const session = new DesktopSession({ productRoot: process.cwd(), ...options } as never);
  (session as unknown as { client: unknown }).client = client;
  return { session, reports, channels };
}

describe('desktop notification delivery', () => {
  it('reports delivered only for a toast the system accepted, and failed with the reason for one it did not', async () => {
    const deliverNotification = vi.fn(async (input: { id: string }) => (input.id === 'n1' ? { ok: true, via: 'windows_toast' } : { ok: false, via: 'windows_toast', error: 'Windows did not confirm' }));
    const { session, reports, channels } = sessionWith(
      { deliverNotification, notificationChannel: () => ({ supported: true, detail: 'Windows desktop notifications (toast)' }) },
      [{ id: 'n1', kind: 'test', title: 'T', body: 'b' }, { id: 'n2', kind: 'task_completed', title: 'T2', body: 'b2' }],
    );
    const result = await session.drainNotifications();
    expect(result).toEqual({ delivered: 1, failed: 1 });
    expect(channels[0]).toMatchObject({ channel: 'desktop', supported: true });
    expect(reports).toEqual([
      { id: 'n1', body: { status: 'delivered', via: 'windows_toast' } },
      { id: 'n2', body: { status: 'failed', via: 'windows_toast', error: 'Windows did not confirm' } },
    ]);
  });

  it('never claims delivery when the system does not support notifications', async () => {
    const deliverNotification = vi.fn(async () => ({ ok: true, via: 'windows_toast' }));
    const { session, reports, channels } = sessionWith(
      { deliverNotification, notificationChannel: () => ({ supported: false, detail: 'unsupported' }) },
      [{ id: 'n1', kind: 'test', title: 'T', body: 'b' }],
    );
    const result = await session.drainNotifications();
    expect(deliverNotification).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(channels[0]).toMatchObject({ supported: false });
    expect(reports[0].body).toMatchObject({ status: 'failed' });
  });

  it('records a thrown delivery as a failure instead of losing it', async () => {
    const deliverNotification = vi.fn(async () => { throw new Error('toast crashed'); });
    const { session, reports } = sessionWith({ deliverNotification }, [{ id: 'n1', kind: 'test', title: 'T', body: 'b' }]);
    await session.drainNotifications();
    expect(reports[0].body).toMatchObject({ status: 'failed', error: 'toast crashed' });
  });
});
