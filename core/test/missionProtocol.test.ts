import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { loadLoopContinuation, appendContinuationDelta, continuationSuffix } from '../domain/attemptLoopContinuation';
import type { ModelBackend, ModelChatMessage, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { decodeMissionTurn } from '../runtime/missionActions';
import { AUTHORIZE_MISSION_TOOL } from '../runtime/missionAuthorization';
import { compactMissionContext, MISSION_CONTEXT_BUDGET_CHARS } from '../runtime/missionCompaction';
import { completionRefusal, fingerprintText, readWorkspaceRange } from '../runtime/missionObservations';
import { executeMissionAction, MISSION_SYSTEM_PROMPT, rejectFreeFormCommand } from '../runtime/missionLoop';
import { protocolCorrectionObservation, summarizeRejectedMissionCalls } from '../runtime/missionProtocol';
import { MAX_DECISION_TURNS, MAX_IDENTICAL_SEARCH_RETURNS, resolveRepeatedSearch } from '../runtime/missionProgress';
import { classifyScopedCommand, argvForCheck, type MissionEnvelope } from '../runtime/scopedCommand';
import { searchWorkspace } from '../runtime/missionSearch';
import {
  boundedRepositoryContext,
  copyMissingHelperFixture,
  FIXED_APP_JS,
  gitInitFixture,
  MISSING_HELPER_TASK,
} from './missionFixture';

const TOKEN = generateToken();
const FIXED_APP = FIXED_APP_JS;
const emptyEvidence = {
  approvedMutation: false,
  validationPassed: false,
  diffReview: 'pending' as const,
};

describe('mission action decoding', () => {
  it('accepts exactly one structured action', () => {
    const decoded = decodeMissionTurn([{ name: 'search', arguments: { query: 'formatMoney' } }]);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.action).toEqual({ action: 'search', query: 'formatMoney', path: undefined });
      expect(decoded.extraRejected).toBe(0);
    }
  });

  it('rejects extra tool calls without executing them', () => {
    const decoded = decodeMissionTurn([
      { name: 'search', arguments: { query: 'a' } },
      { name: 'read_file', arguments: { path: 'src/app.js' } },
    ]);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.extraRejected).toBe(1);
      expect(decoded.errors.join(' ')).toMatch(/exactly one action/);
    }
  });

  it('rejects an empty turn', () => {
    const decoded = decodeMissionTurn([]);
    expect(decoded.ok).toBe(false);
  });

  it('records safe summaries for a rejected multi-call response without file content', () => {
    const calls = [
      { name: 'search', arguments: { query: 'tip calculator' } },
      { name: 'propose_file_change', arguments: { path: 'index.html', content: '<button id="reset">Reset</button>' } },
    ];
    const decoded = decodeMissionTurn(calls);
    expect(decoded.ok).toBe(false);
    const observation = protocolCorrectionObservation(calls, decoded.ok ? [] : decoded.errors);
    expect(observation.action).toBe('protocol_correction');
    expect(observation.ok).toBe(false);
    expect(observation.output).toMatch(/no action ran/);
    expect(observation.output).toMatch(/Resend exactly one selected action/);
    expect(observation.rejectedCalls).toHaveLength(2);
    expect(observation.rejectedCalls?.[0]).toEqual({
      name: 'search',
      summary: { query: 'tip calculator', path: null },
    });
    expect(observation.rejectedCalls?.[1]?.summary).toMatchObject({
      path: 'index.html',
      contentLength: Buffer.byteLength('<button id="reset">Reset</button>', 'utf8'),
    });
    expect(JSON.stringify(observation.rejectedCalls)).not.toContain('<button');
    expect(summarizeRejectedMissionCalls(calls)[1].summary.contentDigest).toMatch(/^sha256:/);
  });
});

