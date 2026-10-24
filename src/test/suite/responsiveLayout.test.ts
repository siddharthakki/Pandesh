// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { cascadeFor, px, type Cascade } from '../helpers/cssCascade';
import { readResolvedCss } from '../helpers/resolveCssImports';
import { renderSetupHtml } from '../../onboarding/OnboardingView';
import { evaluateOnboardingReadiness } from '../../onboarding/OnboardingReadiness';

/**
 * Responsive invariant: resizing may reflow, abbreviate, iconize or move controls into overflow, but may NEVER make a
 * capability unreachable. Verified for the real stylesheets at representative widths (wide editor panel, normal sidebar,
 * narrow sidebar, very narrow sidebar) with a width-aware cascade evaluator (see helpers/cssCascade.ts).
 */
const media = path.join(__dirname, '../../../media');
const WIDTHS = [900, 600, 420, 320] as const;

const chatCss = ['chat.css', 'chat-layout-fixes.css', 'chat-dhaaga.css', 'chat-palette.css', 'chat-responsive.css'].map(f => readResolvedCss(path.join(media, f))).join('\n');

const CRITICAL: Array<[string, string]> = [
  ['New Chat', '#new-conversation-toolbar-btn'],
  ['History', '#history-toggle'],
  ['Activity', '#activity-toggle'],
  ['More', '#overflow-menu-btn'],
  ['Send', '#send-btn'],
  ['Message input', '#user-input'],
  ['Mode selector', '#compact-mode-btn'],
  ['Supervision selector', '#supervision-chip'],
  ['Model selector', '#model-chip'],
  ['Attach', '#attach-btn'],
  // `#stop-btn` and the legacy `#autonomous-composer` are hidden at EVERY width by the unified composer design; the live Stop is:
  ['Stop / cancel', '#unified-task-stop-btn'],
  ['Approve (tool card)', '.approval-buttons .btn-primary'],
  ['Reject (tool card)', '.approval-buttons .btn-danger'],
  ['Approve (proposal)', '#proposal-approve-btn'],
  ['Reject (proposal)', '#proposal-reject-btn'],
  ['Approve (mutation)', '#mutation-approve-btn'],
  ['Approve (delivery)', '#delivery-approve-btn'],
  ['Reject (delivery)', '#delivery-reject-btn'],
];

/** Containers whose declared fixed widths would force controls off-screen at narrow viewports. */
const BASELINE_WIDTH = 1400;
const CONTAINERS = ['body', '.app-shell', '.top-bar', '.top-bar-right', '.workspace', '.chat-window', '.input-area', '.input-shell', '#composer-chips', '#messages', '#operator-context', '.status-row', '.approval-card', '.approval-buttons'];

function mount(): void {
  const html = fs.readFileSync(path.join(media, 'chat.html'), 'utf8');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  // A tool-approval card as chat.js builds it.
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML = '<div class="approval-title">write_file</div><div class="approval-buttons"><button class="btn btn-primary" data-approval-response="approved">Approve</button><button class="btn btn-danger" data-approval-response="rejected">Reject</button></div>';
  document.getElementById('messages')!.appendChild(card);
}

/** Simulates the state in which a control is shown (running task, pending approval): clears `hidden` up the tree. */
function reveal(el: Element): void {
  for (let node: Element | null = el; node; node = node.parentElement) node.removeAttribute('hidden');
}

const accessibleName = (el: Element): string =>
  (el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLElement).textContent || (el as HTMLInputElement).placeholder || '').trim();

function hiddenBy(cascade: Cascade, el: Element, hideLabelAllowed = false): string | undefined {
  for (const { el: node, value } of cascade.chain(el, 'display')) {
    if (value === 'none') return `display:none on ${nameOf(node)} via "${cascade.explain(node, 'display')}"`;
  }
  for (const { el: node, value } of cascade.chain(el, 'visibility')) if (value === 'hidden' || value === 'collapse') return `visibility:${value} on ${nameOf(node)}`;
  for (const { el: node, value } of cascade.chain(el, 'opacity')) if (value !== '' && Number(value) === 0) return `opacity:0 on ${nameOf(node)}`;
  for (const { el: node, value } of cascade.chain(el, 'pointer-events')) if (value === 'none') return `pointer-events:none on ${nameOf(node)}`;
  const own = (prop: string) => cascade.value(el, prop);
  if (['width', 'max-width', 'height', 'max-height'].some(prop => px(own(prop)) === 0)) return 'zero size';
  if (!hideLabelAllowed && px(own('font-size')) === 0 && !el.querySelector('.kd-ic')) return 'font-size:0 hides the only label';
  return undefined;
}

function nameOf(el: Element): string {
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
}

/** An icon-or-label control must show at least one of them. */
function contentVisible(cascade: Cascade, el: Element): boolean {
  const icon = el.querySelector('.kd-ic');
  const label = el.querySelector('.kd-lbl');
  if (!icon && !label) return true;
  const shown = (child: Element | null): boolean => !!child && cascade.value(child, 'display') !== 'none';
  return shown(icon) || shown(label);
}

