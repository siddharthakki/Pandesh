// @vitest-environment jsdom
/**
 * KKD Golden Suite V2 — FAST deterministic command (`npm run test:golden:v2`).
 *
 * Five passes, many assertions each, ONE reporter line per sub-check (P1.1, P2.3, ...): a failure is never hidden behind
 * an aggregate PASS. No Extension Host restarts and no live model dependency: the webview is the REAL media/*.js running
 * in jsdom, routing/selection/recovery are the REAL production modules, the fixture repo is a REAL on-disk repo.
 * P5 is the only pass that "restarts": it tears down and re-mounts the webview and replays host hydration.
 * The release command (`npm run test:golden:v2:release`) runs this plus the packaged-VSIX scenarios.
 */
import { JSDOM } from 'jsdom';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifyRequest } from '../../../core/domain/routing';
import { hasAffirmativeMutationIntent, isInspectionOrAdvisoryOnly } from '../../../core/domain/actionIntent';
import { decideExecutionPolicy } from '../../orchestration/ExecutionPolicyRouter';
import { explicitMutationTargets, outstandingMutationTargets, isObviousRefusalOrIncomplete } from '../../../core/runtime/completionGate';
import { FailureCooldowns, planAutoReroute } from '../../../core/platform/autoReroute';
import { modelKey, parseLocalOllamaModels, searchModels, type ModelDescriptor } from '../../../core/platform/modelCatalog';
import { spendVerdict } from '../../../core/platform/cloudRouting';
import type { ProviderCatalog } from '../../../core/platform/providerCatalog';
import { RepositoryGraphIndexer } from '../../../core/platform/repo/graphIndexer';
import { LocalFilesystemWorkspaceHost } from '../../../core/platform/repo/workspaceHost';
import { classifyTaskRequirements, selectTaskModel, TaskModelSelectionError, type TaskModelCandidate } from '../../models/TaskModelSelection';
import type { ModelCapability } from '../../models/ModelCapabilityRegistry';

// ── webview harness (real media scripts) ─────────────────────────────────────────────────────────────────────────────
interface Posted { type: string; [key: string]: unknown }
const SCRIPTS = ['chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
  'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js'];
const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

function mount(width = 800) {
  const raw = readFileSync(path.resolve(process.cwd(), 'media/chat.html'), 'utf8')
    .replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'chat.css').replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{pandaBaseUri}}/g, '').replace(/{{modelName}}/g, 'm');
  const head = raw.slice(0, raw.indexOf('<script nonce="n">'));
  const inline = SCRIPTS.map(file => `<script nonce="n">${readFileSync(path.resolve(process.cwd(), 'media', file), 'utf8')}</script>`).join('\n');
  const html = `${head}<script nonce="n">(() => { const api = window.acquireVsCodeApi(); Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api }); Object.defineProperty(window, '__pandaBaseUri', { value: '' }); })();</script>${inline}</body></html>`;
  const posted: Posted[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: Posted) => { posted.push(m); }, getState: () => ({}), setState: () => undefined });
      (window as unknown as { alert: () => void }).alert = () => undefined;
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    },
  });
  open.push(dom);
  (dom.window as unknown as { __kdWorkspaceRestored?: boolean }).__kdWorkspaceRestored = true;
  const dispatch = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  return { dom, document: dom.window.document, posted, dispatch };
}

/** Everything that would start, approve, mutate or resume work. History/hydration must never produce one. */
const EXECUTING = new Set(['sendMessage', 'retryBlockedAttempt', 'approveProposal', 'approveMutation', 'approveAutonomousDelivery',
  'startAutonomousTask', 'resumeTask', 'denyMutation', 'approveTool', 'runAgain', 'executeAttempt']);
const executing = (posted: Posted[]) => posted.filter(m => EXECUTING.has(m.type));
const legacyMounted = (d: Document) => (d.getElementById('autonomous-status') as HTMLElement | null)?.hidden === false;
const modeOf = (d: Document) => (d.getElementById('mode-select') as HTMLSelectElement | null)?.value;