describe('ranged reads and bounded observations', () => {
  it('treats multi-word search as token OR and allows a directory scope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-search-'));
    try {
      copyMissingHelperFixture(dir);
      gitInitFixture(dir);
      const observation = searchWorkspace({ workspaceRoot: dir, query: 'formatMoney currency cents', scopePath: 'src' });
      expect(observation.ok).toBe(true);
      expect(observation.output).toContain('src/money.js');
      expect(observation.resultCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not advertise host verification plans as search hits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-search-host-'));
    try {
      copyMissingHelperFixture(dir);
      fs.mkdirSync(path.join(dir, '.karkedikha'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.karkedikha', 'verification-plan.json'),
        JSON.stringify({
          version: 1,
          page: 'index.html',
          acceptanceCriteria: ['formatMoney checkout displays the expected total'],
          dependsOn: ['src/app.js'],
          checks: [{ id: 'formatMoney', steps: [], expect: [] }],
        }),
        'utf8',
      );
      gitInitFixture(dir);
      const observation = searchWorkspace({ workspaceRoot: dir, query: 'formatMoney checkout' });
      expect(observation.ok).toBe(true);
      expect(observation.output).toContain('src/money.js');
      expect(observation.output).not.toMatch(/\.karkedikha\//);
      expect(observation.output).not.toContain('verification-plan.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects model reads of host-owned verification plans', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-host-read-'));
    try {
      copyMissingHelperFixture(dir);
      fs.mkdirSync(path.join(dir, '.karkedikha'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.karkedikha', 'verification-plan.json'), '{"version":1}', 'utf8');
      gitInitFixture(dir);
      const observation = readWorkspaceRange({
        workspaceRoot: dir,
        requestedPath: '.karkedikha/verification-plan.json',
      });
      expect(observation.ok).toBe(false);
      expect(observation.output).toMatch(/host-owned/);
      expect(observation.output).not.toContain('version');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns path, range, result count, truncation, and fingerprint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-read-'));
    try {
      const lines = Array.from({ length: 80 }, (_, i) => `line-${i + 1} ${'x'.repeat(80)}`);
      fs.writeFileSync(path.join(dir, 'wide.txt'), lines.join('\n'), 'utf8');
      const observation = readWorkspaceRange({
        workspaceRoot: dir,
        requestedPath: 'wide.txt',
        startLine: 2,
        endLine: 4,
      });
      expect(observation.ok).toBe(true);
      expect(observation.path).toBe('wide.txt');
      expect(observation.range).toBe('2-4');
      expect(observation.resultCount).toBe(3);
      expect(observation.fingerprint).toBe(fingerprintText(lines.join('\n')));
      expect(observation.output).toContain('2|line-2');
      expect(observation.truncated).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks truncation when the excerpt exceeds the observation budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-trunc-'));
    try {
      fs.writeFileSync(path.join(dir, 'big.txt'), 'N'.repeat(12_000), 'utf8');
      const observation = readWorkspaceRange({ workspaceRoot: dir, requestedPath: 'big.txt' });
      expect(observation.truncated).toBe(true);
      expect(observation.output).toContain('…[truncated]');
      expect(observation.fingerprint).toMatch(/^sha256:/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a path outside the selected repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-outside-'));
    try {
      const observation = readWorkspaceRange({
        workspaceRoot: dir,
        requestedPath: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts',
      });
      expect(observation.ok).toBe(false);
      expect(observation.output).toMatch(/blocked|outside|Repository path/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('deterministic mission compaction', () => {
  const evidence = {
    approvedMutation: true,
    approvedPath: 'src/app.js',
    validationPassed: true,
    validationCommand: 'node --test',
    validationExitCode: 0,
    diffReview: 'pass' as const,
    commitSha: 'abc123',
    deliveryStatus: 'local_commit' as const,
  };

  it('pins goal, acceptance, permissions, diff, tests, and unique current read bodies while under budget', () => {
    const ledger = [1, 2, 3].map((n) => ({
      observation: {
        action: 'read_file' as const,
        path: `file${n}.js`,
        range: '1-2',
        resultCount: 2,
        truncated: false,
        fingerprint: `sha256:file${n}`,
        ok: true,
        output: `BODY-${n}-${'z'.repeat(80)}`,
      },
    }));
    const compacted = compactMissionContext({
      goal: 'fix checkout',
      acceptanceCriteria: ['tests pass'],
      permissions: ['search'],
      currentDiff: 'src/app.js',
      latestTestResult: 'node --test exit=0',
    }, evidence, ledger, 2_500);
    expect(compacted.prompt).toContain('Goal: fix checkout');
    expect(compacted.prompt).toContain('tests pass');
    expect(compacted.prompt).toContain('Permissions: search');
    expect(compacted.prompt).toContain('Current diff:\nsrc/app.js');
    expect(compacted.prompt).toContain('Latest test:\nnode --test exit=0');
    expect(compacted.prompt).toContain('sha256:file1');
    expect(compacted.prompt).toContain('sha256:file3');
    expect(compacted.prompt).toContain('BODY-1-');
    expect(compacted.prompt).toContain('BODY-3-');
  });

  it('keeps the real read body current after a cached duplicate read of the same path', () => {
    const realRead = {
      action: 'read_file' as const,
      path: 'templates/base.html',
      range: '1-40',
      resultCount: 40,
      truncated: false,
      fingerprint: 'sha256:base-html',
      ok: true,
      output: 'BODY-REAL-&copy; 2025 Kha Ke Dikha',
    };
    const cachedRepeat = {
      action: 'read_file' as const,
      path: 'templates/base.html',
      range: '1-40',
      resultCount: 40,
      truncated: false,
      fingerprint: 'sha256:base-html',
      ok: true,
      cached: true,
      output: 'read result unchanged (sha256:base-html). Use existing evidence, read a new relevant file, propose a change, or explain what information is missing.',
    };
    const ledger = [{ observation: realRead }, { observation: cachedRepeat }];
    const compacted = compactMissionContext({
      goal: 'change the footer year',
      acceptanceCriteria: ['footer says 2026'],
      permissions: ['search', 'ranged read_file', 'propose_file_change'],
    }, evidence, ledger, MISSION_CONTEXT_BUDGET_CHARS);
    // The model's next turn must still see the actual file content, not just
    // the cached-repeat placeholder text, or it has no evidence left to base
    // a propose_file_change call on and can only re-read or stall.
    expect(compacted.prompt).toContain('BODY-REAL-&copy; 2025 Kha Ke Dikha');
  });

  it('keeps unique application reads together after a host-owned plan request and repeated searches', () => {
    const html = '<!DOCTYPE html>\n<html><body>INDEX-BODY</body></html>';
    const app = 'const form = document.getElementById("tip-form");\nAPP-BODY';
    const plan = '{"page":"index.html","checks":[{"id":"reset-mouse"}]}';
    const searchHit = 'README.md:1:# Tip calculator\nindex.html:6:<title>Tip calculator</title>';
    const ledger = [
      ...Array.from({ length: 3 }, () => ({
        observation: {
          action: 'search' as const,
          query: 'tip calculator',
          resultCount: 2,
          truncated: false,
          fingerprint: 'sha256:search',
          ok: true,
          output: searchHit,
        },
      })),
      {
        observation: {
          action: 'read_file' as const,
          path: 'index.html',
          range: '1-8',
          resultCount: 8,
          truncated: false,
          fingerprint: fingerprintText(html),
          ok: true,
          output: html,
        },
      },
      {
        observation: {
          action: 'read_file' as const,
          path: 'src/app.js',
          range: '1-6',
          resultCount: 6,
          truncated: false,
          fingerprint: fingerprintText(app),
          ok: true,
          output: app,
        },
      },
      {
        observation: {
          action: 'read_file' as const,
          path: '.karkedikha/verification-plan.json',
          range: '1-4',
          resultCount: 4,
          truncated: false,
          fingerprint: fingerprintText(plan),
          ok: true,
          output: plan,
        },
      },
      ...Array.from({ length: 3 }, () => ({
        observation: {
          action: 'search' as const,
          query: 'tip calculator',
          resultCount: 2,
          truncated: false,
          fingerprint: 'sha256:search',
          ok: true,
          output: searchHit,
        },
      })),
    ];
    const compacted = compactMissionContext({
      goal: 'Add a Reset button',
      acceptanceCriteria: ['Reset clears inputs'],
      permissions: ['search'],
    }, emptyEvidence, ledger, MISSION_CONTEXT_BUDGET_CHARS);
    expect(compacted.prompt).toContain('INDEX-BODY');
    expect(compacted.prompt).toContain('APP-BODY');
    expect(compacted.prompt).toContain(fingerprintText(html));
    expect(compacted.prompt).toContain(fingerprintText(app));
    expect(compacted.prompt).not.toContain('"checks":[{"id":"reset-mouse"}]');
    expect(compacted.prompt).toMatch(/duplicate search|search output omitted/);
  });

  it('omits the oldest unique read body only after the budget is exceeded', () => {
    const ledger = [1, 2, 3].map((n) => ({
      observation: {
        action: 'read_file' as const,
        path: `file${n}.js`,
        range: '1-2',
        resultCount: 2,
        truncated: false,
        fingerprint: `sha256:file${n}`,
        ok: true,
        output: `BODY-${n}-${'z'.repeat(400)}`,
      },
    }));
    const compacted = compactMissionContext({
      goal: 'fix checkout',
      acceptanceCriteria: ['tests pass'],
      permissions: ['search'],
    }, evidence, ledger, 700);
    expect(compacted.prompt).toContain('sha256:file1');
    expect(compacted.prompt).not.toContain('BODY-1-');
    expect(compacted.omittedBodies).toBeGreaterThan(0);
  });
});

describe('continuation resume without duplicated messages', () => {
  it('stores only the suffix after the rebuilt base prompt', () => {
    const base: ModelChatMessage[] = [
      { role: 'system', content: MISSION_SYSTEM_PROMPT },
      { role: 'system', content: 'Goal: fix checkout' },
      { role: 'user', content: 'fix it' },
    ];
    const live = [...base, { role: 'assistant', content: 'proposing' }];
    const suffix = continuationSuffix(live, base.length);
    expect(suffix).toEqual([{ role: 'assistant', content: 'proposing' }]);
    expect(suffix.some((message) => message.content === MISSION_SYSTEM_PROMPT)).toBe(false);
  });

  it('de-duplicates a legacy checkpoint that stored the full base inside delta', () => {
    const base: ModelChatMessage[] = [
      { role: 'system', content: MISSION_SYSTEM_PROMPT },
      { role: 'system', content: 'Goal: fix checkout' },
      { role: 'user', content: 'fix it' },
    ];
    const legacyDelta = [...base, { role: 'assistant', content: 'proposing' }];
    const restored = appendContinuationDelta(base, legacyDelta);
    const systems = restored.filter((message) => message.content === MISSION_SYSTEM_PROMPT);
    expect(systems).toHaveLength(1);
    expect(restored.filter((message) => message.role === 'user' && message.content === 'fix it')).toHaveLength(1);
  });
});

describe('completion evidence and command boundaries', () => {
  const envelope: MissionEnvelope = {
    workspaceRoot: process.cwd(),
    pushAuthorized: false,
    networkAuthorized: false,
    installAuthorized: false,
  };

  it('completes when a local commit records full delivery evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-commit-'));
    try {
      copyMissingHelperFixture(dir);
      gitInitFixture(dir);
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), FIXED_APP_JS, 'utf8');
      const missionEnvelope = { workspaceRoot: dir, pushAuthorized: false, networkAuthorized: false, installAuthorized: false };
      const reviewed = executeMissionAction({
        action: { action: 'run_check', check: 'diff' },
        envelope: missionEnvelope,
        evidence: {
          approvedMutation: true,
          approvedPath: 'src/app.js',
          approvedPaths: ['src/app.js'],
          validationPassed: true,
          validationCommand: 'node --test',
          validationExitCode: 0,
          diffReview: 'pending',
        },
      });
      expect(reviewed.evidence.diffReview).toBe('pass');
      const finished = executeMissionAction({
        action: { action: 'run_check', check: 'commit' },
        envelope: missionEnvelope,
        evidence: reviewed.evidence,
      });
      expect(finished.complete).toBe(true);
      expect(finished.evidence.commitSha).toMatch(/^[0-9a-f]{7,}$/i);
      expect(finished.evidence.deliveryStatus).toBe('local_commit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses finish when validation or commit evidence is missing', () => {
    expect(completionRefusal(emptyEvidence)).toMatch(/approved mutation/);
    const finished = executeMissionAction({
      action: { action: 'finish', summary: 'done in prose' },
      envelope,
      evidence: emptyEvidence,
    });
    expect(finished.complete).toBeUndefined();
    expect(finished.observation.ok).toBe(false);
    expect(finished.observation.output).toMatch(/completion refused/);
  });

  it('rejects push, install, network, and outside-path commands', () => {
    expect(classifyScopedCommand('git push origin HEAD', envelope).allow).toBe(false);
    expect(rejectFreeFormCommand('git push origin HEAD', envelope).output).toMatch(/push/);
    expect(classifyScopedCommand('npm install lodash', envelope).allow).toBe(false);
    expect(classifyScopedCommand('curl https://example.com', envelope).allow).toBe(false);
    expect(classifyScopedCommand(process.platform === 'win32' ? 'dir C:\\Windows' : 'ls /etc', envelope).allow).toBe(false);
    expect(argvForCheck('test', envelope, process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc/hosts').allow).toBe(false);
    expect(classifyScopedCommand('echo hi', envelope).allow).toBe(false);
  });

  it('does not rerun an unchanged search and bounds repeated non-progress', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-progress-'));
    try {
      copyMissingHelperFixture(dir);
      gitInitFixture(dir);
      const first = executeMissionAction({
        action: { action: 'search', query: 'tip calculator' },
        envelope: { workspaceRoot: dir, pushAuthorized: false, networkAuthorized: false, installAuthorized: false },
        evidence: emptyEvidence,
      });
      expect(first.observation.ok).toBe(true);
      expect(first.observation.cached).toBeFalsy();
      const ledger = [{ observation: first.observation }];
      const cached = [];
      for (let i = 0; i < MAX_IDENTICAL_SEARCH_RETURNS; i += 1) {
        const again = executeMissionAction({
          action: { action: 'search', query: 'tip calculator' },
          envelope: { workspaceRoot: dir, pushAuthorized: false, networkAuthorized: false, installAuthorized: false },
          evidence: emptyEvidence,
          ledger,
        });
        expect(again.observation.cached).toBe(true);
        expect(again.observation.output).toMatch(/unchanged/);
        cached.push(again.observation);
        ledger.push({ observation: again.observation });
      }
      const decision = executeMissionAction({
        action: { action: 'search', query: 'tip calculator' },
        envelope: { workspaceRoot: dir, pushAuthorized: false, networkAuthorized: false, installAuthorized: false },
        evidence: emptyEvidence,
        ledger,
      });
      expect(decision.observation.action).toBe('decision_required');
      expect(decision.observation.output).toMatch(/Do not search again/);
      expect(resolveRepeatedSearch({ query: 'tip calculator' }, ledger)?.action).toBe('decision_required');
      expect(MAX_DECISION_TURNS).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

class MissionScriptedBackend implements ModelBackend {
  requests: ModelChatRequest[] = [];
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push(request);
    const compact = request.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
    const empty = { content: '', provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    if (compact.includes('delivery=local_commit') || /commit=[0-9a-f]{7,}/i.test(compact)) {
      return { ...empty, content: 'finishing', toolCalls: [{ name: 'finish', arguments: { summary: 'wired helper, tests passed, local commit' } }] };
    }
    if (compact.includes('diffReview=pass') && compact.includes('validation=pass')) {
      return { ...empty, content: 'commit', toolCalls: [{ name: 'run_check', arguments: { check: 'commit' } }] };
    }
    if (compact.includes('mutation=approved') && compact.includes('validation=pass')) {
      return { ...empty, content: 'diff', toolCalls: [{ name: 'run_check', arguments: { check: 'diff' } }] };
    }
    if (compact.includes('mutation=approved')) {
      return { ...empty, content: 'test', toolCalls: [{ name: 'run_check', arguments: { check: 'test' } }] };
    }
    if (compact.includes('"action":"read_file"') && compact.includes('src/money.js')) {
      return {
        ...empty,
        content: 'propose',
        toolCalls: [{ name: 'propose_file_change', arguments: { path: 'src/app.js', content: FIXED_APP } }],
      };
    }
    if (compact.includes('"action":"search"')) {
      return {
        ...empty,
        content: 'read',
        toolCalls: [{ name: 'read_file', arguments: { path: 'src/money.js', startLine: 1, endLine: 6 } }],
      };
    }
    return { ...empty, content: 'search', toolCalls: [{ name: 'search', arguments: { query: 'formatMoney' } }] };
  }
}

class ImmediateFinishBackend implements ModelBackend {
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    return {
      content: 'All done.',
      toolCalls: [{ name: 'finish', arguments: { summary: 'prose-only completion' } }],
      provider: 'ollama',
      model: request.model,
      usage: { durationMs: 1 },
    };
  }
}

class ProseOnlyBackend implements ModelBackend {
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    return { content: 'I fixed it in prose.', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let repo: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let backend: MissionScriptedBackend;
let n = 0;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}

const idemp = () => `idemp-mission-${++n}`;

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function resolveMissionAuthorization(conversationId: string, attemptId: string) {
  await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  const action = snapshot.actions.find((item: any) => item.actionable && item.toolName === 'authorize_mission');
  expect(action, JSON.stringify(snapshot.actions)).toBeTruthy();
  expect(String(action.presentation?.cardText ?? '')).toMatch(/Denied:/);
  expect(String(action.presentation?.digest ?? '')).toMatch(/^sha256:/);
  return jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST',
    idempotencyKey: idemp(),
    body: JSON.stringify({
      resolution: 'approved',
      attemptId: action.attemptId,
      expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus,
      requestedActionDigest: action.requestedActionDigest,
      frozenContextHash: action.frozenContextHash,
    }),
  }));
}

/**
 * The content-authorization boundary fix means `propose_file_change` no
 * longer auto-executes from path/type/size alone — it now requires the same
 * human diff review as any other mutation. Drains the mission by acting as
 * that reviewing human: approves `authorize_mission` and every
 * `propose_file_change` review it is shown (these fixtures never propose an
 * unreviewed/out-of-scope mutation), then waits for a terminal status.
 */
async function drainMissionApprovals(conversationId: string, attemptId: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt: any;
  for (;;) {
    attempt = await (await authedFetch(`/v1/attempts/${attemptId}`)).json();
    if (attempt.status === 'waiting_for_approval') {
      const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
      const action = snapshot.actions.find((item: any) => item.actionable);
      if (action && (action.toolName === AUTHORIZE_MISSION_TOOL || action.toolName === 'propose_file_change')) {
        await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
          method: 'POST',
          idempotencyKey: idemp(),
          body: JSON.stringify({
            resolution: 'approved',
            attemptId: action.attemptId,
            expectedAttemptRevision: action.expectedAttemptRevision,
            expectedAttemptStatus: action.expectedAttemptStatus,
            requestedActionDigest: action.requestedActionDigest,
            frozenContextHash: action.frozenContextHash,
          }),
        });
      }
    } else if (attempt.status === 'completed' || attempt.status === 'failed' || attempt.status === 'cancelled') {
      return attempt;
    }
    if (Date.now() > deadline) throw new Error(`mission ${attemptId} never reached a terminal state; last=${attempt.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startHarness(modelBackend: ModelBackend) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-mission-core-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-mission-repo-'));
  copyMissingHelperFixture(repo);
  gitInitFixture(repo);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  const workspaceRunner = new CoreToolRunner();
  const governedWorkspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => workspaceRunner.run(call, context),
  };
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend: modelBackend,
      toolRunner: workspaceRunner,
      defaultModel: 'fixture',
      defaultWorkingDirectory: repo,
      dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
}

async function stopHarness() {
  ws?.close();
  await api?.close();
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (repo) fs.rmSync(repo, { recursive: true, force: true });
}

async function submitMission(message = MISSING_HELPER_TASK) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client',
    currentMessage: message,
    requestedMode: 'saath_kar',
    conversationId: conv.id,
    workspaceRoot: repo,
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: idemp(),
    toolPermissionPolicy: { profile: 'autonomous-mission' },
    repositoryContext: boundedRepositoryContext(repo),
    modelSelection: {
      selectedProvider: 'ollama',
      selectedModel: 'fixture',
      selectionReason: 'test',
      suitabilitySummary: 'test',
      userOverrode: true,
      candidates: [],
      escalationCandidates: [],
      requiredCapabilities: {
        readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true,
        codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: true,
      },
    },
  });
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id, requestId: result.request.id, attemptId: result.attempt.id };
}

describe('Core-owned autonomous mission loop', () => {
  beforeEach(async () => {
    backend = new MissionScriptedBackend();
    await startHarness(backend);
  });
  afterEach(async () => {
    await stopHarness();
  });

  it('searches, reads a range, proposes, resumes without duplicating prompts, validates, reviews, commits, and finishes', async () => {
    const { conversationId, attemptId } = await submitMission();
    await resolveMissionAuthorization(conversationId, attemptId);
    const first = backend.requests[0];
    expect(first.messages.map((message) => message.content).join('\n')).not.toContain('src/money.js');
    expect(first.tools?.map((tool) => tool.name)).toEqual([
      'search', 'read_file', 'propose_file_change', 'propose_text_edit', 'run_check', 'finish', 'ask_user',
    ]);
    const continuation = loadLoopContinuation(db, attemptId);
    if (continuation) {
      expect(continuation.payload.deltaMessages.some((message) => message.content === MISSION_SYSTEM_PROMPT)).toBe(false);
    }

    const done = await drainMissionApprovals(conversationId, attemptId, 25_000);
    const tools = (await (await authedFetch(`/v1/attempts/${attemptId}/tool-invocations`)).json()).toolInvocations;
    expect(done.status, JSON.stringify({ status: done.status, failureReason: done.failureReason, tools: tools.map((item: any) => ({ name: item.toolName, status: item.status, output: String(item.evidence?.output ?? '').slice(0, 200) })) }, null, 2)).toBe('completed');

    for (const request of backend.requests) {
      const systems = request.messages.filter((message) => message.content === MISSION_SYSTEM_PROMPT);
      expect(systems).toHaveLength(1);
      expect(request.messages.filter((message) => message.role === 'user')).toHaveLength(1);
    }

    const names = tools.map((item: any) => item.toolName);
    expect(names).toContain('search');
    expect(names).toContain('read_file');
    expect(names).toContain('workspace_validation');
    expect(names).toContain('run_check');
    expect(fs.readFileSync(path.join(repo, 'src', 'app.js'), 'utf8')).toContain("require('./money')");
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(sha).not.toBe('');
    expect(searchWorkspace({ workspaceRoot: repo, query: 'formatMoney' }).resultCount).toBeGreaterThan(0);
    const authorized = db.all<{ actor: string; action: string; policyDecision: string }>(
      'SELECT actor, action, policyDecision FROM mission_authorized_actions WHERE attemptId = ?',
      [attemptId],
    );
    expect(authorized.some((row) => row.action === 'search' && row.actor === 'core:policy' && row.policyDecision === 'auto_authorize')).toBe(true);
    // The content-authorization boundary fix: propose_file_change is never
    // auto-authorized from path/type/size alone. It required the same human
    // diff review as any other mutation — this fixture's content had no
    // frozen edit to match, so the approval must show `review_required` and
    // have actually been resolved by an explicit approval, not Core policy.
    const proposeApprovals = db.all<{ status: string; resolution: string | null; summary: string }>(
      "SELECT status, resolution, summary FROM approvals WHERE json_extract(summary, '$.toolName') = 'propose_file_change'",
    ).map((row) => ({ ...row, summary: JSON.parse(row.summary) as Record<string, unknown> }));
    expect(proposeApprovals.length).toBeGreaterThan(0);
    expect(proposeApprovals.every((row) => row.status === 'approved' && row.resolution === 'approved')).toBe(true);
    expect(proposeApprovals.some((row) => row.summary.policyDecision === 'review_required')).toBe(true);

    // The mission owns the anchor attempt that carried its approved mutation,
    // and a finished mission leaves nothing running behind it.
    const anchors = db.all<{ id: string; status: string }>(
      'SELECT id, status FROM attempts WHERE parentAttemptId = ?',
      [attemptId],
    );
    expect(anchors).toHaveLength(1);
    expect(anchors[0].status).toBe('completed');

    // Check identity and results are readable as data, with no prose parsing.
    const checks = tools
      .filter((item: any) => item.toolName === 'run_check')
      .map((item: any) => item.evidence?.check);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((check: any) => typeof check?.kind === 'string')).toBe(true);
    expect(checks.some((check: any) => check?.kind === 'diff_review' && check.status === 'passed'
      && Array.isArray(check.reviewedPaths) && check.reviewedPaths.length > 0)).toBe(true);
    expect(checks.find((check: any) => check?.kind === 'commit' && check.status === 'passed')?.commitSha).toBe(sha);
  }, 30_000);

  it('does not complete a coding mission from a finish call without evidence', async () => {
    await stopHarness();
    await startHarness(new ImmediateFinishBackend());
    const { conversationId, attemptId } = await submitMission();
    await resolveMissionAuthorization(conversationId, attemptId);
    const done = await pollAttempt(attemptId, (attempt) => attempt.status === 'completed' || attempt.status === 'failed');
    expect(done.status).toBe('failed');
    expect(String(done.failureReason)).toMatch(/mission turns without evidenced completion|exceeded/);
  });

  it('does not complete a coding mission from a prose-only reply', async () => {
    await stopHarness();
    await startHarness(new ProseOnlyBackend());
    const { conversationId, attemptId } = await submitMission();
    await resolveMissionAuthorization(conversationId, attemptId);
    const done = await pollAttempt(attemptId, (attempt) => attempt.status === 'completed' || attempt.status === 'failed');
    expect(done.status).toBe('failed');
    expect(done.status).not.toBe('completed');
    expect(String(done.failureReason)).toMatch(/protocol-correction retries|mission turns without evidenced completion/);
  });

  it('retries a multi-call response once without consuming a productive turn', async () => {
    await stopHarness();
    let invocations = 0;
    const backend = {
      async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
        invocations += 1;
        const empty = { content: '', provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
        if (invocations === 1) {
          return {
            ...empty,
            content: 'two calls',
            toolCalls: [
              { name: 'search', arguments: { query: 'formatMoney' } },
              { name: 'propose_file_change', arguments: { path: 'src/app.js', content: FIXED_APP } },
            ],
          };
        }
        return new MissionScriptedBackend().streamChat(request);
      },
    };
    await startHarness(backend);
    const { conversationId, attemptId } = await submitMission();
    await resolveMissionAuthorization(conversationId, attemptId);
    const done = await drainMissionApprovals(conversationId, attemptId, 25_000);
    const tools = (await (await authedFetch(`/v1/attempts/${attemptId}/tool-invocations`)).json()).toolInvocations;
    expect(done.status, JSON.stringify({ status: done.status, failureReason: done.failureReason, tools: tools.map((item: any) => item.toolName) })).toBe('completed');
    const protocol = tools.filter((item: any) => item.toolName === 'protocol_correction');
    expect(protocol).toHaveLength(1);
    expect(JSON.stringify(protocol[0].evidence)).not.toContain(FIXED_APP.slice(0, 40));
    expect(protocol[0].evidence?.output ?? protocol[0].argsSummary).toBeTruthy();
    expect(invocations).toBeGreaterThan(1);
  }, 30_000);

  it('does not execute the same search six times', async () => {
    await stopHarness();
    const backend = {
      async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
        return {
          content: 'search again',
          toolCalls: [{ name: 'search', arguments: { query: 'tip calculator' } }],
          provider: 'ollama',
          model: request.model,
          usage: { durationMs: 1 },
        };
      },
    };
    await startHarness(backend);
    const { conversationId, attemptId } = await submitMission();
    await resolveMissionAuthorization(conversationId, attemptId);
    const done = await pollAttempt(attemptId, (attempt) => attempt.status === 'completed' || attempt.status === 'failed');
    const tools = (await (await authedFetch(`/v1/attempts/${attemptId}/tool-invocations`)).json()).toolInvocations;
    const searches = tools.filter((item: any) => item.toolName === 'search');
    const realSearches = searches.filter((item: any) => item.evidence?.output && !String(item.evidence.output).includes('unchanged'));
    expect(realSearches.length).toBe(1);
    expect(searches.length).toBeLessThan(6);
    expect(done.status).toBe('failed');
    expect(String(done.failureReason)).toMatch(/non-progress|mission turns/);
  });

  it('aborts an open generation past the absolute wall clock as a budget failure', async () => {
    await stopHarness();
    const { MISSION_WALL_CLOCK_MS } = await import('../runtime/missionBudget');
    const backend = {
      async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
        await new Promise<void>((_resolve, reject) => {
          const fail = () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (request.signal?.aborted) {
            fail();
            return;
          }
          request.signal?.addEventListener('abort', fail, { once: true });
        });
        return { content: '', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
      },
    };
    await startHarness(backend);
    const { conversationId, attemptId } = await submitMission();
    await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    // Resume binds the deadline from attempt.startedAt — pull the clock forward
    // so the hung generation must be aborted within a few hundred ms.
    const nearDeadline = new Date(Date.now() - (MISSION_WALL_CLOCK_MS - 200)).toISOString();
    db.run('UPDATE attempts SET startedAt = ? WHERE id = ?', [nearDeadline, attemptId]);
    await resolveMissionAuthorization(conversationId, attemptId);
    const done = await pollAttempt(
      attemptId,
      (attempt) => attempt.status === 'failed' || attempt.status === 'cancelled' || attempt.status === 'completed',
      8_000,
    );
    expect(done.status).toBe('failed');
    expect(String(done.failureReason)).toMatch(/20 minute mission wall clock/);
    const open = db.all<{ id: string; status: string }>(
      'SELECT id, status FROM model_invocations WHERE attemptId = ?',
      [attemptId],
    );
    expect(open.some((row) => row.status === 'failed')).toBe(true);
    expect(open.every((row) => row.status !== 'pending')).toBe(true);
  }, 15_000);

  it('refuses a late mutation response even when the backend ignores abort', async () => {
    await stopHarness();
    const { MISSION_WALL_CLOCK_MS } = await import('../runtime/missionBudget');
    await startHarness({
      async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          content: '', provider: 'ollama', model: request.model, usage: { durationMs: 500 },
          toolCalls: [{ name: 'propose_file_change', arguments: { path: 'src/app.js', content: FIXED_APP } }],
        };
      },
    });
    const { conversationId, attemptId } = await submitMission();
    await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    db.run('UPDATE attempts SET startedAt = ? WHERE id = ?', [
      new Date(Date.now() - MISSION_WALL_CLOCK_MS + 200).toISOString(), attemptId,
    ]);
    await resolveMissionAuthorization(conversationId, attemptId);
    const done = await pollAttempt(attemptId, (attempt) => ['failed', 'cancelled', 'completed'].includes(attempt.status));
    expect(done.status).toBe('failed');
    expect(String(done.failureReason)).toMatch(/20 minute mission wall clock/);
    const tools = (await (await authedFetch(`/v1/attempts/${attemptId}/tool-invocations`)).json()).toolInvocations;
    expect(tools.some((tool: any) => tool.toolName === 'propose_file_change')).toBe(false);
  }, 15_000);
});
