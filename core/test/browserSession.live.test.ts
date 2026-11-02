/**
 * Live open-web browsing through a real host browser. Opt-in: needs Edge or
 * Chrome on disk and internet access. Run with PANDESH_LIVE_BROWSER=1.
 */
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { resolveHostBrowserBin } from '../runtime/hostBrowserBin';
import { BrowserSessionManager, browserLocator } from '../runtime/browserSession';

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

  it('fills a public test form; submits only the approved values; a plain click cannot submit', async () => {
    const sessions = new BrowserSessionManager({ browserBin: () => resolveHostBrowserBin(), maxActions: 12 });
    onTestFinished(() => sessions.stopAll());
    const form = await sessions.openSite('form', 'https://httpbin.org/forms/post');
    expect(form.controls.map((c) => c.label).join('|')).toMatch(/Customer name/);
    await sessions.fill('form', { label: 'Customer name:' }, 'Pandesh Stage B');
    await sessions.fill('form', { label: 'Delivery instructions:' }, 'harmless test, no order');

    // Denied/unapproved path: clicking the button directly is refused by the guard.
    const clicked = await sessions.click('form', { locator: { role: 'button', name: 'Submit order' } });
    expect(clicked.url).toBe('https://httpbin.org/forms/post');
    expect(clicked.blocked.join(' ')).toMatch(/needs the user's approval/);

    // Values differing from the approval are refused.
    await sessions.fill('form', { label: 'Customer name:' }, 'Pandesh Stage B');
    await sessions.fill('form', { label: 'Delivery instructions:' }, 'harmless test, no order');
    await expect(sessions.submit('form', { role: 'button', name: 'Submit order' }, { 'Customer name:': 'Someone else', 'Delivery instructions:': 'harmless test, no order' }))
      .rejects.toMatchObject({ category: 'browser_submit_mismatch' });

    const done = await sessions.submit('form', { role: 'button', name: 'Submit order' }, {
      'Customer name:': 'Pandesh Stage B', 'Delivery instructions:': 'harmless test, no order',
    });
    expect(done.url).toBe('https://httpbin.org/post');
    expect(done.text).toContain('"custname": "Pandesh Stage B"');
    expect(done.text).toContain('"comments": "harmless test, no order"');
    console.log('[live] submitted page:', done.url, done.text.slice(0, 400));
  }, 90_000);

  it('fills with the locator shapes small models really sent, and names the fields on a miss', async () => {
    const sessions = new BrowserSessionManager({ browserBin: () => resolveHostBrowserBin(), maxActions: 14 });
    onTestFinished(() => sessions.stopAll());
    const form = await sessions.openSite('shapes', 'https://httpbin.org/forms/post');
    expect(form.controls.find((c) => c.label === 'Customer name')?.name).toBe('custname');

    // Recorded failures: {name} without a role, a guessed name attribute, a type the input does not declare.
    await sessions.fill('shapes', browserLocator({ name: 'Customer name:' })!, 'Pandesh Stage B');
    await expect(sessions.fill('shapes', browserLocator({ css: "input[name='customer_name']" })!, 'x'))
      .rejects.toThrow(/Fields here: .*"Customer name" \(name=custname\)/);
    const filled = await sessions.fill('shapes', browserLocator({ label: 'delivery instructions' })!, 'harmless test, no order');
    expect(filled.controls.find((c) => c.name === 'comments')?.value).toBe('harmless test, no order');

    // A blocked direct click reloads the page and empties it: the old values are no longer offered or sent.
    await sessions.click('shapes', { locator: { text: 'Submit order' } });
    await expect(sessions.pendingForm('shapes')).resolves.toBeNull();
    await sessions.fill('shapes', { label: 'Customer name' }, 'Pandesh Stage B');
    await sessions.fill('shapes', { label: 'Delivery instructions' }, 'harmless test, no order');

    // The model's own key spelling still matches what was typed.
    const done = await sessions.submit('shapes', { text: 'Submit order' }, {
      CUSTOMER_NAME: 'Pandesh Stage B', DELIVERY_INSTRUCTIONS: 'harmless test, no order',
    });
    expect(done.text).toContain('"custname": "Pandesh Stage B"');
  }, 90_000);

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