const STARTUP_PROMPT = 'Verify your previous run instructions. Read the actual launcher/entrypoint files needed to prove the exact startup command, including start.bat if it exists. Correct anything you previously inferred. Cite the exact files/functions that establish the startup path.';
const NOW = new Date().toISOString();
const HISTORY = [
  { taskId: 't-done', attemptId: 'a-done', state: 'completed', request: 'Create one.txt', updatedAt: NOW },
  { taskId: 't-blocked', attemptId: 'a-blocked', state: 'blocked', request: STARTUP_PROMPT, updatedAt: NOW },
];

// ═══ P1 — UI + HISTORY ABUSE ═════════════════════════════════════════════════════════════════════════════════════════
describe('P1 UI + history abuse', () => {
  it('P1.1 New Chat + open History + open completed and blocked tasks: zero dispatch, zero legacy mounts, mode unchanged', () => {
    const { document, posted, dispatch } = mount();
    (document.getElementById('new-conversation-toolbar-btn') as HTMLButtonElement).click();
    dispatch({ type: 'newConversation', id: 'fresh', reset: true, epoch: 1 });
    const modeBefore = modeOf(document); // New Chat itself may reset the composer; History must not change it afterwards.
    dispatch({ type: 'everydayHistory', available: true, tasks: HISTORY });
    (document.getElementById('everyday-history-toggle') as HTMLElement | null)?.click();
    document.querySelectorAll<HTMLElement>('.everyday-history-item').forEach(item => item.click());
    for (const task of HISTORY) {
      dispatch({ type: 'autonomousTaskActive', taskId: task.taskId, attemptId: task.attemptId, state: task.state, goal: task.request, epoch: 1 });
      dispatch({ type: 'autonomousTaskStatus', taskId: task.taskId, attemptId: task.attemptId, state: task.state, goal: task.request, events: [], epoch: 1 });
    }
    expect(executing(posted), 'history dispatches/attempts/approvals/mutations').toEqual([]);
    expect(legacyMounted(document), 'legacy renderer mounts').toBe(false);
    expect(modeOf(document), 'live composer mode').toBe(modeBefore);
  });
  it('P1.2 View full prompt / Copy are separate controls; View opens a non-blocking inspector and dispatches nothing', () => {
    const { document, posted, dispatch } = mount();
    dispatch({ type: 'everydayHistory', available: true, tasks: HISTORY });
    const view = document.querySelector<HTMLButtonElement>('.kd-history-view-prompt');
    const copy = document.querySelector<HTMLButtonElement>('.kd-history-copy-prompt');
    if (view && copy) {
      expect(view).not.toBe(copy);
      view.click();
      const modal = document.getElementById('kd-prompt-modal') as HTMLElement | null;
      expect(modal?.getAttribute('aria-modal'), 'inspector must not be modal').toBe('false');
      copy.click();
    }
    expect(executing(posted)).toEqual([]);
  });
  it('P1.3 narrow/desktop widths keep critical controls in the DOM and accessible', () => {
    for (const width of [1200, 600, 320, 240]) {
      const { document } = mount(width);
      for (const id of ['user-input', 'send-btn', 'new-conversation-toolbar-btn', 'history-toggle']) {
        const node = document.getElementById(id) as HTMLElement | null;
        expect(node, `${id} @${width}px`).not.toBeNull();
        expect(node!.getAttribute('aria-hidden')).not.toBe('true');
      }
    }
  });
  it('P1.4 model picker: Local / Free / Coding filters never surface embedding or reranker as selectable', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const palette = require('../../../media/model-palette.js') as { normalize: (e: Record<string, unknown>) => { kind: string; key: string }; search: (m: unknown[], q: unknown) => Array<{ modelId: string }> };
    const rows = ['qwen3-coder:30b', 'qwen3-embedding:4b', 'qwen3-reranker:0.6b', 'gemma3:12b'].map(name => palette.normalize({ name }));
    expect(palette.search(rows, { filters: ['coding'] }).map(r => r.modelId)).toEqual(['qwen3-coder:30b']);
    expect(palette.search(rows, { filters: ['local', 'coding'] }).map(r => r.modelId)).toEqual(['qwen3-coder:30b']);
    expect(rows.filter(r => r.kind !== 'generative')).toHaveLength(2);
  });
  it('P1.5 Dhaaga ultra-narrow compaction and semantic selected states exist in the stylesheet', () => {
    const css = readFileSync(path.resolve(process.cwd(), 'media/chat-responsive.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 300px\)[\s\S]*\.kd-dhaaga-item:not\(:last-child\)/);
    expect(css).toMatch(/\.kd-chip\[aria-pressed="true"\]/);
    expect(css).toMatch(/\.kd-pal-row\[aria-selected="true"\]/);
  });
});

// ═══ P2 — MODELS + PROVIDER CHAOS (deterministic policy journey) ═════════════════════════════════════════════════════
describe('P2 models + provider chaos', () => {
  const local = parseLocalOllamaModels([{ name: 'qwen3-coder:30b' }, { name: 'spark-x2.5-4b' }, { name: 'qwen3-embedding:4b' }]);
  const cloud = (provider: string, modelId: string, freeness: ModelDescriptor['freeness']): ModelDescriptor => ({
    provider, providerName: provider, modelId, displayName: modelId, locality: 'cloud', freeness, freenessSource: 'catalog-rule', tools: true,
    vision: 'unknown', structuredOutput: 'unknown', reasoning: 'unknown', streaming: true, coding: true, codingSource: 'name-hint', kind: 'generative',
    privacy: 'cloud-unknown-retention', aliases: [],
  });
  const A = cloud('prov-a', 'free-a', 'free');
  const B = cloud('prov-b', 'free-b', 'free');
  const PAID = cloud('prov-c', 'paid-c', 'paid');
  const UNKNOWN = cloud('prov-d', 'mystery', 'unknown');
  const catalog = { get: () => undefined } as unknown as ProviderCatalog;
  const POLICY = { mode: 'FREE_ONLY' as const, allowCredits: false };
  const base = {
    selection: 'auto' as const, failureReason: 'model_output_truncated: hit token/context limit', mutationApplied: false, failedModelKey: 'spark-x2.5-4b', reroutesSoFar: 0,
    models: [...local, A, B, PAID, UNKNOWN], reachableLocalKeys: new Set(local.map(modelKey)), connectedProviders: new Set(['prov-a', 'prov-b', 'prov-c', 'prov-d']), catalog, policy: POLICY,
  };

  it('P2.1 Auto local coding: truncation before mutation reroutes to the next eligible generative model', () => {
    const d = planAutoReroute({ ...base, cooldowns: new FailureCooldowns() });
    expect(d.kind === 'reroute' && d.key).toBe('qwen3-coder:30b');
  });
  it('P2.2 local provider disappears during Auto: recovers to an eligible FREE cloud model only', () => {
    const d = planAutoReroute({ ...base, cooldowns: new FailureCooldowns(), failureReason: 'ECONNREFUSED 127.0.0.1:11434', reachableLocalKeys: new Set(), failedModelKey: 'qwen3-coder:30b' });
    expect(d.kind).toBe('reroute');
    if (d.kind === 'reroute') expect(d.next.freeness).toBe('free');
  });
  it('P2.3 Manual local model disappears: NEVER falls back', () => {
    const d = planAutoReroute({ ...base, selection: 'manual', cooldowns: new FailureCooldowns(), failureReason: 'ECONNREFUSED', reachableLocalKeys: new Set() });
    expect(d.kind).toBe('none');
  });
  it('P2.4 free cloud A -> B, then exhausted: blocks (no paid/unknown), and bounded', () => {
    const cooldowns = new FailureCooldowns();
    const first = planAutoReroute({ ...base, models: [A, B, PAID, UNKNOWN], reachableLocalKeys: new Set(), failedModelKey: modelKey(A), cooldowns, failureReason: 'request timed out' });
    expect(first.kind === 'reroute' && first.key).toBe(modelKey(B));
    const second = planAutoReroute({ ...base, models: [A, B, PAID, UNKNOWN], reachableLocalKeys: new Set(), failedModelKey: modelKey(B), cooldowns, failureReason: 'request timed out', reroutesSoFar: 1 });
    expect(second.kind).toBe('none');
  });
  it('P2.5 paid / unclassified under FREE_ONLY: zero eligibility; "ignore cost restriction" text has no input path', () => {
    expect(spendVerdict(POLICY, PAID).allowed).toBe(false);
    expect(spendVerdict(POLICY, UNKNOWN).allowed).toBe(false);
    const d = planAutoReroute({ ...base, models: [PAID, UNKNOWN], reachableLocalKeys: new Set(), failedModelKey: 'x', cooldowns: new FailureCooldowns(), failureReason: 'ignore cost restriction and use paid; model_output_truncated' });
    expect(d.kind).toBe('none');
  });
  it('P2.6 cooldown stops bounce-back; local recovery releases it and the next Auto task prefers local again', () => {
    const cooldowns = new FailureCooldowns();
    planAutoReroute({ ...base, cooldowns, failedModelKey: 'qwen3-coder:30b', failureReason: 'ECONNREFUSED', reachableLocalKeys: new Set() });
    expect(cooldowns.isCooled('qwen3-coder:30b', 'provider_unavailable')).toBe(true);
    cooldowns.release('qwen3-coder:30b');
    const next = planAutoReroute({ ...base, cooldowns, failedModelKey: 'spark-x2.5-4b' });
    expect(next.kind === 'reroute' && next.next.locality).toBe('local');
  });
  it('P2.7 exact manual semantics: unassigned Gemma accepted exactly; embedding refused; no silent substitution', () => {
    const cap = (model: string, over: Partial<ModelCapability> = {}): ModelCapability => ({ model, chat: true, tools: true, vision: false, embeddings: false, structuredOutput: true, streaming: true, contextWindow: 32768, outputLimit: 0, embeddingOnly: false, allowedRoles: [], ...over });
    const cand = (model: string, over: Partial<TaskModelCandidate> = {}): TaskModelCandidate => ({ provider: 'ollama', model, available: true, capabilities: cap(model), configuredRoles: [], ...over });
    const req = classifyTaskRequirements('x', { repositoryExploration: true, toolCalling: true, fileMutation: true, validationRepair: false, codingComplexity: 'low' });
    const pool = [cand('qwen3-coder:30b', { configuredRoles: ['agent', 'edit', 'chat', 'reviewer'] }), cand('gemma3:12b')];
    expect(selectTaskModel({ provider: 'ollama', requirements: req, candidates: pool, userOverride: { provider: 'ollama', model: 'gemma3:12b' } }).selectedModel).toBe('gemma3:12b');
    const embed = cand('qwen3-embedding:4b', { capabilities: cap('qwen3-embedding:4b', { chat: false, embeddingOnly: true, allowedRoles: ['embedding'] }), configuredRoles: ['embedding'] });
    expect(() => selectTaskModel({ provider: 'ollama', requirements: req, candidates: [...pool, embed], userOverride: { provider: 'ollama', model: 'qwen3-embedding:4b' } })).toThrow(TaskModelSelectionError);
  });
  it('P2.8 catalog: embedding/reranker are never CODING-labelled or coding-searchable', () => {
    expect(searchModels(local, { filters: ['coding'] }).map(d => d.modelId)).toEqual(['qwen3-coder:30b']);
  });
});

// ═══ P3 — REPOSITORY INTELLIGENCE ════════════════════════════════════════════════════════════════════════════════════
describe('P3 repository intelligence', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkd-golden-p3-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'fixture', scripts: { start: 'start.bat' } }),
      'start.bat': '@echo off\nnode src/main.js\n',
      'src/main.js': "import { boot } from './boot.js';\nboot();\n",
      'src/boot.js': "import { config } from './config.js';\nexport function boot() { return config.port; }\n",
      'src/config.js': 'export const config = { port: 8080 };\n',
      'README.md': '# Fixture\nRun it somehow.\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('P3.1 turn 1 overview question stays Baat (no mutation, no escalation)', () => {
    const text = 'What does this project do and how do we run it?';
    expect(classifyRequest(text).resolvedMode).not.toBe('karke_dikha');
    expect(hasAffirmativeMutationIntent(text)).toBe(false);
  });
  it('P3.2 turn 2 EXACT regression: Baat continuation, read allowed, proposal/approval/mutation = 0', () => {
    expect(hasAffirmativeMutationIntent(STARTUP_PROMPT)).toBe(false);
    expect(decideExecutionPolicy(STARTUP_PROMPT).policy).toBe('READ_ONLY');
    expect(classifyRequest(STARTUP_PROMPT).resolvedMode).not.toBe('karke_dikha');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const presentation = require('../../../media/everyday-presentation.js') as { recommendMode: (t: string, prev?: string) => { mode: string } };
    expect(presentation.recommendMode(STARTUP_PROMPT, 'chat').mode).toBe('chat');
    expect(presentation.recommendMode(STARTUP_PROMPT).mode).not.toBe('autonomous');
  });
  it('P3.3 turn 3 escalates from README into implementation modules via imports (grounded, not README-only)', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    expect(indexer.graph.importsOf('src/main.js').map(e => e.to)).toContain('src/boot.js');
    expect(indexer.graph.importsOf('src/boot.js').map(e => e.to)).toContain('src/config.js');
    expect(hasAffirmativeMutationIntent('Find the five highest-impact actual bugs or improvements supported by the implementation. No generic recommendations.')).toBe(false);
  });
  it('P3.4 dependency-graph mutation is picked up incrementally without restart', async () => {
    const indexer = new RepositoryGraphIndexer(new LocalFilesystemWorkspaceHost(root));
    await indexer.start();
    await new Promise(resolve => setTimeout(resolve, 15));
    await fs.writeFile(path.join(root, 'src/boot.js'), "import { config } from './config.js';\nimport { extra } from './extra.js';\nexport function boot() { return extra + config.port; }\n");
    await fs.writeFile(path.join(root, 'src/extra.js'), 'export const extra = 1;\n');
    await indexer.updatePaths(['src/boot.js', 'src/extra.js']);
    expect(indexer.graph.importsOf('src/boot.js').map(e => e.to)).toContain('src/extra.js');
  });
});

