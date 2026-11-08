/** @vitest-environment jsdom */
/**
 * Audit: after a launch the window showed an empty "New conversation" while the
 * host still held the conversation restored from selected-conversation.json
 * (the launch-time transcript fetch had failed). The next message silently
 * continued that old conversation with its history. What is sent must match
 * what the person sees.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bootRendererWithRestoredConversation, type ScriptedHost } from './restoredConversationRenderer';

let host: ScriptedHost;
beforeAll(() => { host = bootRendererWithRestoredConversation('conv_old'); });

describe('launch restore whose history cannot be shown', () => {
  it('keeps the pane blank while the restored transcript cannot be fetched', async () => {
    host.coreReady = true;
    host.openFails = true;
    await host.paint({ coreState: 'connected' } as any);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.getElementById('result')!.textContent).not.toContain('Compare the three price lists.');
    expect(host.calls.filter((c) => c.startsWith('openConversation')).length).toBeGreaterThan(0);
  });

  it('a message sent into that blank pane starts a fresh conversation instead of continuing the hidden one', async () => {
    await host.send('What is on my calendar today?');
    const newAt = host.calls.indexOf('newConversation');
    const submitAt = host.calls.findIndex((c) => c.startsWith('submitTask:'));
    expect(newAt).toBeGreaterThanOrEqual(0);
    expect(submitAt).toBeGreaterThan(newAt);
    expect(host.calls[submitAt]).toBe('submitTask:What is on my calendar today?:fresh');
    // The person's own message is what the pane shows — not the old conversation.
    const text = document.getElementById('result')!.textContent ?? '';
    expect(text).toContain('What is on my calendar today?');
    expect(text).not.toContain('Compare the three price lists.');
  });
});
