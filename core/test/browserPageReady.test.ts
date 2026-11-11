import { describe, expect, it } from 'vitest';
import { waitForPageReady, type CdpSession } from '../runtime/browserInspection';

type PageMoment = { readyState: 'loading' | 'interactive' | 'complete'; href: string } | Error;

const PAGE = 'http://127.0.0.1:4173/index.html';

/**
 * A stand-in for the browser tab: each Runtime.evaluate answers from the next
 * scripted moment of the page (the last one repeats), evaluated against that
 * moment's document and location, so the poll is judged by what it really reads.
 */
function scriptedTab(moments: PageMoment[]) {
  let reads = 0;
  const cdp = {
    async send(method: string, params: Record<string, unknown> = {}) {
      expect(method).toBe('Runtime.evaluate');
      const moment = moments[Math.min(reads, moments.length - 1)];
      reads += 1;
      if (moment instanceof Error) throw moment;
      const read = new Function('document', 'location', `return (${String(params.expression)});`);
      return { result: { value: read({ readyState: moment.readyState }, { href: moment.href }) } };
    },
  } as unknown as CdpSession;
  return { cdp, reads: () => reads };
}

describe('waitForPageReady', () => {
  it('does not act on a page at interactive: its module scripts may not have run yet', async () => {
    const tab = scriptedTab([
      { readyState: 'loading', href: PAGE },
      { readyState: 'interactive', href: PAGE },
      { readyState: 'interactive', href: PAGE },
      { readyState: 'complete', href: PAGE },
    ]);
    await expect(waitForPageReady(tab.cdp, 's1', { timeoutMs: 10_000, intervalMs: 1 })).resolves.toBe(true);
    expect(tab.reads()).toBe(4);
  });

  it('does not take the tab\'s initial about:blank, already complete, for the navigated page', async () => {
    const tab = scriptedTab([
      { readyState: 'complete', href: 'about:blank' },
      { readyState: 'complete', href: 'about:blank' },
      { readyState: 'interactive', href: PAGE },
      { readyState: 'complete', href: PAGE },
    ]);
    await expect(waitForPageReady(tab.cdp, 's1', { timeoutMs: 10_000, intervalMs: 1 })).resolves.toBe(true);
    expect(tab.reads()).toBe(4);
  });

  it('accepts about:blank when the navigation may really end there', async () => {
    const tab = scriptedTab([{ readyState: 'complete', href: 'about:blank' }]);
    await expect(waitForPageReady(tab.cdp, 's1', { timeoutMs: 10_000, intervalMs: 1, allowBlank: true })).resolves.toBe(true);
    expect(tab.reads()).toBe(1);
  });

  it('keeps polling when the document being swapped out does not answer', async () => {
    const tab = scriptedTab([
      new Error('Execution context was destroyed.'),
      { readyState: 'complete', href: PAGE },
    ]);
    await expect(waitForPageReady(tab.cdp, 's1', { timeoutMs: 10_000, intervalMs: 1 })).resolves.toBe(true);
    expect(tab.reads()).toBe(2);
  });

  it('gives up at the deadline and lets the caller go on with the page as it is', async () => {
    const tab = scriptedTab([{ readyState: 'interactive', href: PAGE }]);
    await expect(waitForPageReady(tab.cdp, 's1', { timeoutMs: 30, intervalMs: 5 })).resolves.toBe(false);
    expect(tab.reads()).toBeGreaterThan(1);
  });
});