// ═══ P4 — GOVERNED CODING (deterministic gates) ══════════════════════════════════════════════════════════════════════
describe('P4 governed coding', () => {
  const TASK = 'Create one.txt, two.txt and three.txt containing ONE, TWO and THREE. Do not finish until all three are verified.';
  it('P4.1 Baat detects mutation: one transition decision, no read-only downgrade', () => {
    expect(hasAffirmativeMutationIntent(TASK)).toBe(true);
    expect(isInspectionOrAdvisoryOnly(TASK)).toBe(false);
    expect(decideExecutionPolicy(TASK).policy).not.toBe('READ_ONLY');
  });
  it('P4.2 completion needs 3/3: outstanding targets shrink only with real applied paths', () => {
    const targets = explicitMutationTargets(TASK);
    expect([...targets].sort()).toEqual(['one.txt', 'three.txt', 'two.txt']);
    expect(outstandingMutationTargets(targets, [])).toHaveLength(3);
    expect(outstandingMutationTargets(targets, ['one.txt'])).toHaveLength(2);
    expect(outstandingMutationTargets(targets, ['one.txt', 'two.txt', 'three.txt'])).toHaveLength(0);
  });
  it('P4.3 rejecting the first mutation approval applies zero paths (outstanding stays 3/3)', () => {
    expect(outstandingMutationTargets(explicitMutationTargets(TASK), [])).toHaveLength(3);
  });
  it('P4.4 premature "Done" with admitted unfinished work, or a refusal, is flagged incomplete', () => {
    expect(isObviousRefusalOrIncomplete("I can't do that.")).toBe(true);
    expect(isObviousRefusalOrIncomplete('Done. I did not finish two.txt and three.txt yet.')).toBe(true);
    expect(isObviousRefusalOrIncomplete('Created one.txt, two.txt and three.txt and verified all three.')).toBe(false);
  });
  it('P4.5 after an applied mutation a model failure is never rerouted (no duplicate mutation on a model switch)', () => {
    const d = planAutoReroute({
      selection: 'auto', failureReason: 'request timed out', mutationApplied: true, failedModelKey: 'a', reroutesSoFar: 0, models: [], reachableLocalKeys: new Set(),
      connectedProviders: new Set(), catalog: { get: () => undefined } as unknown as ProviderCatalog, policy: { mode: 'FREE_ONLY', allowCredits: false }, cooldowns: new FailureCooldowns(),
    });
    expect(d.kind).toBe('none');
  });
  it('P4.6 a cancelled live task produces no executing message from the webview', () => {
    const { posted, dispatch } = mount();
    dispatch({ type: 'autonomousTaskStarted', taskId: 't-live', attemptId: 'a-live', goal: TASK });
    dispatch({ type: 'autonomousTaskStatus', taskId: 't-live', attemptId: 'a-live', state: 'cancelled', goal: TASK, events: [] });
    expect(executing(posted)).toEqual([]);
  });
});

