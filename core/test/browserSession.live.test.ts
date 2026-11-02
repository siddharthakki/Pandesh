/**
 * Live open-web browsing through a real host browser. Opt-in: needs Edge or
 * Chrome on disk and internet access. Run with PANDESH_LIVE_BROWSER=1.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { resolveHostBrowserBin } from '../runtime/hostBrowserBin';
import { BrowserSessionManager } from '../runtime/browserSession';

const live = process.env.PANDESH_LIVE_BROWSER === '1' && resolveHostBrowserBin() !== null;

describe.skipIf(!live)('live open-web browser session', () => {
  const sessions = new BrowserSessionManager({ browserBin: () => resolveHostBrowserBin(), maxActions: 6 });
  afterAll(() => sessions.stopAll());

  it('navigates several real pages on an approved site and keeps the session', async () => {
    const first = await sessions.openSite('conv', 'https://en.wikipedia.org/wiki/Qwen');
    expect(first.title).toMatch(/Qwen/);
    const alibaba = first.links.find((l) => /\/wiki\/Alibaba_(Group|Cloud)$/.test(l.href));
    expect(alibaba, 'Qwen article links to Alibaba').toBeDefined();

    const second = await sessions.click('conv', { linkIndex: alibaba!.index });
    expect(second.url).toBe(alibaba!.href);
    expect(second.title).toMatch(/Alibaba/);

    const third = await sessions.goto('conv', 'https://en.wikipedia.org/wiki/Large_language_model');
    expect(third.title).toMatch(/Large language model/);

    const back = await sessions.back('conv');
    expect(back.url).toBe(alibaba!.href);
    expect(back.actionsUsed).toBe(4);
    console.log('[live] visited:', [first.url, second.url, third.url, back.url]);
  }, 90_000);

  it('stops navigation to a site the user has not approved', async () => {
    await expect(sessions.goto('conv', 'https://www.iana.org/')).rejects.toMatchObject({ category: 'browser_site_not_approved' });

    const example = await sessions.openSite('other', 'https://example.com/');
    const iana = example.links.find((l) => l.href.includes('iana.org'));
    expect(iana).toBeDefined();
    const after = await sessions.click('other', { linkIndex: iana!.index });
    expect(after.url).not.toContain('iana.org');
    expect(after.blocked.join(' ')).toMatch(/not approved/);
  }, 60_000);

  it('enforces the action budget and closes on Stop', async () => {
    // 'conv' used 5 of 6 actions above (the refused goto also counts).
    await sessions.scroll('conv', 'down');
    await expect(sessions.scroll('conv', 'down')).rejects.toMatchObject({ category: 'browser_action_budget_exhausted' });

    const controller = new AbortController();
    await sessions.openSite('cancel', 'https://example.com/');
    const pending = sessions.goto('cancel', 'https://example.com/?slow', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ category: 'browser_cancelled' });
    expect(sessions.has('cancel')).toBe(false);
  }, 60_000);
});