for (const width of WIDTHS) describe(`chat panel at ${width}px: every critical control stays reachable`, () => {
  let cascade: Cascade;
  let wide: Cascade;
  beforeAll(() => { cascade = cascadeFor(chatCss, { width }); wide = cascadeFor(chatCss, { width: BASELINE_WIDTH }); });

  for (const [name, selector] of CRITICAL) it(name, () => {
    mount();
    const el = document.querySelector(selector);
    expect(el, `${selector} must exist in the markup`).not.toBeNull();
    reveal(el!);
    const why = hiddenBy(cascade, el!);
    // A control hidden at every width by design is not a responsive regression; hidden only when narrow is.
    expect(hiddenBy(wide, el!) ? undefined : why, `${selector} at ${width}px`).toBeUndefined();
    expect(contentVisible(cascade, el!), `${selector} shows neither icon nor label at ${width}px`).toBe(true);
    expect(accessibleName(el!).length, `${selector} needs an accessible name (aria-label/title/text)`).toBeGreaterThan(0);
  });

  it('containers never declare a fixed pixel width that exceeds the viewport (no forced horizontal scroll)', () => {
    mount();
    const offenders: string[] = [];
    for (const selector of CONTAINERS) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        for (const prop of ['width', 'min-width']) {
          const v = px(cascade.value(el, prop));
          if (v !== undefined && v > width) offenders.push(`${selector} ${prop}:${v}px`);
        }
      }
    }
    expect(offenders).toEqual([]);
    for (const el of [document.body, document.querySelector('.app-shell')!]) {
      expect(['scroll', 'auto']).not.toContain(cascade.value(el, 'overflow-x'));
    }
  });

  it('icon-only header buttons keep a usable touch/click target', () => {
    mount();
    for (const selector of ['#new-conversation-toolbar-btn', '#history-toggle', '#activity-toggle', '#overflow-menu-btn']) {
      const el = document.querySelector(selector)!;
      const label = el.querySelector('.kd-lbl');
      const labelHidden = !!label && (cascade.value(label, 'display') === 'none' || /^(0|1px)$/.test(cascade.value(label, 'width')));
      if (!labelHidden) continue;
      expect(px(cascade.value(el, 'min-width')) ?? 0, `${selector} min-width`).toBeGreaterThanOrEqual(28);
      expect(px(cascade.value(el, 'min-height')) ?? 0, `${selector} min-height`).toBeGreaterThanOrEqual(28);
    }
  });

  if (width <= 600) {
    it('the composer wraps instead of pushing Send off-screen, and the message input keeps priority width', () => {
      mount();
      const shell = document.querySelector('.input-shell')!;
      expect(cascade.value(shell, 'flex-wrap')).toBe('wrap');
      const input = document.querySelector('#user-input')!;
      expect(px(cascade.value(input, 'min-width')) ?? 0).toBeLessThanOrEqual(width / 2);
      expect(cascade.value(input, 'flex')).toMatch(/1 1 (100%|\d+(px)?)|1 1 0/);
      expect(cascade.value(document.querySelector('#send-btn')!, 'flex-shrink')).toBe('0');
    });

    it('long model names truncate inside their chip instead of forcing controls off-screen', () => {
      mount();
      const chip = document.querySelector('#model-chip')!;
      expect(cascade.value(chip, 'max-width')).toMatch(/100%|\d+px/);
      const max = px(cascade.value(chip, 'max-width'));
      if (max !== undefined) expect(max).toBeLessThanOrEqual(width);
      const label = document.querySelector('#model-chip-label')!;
      expect(cascade.value(label, 'text-overflow')).toBe('ellipsis');
      expect(cascade.value(label, 'min-width')).toBe('0');
      expect(cascade.value(document.querySelector('#composer-chips')!, 'flex-wrap')).toBe('wrap');
    });

    it('cards and approval buttons can shrink and wrap (min-width:0, flex-wrap)', () => {
      mount();
      expect(cascade.value(document.querySelector('.approval-card')!, 'min-width')).toBe('0');
      expect(cascade.value(document.querySelector('.approval-buttons')!, 'flex-wrap')).toBe('wrap');
    });
  }

  it('the header always offers New Chat, History and Activity (full label, compact, or icon) plus More', () => {
    mount();
    const mode = width > 700 ? 'full' : width > 480 ? 'compact' : 'icon';
    const label = (selector: string) => document.querySelector(`${selector} .kd-lbl`)!;
    const labelShown = (selector: string) => cascade.value(label(selector), 'display') !== 'none' && !/^(0|1px)$/.test(cascade.value(label(selector), 'width'));
    if (mode === 'full') for (const s of ['#new-conversation-toolbar-btn', '#history-toggle', '#activity-toggle']) expect(labelShown(s), s).toBe(true);
    if (mode === 'compact') expect(labelShown('#new-conversation-toolbar-btn')).toBe(false); // compact "+"
    if (mode === 'icon') for (const s of ['#new-conversation-toolbar-btn', '#history-toggle', '#activity-toggle']) expect(labelShown(s), s).toBe(false);
    for (const s of ['#new-conversation-toolbar-btn', '#history-toggle', '#activity-toggle']) {
      expect(document.querySelector(`${s} .kd-ic`), `${s} icon`).not.toBeNull();
      expect(cascade.value(document.querySelector(`${s} .kd-ic`)!, 'display')).not.toBe('none');
    }
  });
});