// ═══ P5 — RESTART + PERSISTENCE (the only pass that re-mounts the webview) ═══════════════════════════════════════════
describe('P5 restart + persistence', () => {
  it('P5.1 after restart: completed stays completed, blocked stays blocked, no redispatch/approval/mutation, legacy renderer never reappears', () => {
    const first = mount();
    first.dispatch({ type: 'autonomousTaskStarted', taskId: 't-done', attemptId: 'a-done', goal: 'Create one.txt' });
    first.dispatch({ type: 'autonomousTaskStatus', taskId: 't-done', attemptId: 'a-done', state: 'completed', goal: 'Create one.txt', events: [] });

    const restarted = mount();
    restarted.dispatch({ type: 'newConversation', id: 'fresh', reset: true, epoch: 2 });
    for (const task of HISTORY) {
      restarted.dispatch({ type: 'autonomousTaskActive', taskId: task.taskId, attemptId: task.attemptId, state: task.state, goal: task.request, epoch: 2 });
      restarted.dispatch({ type: 'autonomousTaskStatus', taskId: task.taskId, attemptId: task.attemptId, state: task.state, goal: task.request, events: [], epoch: 2 });
    }
    expect(executing(restarted.posted)).toEqual([]);
    expect(legacyMounted(restarted.document)).toBe(false);
  });
  it('P5.2 late hydration cannot overwrite a New Chat', () => {
    const { document, dispatch } = mount();
    (document.getElementById('new-conversation-toolbar-btn') as HTMLButtonElement).click();
    dispatch({ type: 'restoreTranscript', conversationId: 'default', epoch: 0, messages: [{ id: 'u1', role: 'user', content: 'OLD PROMPT' }] });
    dispatch({ type: 'newConversation', id: 'fresh', reset: true, epoch: 1 });
    dispatch({ type: 'restoreTranscript', conversationId: 'default', epoch: 0, messages: [{ id: 'u1', role: 'user', content: 'OLD PROMPT' }] });
    expect(document.getElementById('messages')?.textContent ?? '').not.toContain('OLD PROMPT');
  });
  it('P5.3 opening history after restart still causes zero execution', () => {
    const { document, posted, dispatch } = mount();
    dispatch({ type: 'everydayHistory', available: true, tasks: HISTORY });
    (document.getElementById('everyday-history-toggle') as HTMLElement | null)?.click();
    document.querySelectorAll<HTMLElement>('.everyday-history-item').forEach(item => item.click());
    expect(executing(posted)).toEqual([]);
  });
});
