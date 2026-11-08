/** @vitest-environment jsdom */
/**
 * Counterpart of restoredConversationHidden.test.ts: when Core finishes starting
 * after the launch-time fetch gave up, the restored conversation's history is
 * fetched again and shown, and a message then continues it — because that is
 * what the person sees.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bootRendererWithRestoredConversation, type ScriptedHost } from './restoredConversationRenderer';

let host: ScriptedHost;
beforeAll(() => { host = bootRendererWithRestoredConversation('conv_old'); });

describe('launch restore while Core is still starting — Core then connects', () => {
  it('retries the restored transcript once Core is connected and shows its history', async () => {
    await host.paint({});
    await new Promise((resolve) => setTimeout(resolve, 3200)); // connect retry exhausted; next retry may run
    expect(document.getElementById('result')!.textContent).not.toContain('Compare the three price lists.');

    host.coreReady = true;
    await host.paint({ coreState: 'connected' } as any);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = document.getElementById('result')!;
    expect(result.hidden).toBe(false);
    expect(result.textContent).toContain('Compare the three price lists.');
    expect(result.textContent).toContain('The cheapest is 64 EUR.');
  }, 10_000);

  it('a message then continues the conversation that is on screen', async () => {
    await host.send('And the second cheapest?');
    expect(host.calls).not.toContain('newConversation');
    expect(host.calls.find((c) => c.startsWith('submitTask:'))).toBe('submitTask:And the second cheapest?:conv_old');
  });
});
