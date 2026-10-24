import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readResolvedCss } from '../helpers/resolveCssImports';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');

describe('KarkeDikha panda mascot sprite', () => {
  it('defines a reusable base head symbol and per-state accent glyphs, hidden from assistive tech', async () => {
    const html = await read('chat.html');
    expect(html).toContain('class="kd-panda-sprite" aria-hidden="true"');
    expect(html).toContain('id="kd-panda-head"');
    expect(html).toContain('id="kd-panda-approval"');
    for (const state of ['thinking', 'reading', 'searching', 'planning', 'delegating', 'coding', 'building', 'testing', 'reviewing', 'waiting', 'blocked', 'failed', 'completed']) {
      expect(html).toContain(`id="kd-accent-${state}"`);
    }
  });

  it('gives the mode-rail brand mark and autonomous status header a panda icon instance', async () => {
    const html = await read('chat.html');
    expect(html).toContain('class="brand-mark kd-panda-icon"');
    expect(html).toContain('id="autonomous-panda"');
    expect(html).toContain('id="autonomous-panda-label"');
  });

  it('keeps approval controls while the single evolving task panda owns the pose', async () => {
    const html = await read('chat.html');
    expect(html).toContain('id="kd-panda-approval"');
    expect(html).toContain('id="delivery-approval-card" class="delivery-approval-card kd-dhadkan"');
    expect(html).not.toContain('kd-panda-icon--approval');
    expect(html.match(/id="autonomous-panda"/g)).toHaveLength(1);
  });
});

describe('KarkeDikha Dhadkan (active-surface glow)', () => {
  it('drives Dhadkan class/state from real runtime state, not synthetic progress', async () => {
    const chat = await read('chat.js');
    const autonomous = await read('chat-autonomous.js');
    // Chat: the glow attaches to the thinking indicator / streaming bubble, and is
    // removed on every terminal outcome (done, error, stopped) via one shared helper.
    expect(chat).toContain('function stopDhadkan()');
    expect(chat).toContain("stopDhadkan();");
    expect(chat).toContain("div.className = 'thinking kd-dhadkan';");
    // Autonomous: Dhadkan state is toggled from the server-derived pandaState field.
    expect(autonomous).toContain("statusBox.classList.toggle('kd-dhadkan'");
    expect(autonomous).toContain('function setPandaState(state)');
  });

  it('stops Dhadkan on completion, failure, and cancellation without a synthetic re-trigger', async () => {
    const chat = await read('chat.js');
    // All three terminal branches call the same stop path.
    const doneBranch = chat.slice(chat.indexOf("case 'done':"), chat.indexOf("case 'error':"));
    const errorBranch = chat.slice(chat.indexOf("case 'error':"), chat.indexOf("case 'stopped':"));
    const stoppedBranch = chat.slice(chat.indexOf("case 'stopped':"));
    for (const branch of [doneBranch, errorBranch, stoppedBranch]) {
      expect(branch).toContain('stopDhadkan();');
    }
  });

  it('only ever toggles one active Dhadkan class per surface (idempotent toggle, not additive)', async () => {
    const chat = await read('chat.js');
    expect(chat).toContain("currentAssistantBubble.classList.toggle('kd-dhadkan', isActive)");
  });
});