// ------------------------------------------------------------------------------------------------ Setup

function setupHtml(connect = false): string {
  const base = evaluateOnboardingReadiness({
    providerType: 'ollama',
    provider: { providerType: 'ollama', label: 'Ollama', apiBase: 'http://127.0.0.1:11434', reachable: false, detail: 'down' },
    coreRuntime: { connected: true, state: 'connected', summary: 'ok' },
    candidates: [],
    cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
  });
  const readiness = {
    ...base,
    cloudPool: {
      providers: [{ id: 'groq', displayName: 'Groq', connected: false, enabled: true, freeTierKind: 'recurring' as const, paymentRequired: 'unknown' as const, capabilityTags: ['tools'], quotaExhausted: false, requiresAccountId: false, lastVerifiedAt: '2026-10-06' }],
      localFirst: true as const, useFreeCloud: true, spendMode: 'FREE_ONLY' as const, paidBlocked: true, allowCredits: false, catalogVersion: 'x', connectedCount: 0, availableCount: 0, exhaustedIds: [],
    },
  };
  return renderSetupHtml({ loading: false, readiness, openSections: new Set(), ...(connect ? { connect: { providerId: 'groq' } } : {}) }, 'vscode-test', 'n');
}

for (const width of WIDTHS) describe(`Setup at ${width}px: controls stay reachable and content reflows`, () => {
  const SETUP_CRITICAL = [
    'button[data-act="copyDiagnostics"]', 'button[data-act="recheck"]', 'button[data-act="editEndpoint"]', 'button[data-act="connectProvider"]',
    'button[data-act="refreshCatalog"]', 'input[data-act="toggleUseFreeCloud"]', 'input[data-act="toggleNeverPaid"]', 'button[data-act="configureRouting"]',
  ];

  it('every primary Setup action is present and not hidden by any applicable rule', () => {
    document.documentElement.innerHTML = setupHtml();
    const css = document.querySelector('style')!.textContent!;
    const cascade = cascadeFor(css, { width });
    for (const selector of SETUP_CRITICAL) {
      const el = document.querySelector(selector);
      expect(el, selector).not.toBeNull();
      expect(hiddenBy(cascade, el!, true), `${selector} at ${width}px`).toBeUndefined();
    }
    expect(['scroll', 'auto']).not.toContain(cascade.value(document.body, 'overflow-x'));
  });

  it('rows wrap or stack, buttons wrap, and nothing declares a fixed width wider than the viewport', () => {
    document.documentElement.innerHTML = setupHtml();
    const cascade = cascadeFor(document.querySelector('style')!.textContent!, { width });
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body, .wrap, .card, .block, .provider, .actions, .modal, .kvrow, .page-head'))) {
      for (const prop of ['width', 'min-width']) { const v = px(cascade.value(el, prop)); if (v !== undefined && v > width) offenders.push(`${nameOf(el)} ${prop}:${v}px`); }
    }
    expect(offenders).toEqual([]);
    expect(cascade.value(document.querySelector('.actions')!, 'flex-wrap')).toBe('wrap');
    expect(cascade.value(document.querySelector('.page-head')!, 'flex-wrap')).toBe('wrap');
    if (width <= 620) {
      expect(cascade.value(document.querySelector('.grid')!, 'grid-template-columns')).toBe('1fr');
      expect(cascade.value(document.querySelector('.kvrow')!, 'grid-template-columns')).toBe('1fr');
      expect(cascade.value(document.querySelector('.provider')!, 'grid-template-columns')).toMatch(/^20px 1fr$/);
    }
    if (width <= 420) expect(px(cascade.value(document.body, 'padding')) ?? px(cascade.value(document.body, 'padding-left')) ?? 12).toBeLessThanOrEqual(14);
  });

  it('the Connect panel fits: full-width modal, wrapping actions, key field and Save & test reachable', () => {
    document.documentElement.innerHTML = setupHtml(true);
    const cascade = cascadeFor(document.querySelector('style')!.textContent!, { width });
    for (const selector of ['#connect-key', 'button[data-act="saveProvider"]', 'button[data-act="pasteClipboard"]', 'button[data-act="openKeysPage"][data-mode="vscode"]', 'button[data-act="openKeysPage"][data-mode="external"]', 'button[data-act="closeConnect"]']) {
      const el = document.querySelector(selector);
      expect(el, selector).not.toBeNull();
      expect(hiddenBy(cascade, el!, true), `${selector} at ${width}px`).toBeUndefined();
    }
    const modal = document.querySelector('.modal')!;
    expect(cascade.value(modal, 'width')).toMatch(/min\(\d+px,\s*100%\)|100%/);
    expect(cascade.value(document.querySelector('.scrim')!, 'overflow')).toBe('auto');
  });
});
