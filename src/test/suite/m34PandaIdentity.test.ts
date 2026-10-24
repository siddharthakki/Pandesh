import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readResolvedCss } from '../helpers/resolveCssImports';

const mediaDir = path.join(__dirname, '..', '..', '..', 'media');
const read = (name: string) => fs.readFileSync(path.join(mediaDir, name), 'utf8');

const pandaAsset = (file: string) => path.join(mediaDir, 'panda', file);

/** Every approved production asset the UI maps states onto. */
const REFERENCED_ASSETS = [
  'mascot-idle.webp',
  'worker-mini.webp',
  'action-reading.webp',
  'action-thinking.webp',
  'action-approval.webp',
  'action-coding.webp',
  'action-testing.webp',
  'action-building.webp',
  'action-completed.webp',
  'action-blocked.webp',
  'action-failed.webp',
  'action-searching.webp',
  'action-repository.webp',
  'action-delegating.webp',
  'action-reviewing.webp',
  'mascot-success.webp',
  'mascot-done.webp',
];

describe('M34 panda identity: approved assets exist and are packaged', () => {
  it('maps every production state to an existing approved asset with distinct terminal poses', () => {
    const source = read('chat-autonomous.js');
    const mappingBlock = /const PANDA_STATE_TO_FILE = \{([\s\S]*?)\n  \};/.exec(source)?.[1] ?? '';
    const entries = [...mappingBlock.matchAll(/(\w+): '([^']+\.webp)'/g)];
    expect(entries.map(match => match[1]).sort()).toEqual([
      'blocked', 'building', 'cancelled', 'coding', 'completed', 'delegating',
      'failed', 'idle', 'planning', 'reading', 'reviewing', 'searching',
      'testing', 'thinking', 'waiting_for_delivery_approval',
    ]);
    for (const [, , file] of entries) {
      expect(fs.existsSync(pandaAsset(file)), file).toBe(true);
    }
    const asMap = Object.fromEntries(entries.map(([, state, file]) => [state, file]));
    expect(new Set([
      asMap.waiting_for_delivery_approval,
      asMap.completed,
      asMap.blocked,
      asMap.failed,
      asMap.cancelled,
    ]).size).toBe(5);
  });

  it('every state-mapped asset exists under media/panda', () => {
    for (const file of REFERENCED_ASSETS) {
      expect(fs.existsSync(pandaAsset(file)), file).toBe(true);
      expect(fs.statSync(pandaAsset(file)).size, file).toBeGreaterThan(1000);
    }
  });

  it('.vscodeignore does not exclude the panda assets from the VSIX', () => {
    const ignore = fs.readFileSync(path.join(mediaDir, '..', '.vscodeignore'), 'utf8');
    expect(ignore).not.toMatch(/^media[\\/]?\s*$/m);
    expect(ignore).not.toMatch(/media[\\/]panda/);
    expect(ignore).not.toMatch(/^\*\*\/\*\.webp/m);
  });

  it('the extension host substitutes the packaged panda base URI into the webview', () => {
    const agentPanel = fs.readFileSync(path.join(mediaDir, '..', 'src', 'ui', 'AgentPanel.ts'), 'utf8');
    expect(agentPanel).toContain("vscode.Uri.joinPath(mediaUri, 'panda')");
    expect(agentPanel).toContain('{{pandaBaseUri}}');
    const html = read('chat.html');
    expect(html).toContain("'{{pandaBaseUri}}'");
    // CSP permits the webview-resource images the base URI points at.
    expect(html).toMatch(/img-src [^"]*\{\{cspSource\}\}/);
  });
});

describe('M34 panda identity: welcome, phase, approval, outcome, and history surfaces', () => {
  it('the welcome/empty state shows the idle panda with a concise message', () => {
    const html = read('chat.html');
    expect(html).toMatch(/<div id="ambient-placeholder"[^>]*>\s*<span id="everyday-welcome-panda" class="kd-panda-icon kd-panda-icon--welcome">/);
    expect(html).toContain('alt="KarkeDikha panda, ready to help"');
    expect(html).toContain('What would you like to work on?');
    const js = read('chat-everyday.js');
    expect(js).toContain("applyPandaFile(document.getElementById('everyday-welcome-panda'), 'mascot-idle.webp')");
    // Compact: the welcome panda is bounded to 56px, so it cannot dominate the sidebar.
    expect(readResolvedCss(path.join(mediaDir, 'chat-layout-fixes.css'))).toContain('.kd-panda-icon--welcome { width: 56px; height: 56px;');
  });

  it('the bottom phase strip does not render its own panda — the task-message panda is the single active-stage mascot', () => {
    // Regression: the phase strip used to render an independent panda
    // (PHASE_PANDA_FILE, keyed on `everyday.PHASES`) concurrently with the
    // primary active-stage panda in the task message (#autonomous-panda,
    // keyed on PandaStateMapping's PandaState) — two mascots, two vocabularies,
    // sometimes disagreeing. The strip now shows only text; the mascot lives
    // exclusively in the task message.
    const js = read('chat-everyday.js');
    expect(js).not.toContain('PHASE_PANDA_FILE');
    expect(js).not.toContain('everyday-phase-panda');
    const html = read('chat.html');
    expect(html).not.toContain('id="everyday-phase-panda"');
    expect(html).toMatch(/<div id="everyday-phase"[^>]*>\s*<span id="everyday-phase-label"/);
  });

  it('the run-state panda is one compact 42px identity in every state (governed-neon layer wins)', () => {
    const css = readResolvedCss(path.join(mediaDir, 'chat-layout-fixes.css'));
    expect(css).not.toContain('.autonomous-status-header { display: none; }');
    expect(css).toContain('.autonomous-status-header { display: flex; align-items: center;');
    // The effective rule is the last base-width `body .autonomous-status-header .kd-panda-icon--status` block
    // (chat-governed-neon.css is imported after chat-layout-base.css, whose 72px rule it overrides).
    const effective = /body \.autonomous-status-header \.kd-panda-icon--status\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(effective).toMatch(/width: 42px;/);
    expect(effective).toMatch(/height: 42px;/);
    expect(css.indexOf('body .autonomous-status-header .kd-panda-icon--status {')).toBeGreaterThan(
      css.indexOf('.autonomous-status-header .kd-panda-icon--status {\n  width: 72px;'));
    // No state-specific giant panda: no data-state rule resizes the status panda to 84px/96px.
    expect(css).not.toMatch(/kd-panda-icon--status\[data-state="[^"]+"\]\s*\{[^}]*(?:width|height): (?:84|96)px/);
    // The lifecycle mapping that feeds it is untouched.
    const autonomous = read('chat-autonomous.js');
    expect(autonomous).toContain('PANDA_STATE_TO_FILE');
    for (const file of ['action-repository.webp', 'action-approval.webp', 'action-blocked.webp', 'action-failed.webp', 'mascot-success.webp', 'mascot-done.webp']) {
      expect(autonomous).toContain(file);
    }
  });

  it('the run-state panda stays 42px in every narrow-width media query (jsdom does not evaluate media queries)', () => {
    const css = readResolvedCss(path.join(mediaDir, 'chat-layout-fixes.css'));
    const neon = fs.readFileSync(path.join(mediaDir, 'chat-governed-neon.css'), 'utf8');
    // Every rule that targets the status panda inside any @media block must keep the 42px box.
    const mediaBlocks = css.match(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g) ?? [];
    expect(mediaBlocks.length).toBeGreaterThan(0);
    let narrowStatusRules = 0;
    for (const block of mediaBlocks) {
      if (/prefers-reduced-motion/.test(block)) continue;
      for (const m of block.matchAll(/body \.autonomous-status-header \.kd-panda-icon--status\s*\{([^}]*)\}/g)) {
        narrowStatusRules++;
        expect(m[1]).toMatch(/width: 42px;/);
        expect(m[1]).toMatch(/height: 42px;/);
        expect(m[1]).toMatch(/flex-basis: 42px;/);
      }
    }
    expect(narrowStatusRules).toBeGreaterThan(0);
    // The old 82px sidebar-width override must never come back.
    expect(neon).not.toMatch(/kd-panda-icon--status[^}]*(?:width|height|flex-basis): (?:72|82|84|96)px/);
  });

  it('approval cards reuse the single task-message panda instead of duplicating it', () => {
    const html = read('chat.html');
    const approvalPandas = html.match(/kd-panda-icon--approval/g) ?? [];
    expect(approvalPandas).toHaveLength(0);
    expect(html.match(/id="autonomous-panda"/g)).toHaveLength(1);
    for (const id of ['proposal-approve-btn', 'mutation-approve-btn', 'delivery-approve-btn']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('completion and blocker outcome cards do not render a second panda — the task-message panda already reflects the outcome', () => {
    // Regression: these cards used to append their own pandaEl(...), which
    // duplicated the mascot within the same task message and, for cancelled
    // tasks, always showed the "blocked" pose regardless of the actual state.
    const js = read('chat-everyday.js');
    expect(js).not.toContain('function pandaEl(');
    expect(js).not.toMatch(/pandaEl\(/);
  });

  it('the History empty and loading states show the small worker panda', () => {
    const html = read('chat.html');
    expect(html).toMatch(/<span id="everyday-history-panda"[^>]*aria-hidden="true"/);
    const js = read('chat-everyday.js');
    expect(js).toContain("applyPandaFile(document.getElementById('everyday-history-panda'), 'worker-mini.webp')");
    expect(js).toContain('historyPanda.hidden = false');
    expect(js).toContain('historyPanda.hidden = true');
  });
});

describe('M34 panda identity: theme safety and broken-image protection', () => {
  it('a failed image load falls back to the theme-aware inline SVG, never a broken icon', () => {
    const css = readResolvedCss(path.join(mediaDir, 'chat-layout-fixes.css'));
    // The <img> is hidden until a load succeeds, and the currentColor SVG
    // fallback hides only once the image is ready — so a raw broken-image
    // glyph can never appear in either theme.
    expect(css).toContain('.kd-panda-img { display: none;');
    expect(css).toContain('.kd-panda-icon.kd-img-ready .kd-panda-img { display: block; }');
    const autonomous = read('chat-autonomous.js');
    expect(autonomous).toContain("PANDA_STATE_TO_FILE[state] || PANDA_STATE_TO_FILE.idle");
    expect(autonomous).toContain("img.src = `${pandaBaseUri}/${PANDA_STATE_TO_FILE.idle}`");
    expect(css).toContain('.kd-panda-icon.kd-img-ready .kd-panda-fallback { display: none; }');
    const js = read('chat-everyday.js');
    expect(js).toContain("img.onerror = () => container.classList.remove('kd-img-ready')");
    // The inline sprite renders with currentColor, adapting to light and dark themes.
    const html = read('chat.html');
    expect(html).toMatch(/<symbol id="kd-panda-head"[\s\S]*?fill="currentColor"/);
  });

  it('fixed square boxes on every panda surface prevent layout shift', () => {
    const css = readResolvedCss(path.join(mediaDir, 'chat-layout-fixes.css'));
    for (const cls of ['--welcome', '--phase', '--outcome', '--history']) {
      expect(css).toMatch(new RegExp(`\\.kd-panda-icon${cls} \\{ width: \\d+px; height: \\d+px;`));
    }
    const html = read('chat.html');
    expect(html).toMatch(/id="everyday-welcome-panda"[^>]*>\s*<img[^>]*width="56" height="56"/);
  });
});