describe('KarkeDikha CSS motion layer', () => {
  it('defines Dhadkan keyframes using transform/opacity-safe box-shadow only, no blur filters', async () => {
    const css = readResolvedCss(path.join(media, 'chat-layout-fixes.css'));
    expect(css).toContain('@keyframes kd-dhadkan-blue');
    expect(css).toContain('@keyframes kd-dhadkan-amber');
    expect(css).not.toMatch(/kd-dhadkan[\s\S]{0,400}blur\(/);
  });

  it('respects prefers-reduced-motion by disabling animation while preserving state color', async () => {
    const css = readResolvedCss(path.join(media, 'chat-layout-fixes.css'));
    const reducedMotionBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotionBlock).toContain('.kd-dhadkan { animation: none !important;');
    expect(reducedMotionBlock).toContain('box-shadow:');
  });

  it('gives the Kaam ka Dhaaga thread compact per-node connectors including a subagent-branch style', async () => {
    const css = readResolvedCss(path.join(media, 'chat-layout-fixes.css'));
    expect(css).toContain('.kd-thread-node');
    expect(css).toContain('.autonomous-timeline-entry.is-subagent');
    expect(css).toContain('.autonomous-timeline-entry.state-completed .kd-thread-node');
  });

  // Progress & Completion UX V1 (Step 3 closure pass): the proposal and
  // mutation approval cards carry a static data-dhadkan-state in chat.html
  // (never reassigned by JS, unlike the task wrapper) — without a matching
  // state-specific rule they fell back to the base kd-dhadkan-blue "active
  // work" color, making "waiting for you" indistinguishable from "working".
  // (jsdom does not compute `animation-name`, so this is a source-level
  // check, matching this file's other CSS-layer tests.)
  it('gives waiting-for-proposal/mutation approval the same amber rule as waiting-for-delivery, never left on the base active-work blue', async () => {
    const html = await read('chat.html');
    const css = readResolvedCss(path.join(media, 'chat-layout-fixes.css'));
    expect(html).toContain('id="proposal-approval-card" class="delivery-approval-card everyday-approval-card kd-dhadkan" data-dhadkan-state="waiting_for_proposal_approval"');
    expect(html).toContain('id="mutation-approval-card" class="delivery-approval-card everyday-approval-card kd-dhadkan" data-dhadkan-state="waiting_for_mutation_approval"');
    // One rule, all three waiting states, amber — not left to fall through to
    // the base `.kd-dhadkan { animation: kd-dhadkan-blue ... }` rule above it.
    const ruleStart = css.indexOf('.kd-dhadkan[data-dhadkan-state="waiting_for_proposal_approval"]');
    const ruleEnd = css.indexOf('}', ruleStart);
    const rule = css.slice(ruleStart, ruleEnd + 1);
    expect(rule).toContain('data-dhadkan-state="waiting_for_proposal_approval"');
    expect(rule).toContain('data-dhadkan-state="waiting_for_mutation_approval"');
    expect(rule).toContain('data-dhadkan-state="waiting_for_delivery_approval"');
    expect(rule).toMatch(/animation:\s*kd-dhadkan-amber/);
  });
});

describe('KarkeDikha panda state labels (simple visible labels)', () => {
  it('defines the required visible labels for each runtime-driven action state', async () => {
    const autonomous = await read('chat-autonomous.js');
    const required: Record<string, string> = {
      idle: 'ready',
      thinking: 'thinking',
      planning: 'thinking',
      reading: 'reading',
      searching: 'reading',
      delegating: 'working',
      coding: 'working',
      building: 'working',
      testing: 'working',
      reviewing: 'working',
      waiting_for_delivery_approval: 'waiting',
      completed: 'success',
      blocked: 'blocked',
      failed: 'failed',
      cancelled: 'stopped',
    };
    const block = autonomous.match(/const PANDA_STATE_LABELS = \{([\s\S]*?)\n\s*\};/)?.[1] ?? '';
    expect(block).not.toBe('');
    for (const [state, label] of Object.entries(required)) {
      expect(block).toMatch(new RegExp(`\\b${state}: '${label}',`));
    }
    // Obsolete Hinglish action strings must not come back.
    expect(autonomous).not.toContain('Repo dekh raha hoon');
  });

  it('derives the panda label purely from the typed pandaState field sent by the runtime', async () => {
    const autonomous = await read('chat-autonomous.js');
    expect(autonomous).toContain("if (item.pandaState) setPandaState(String(item.pandaState));");
    // Lifecycle pandaState is only consumed when it is a typed string, via the resolver.
    expect(autonomous).toContain("typeof message?.pandaState === 'string' ? message.pandaState : ''");
    expect(autonomous).toContain("typeof item.pandaState === 'string'");
    expect(autonomous).toContain('resolveTaskPandaState(message, latestEventPandaState)');
  });
});
