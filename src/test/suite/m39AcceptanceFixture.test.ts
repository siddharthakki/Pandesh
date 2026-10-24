// M39: the packaged scenario's assertions must never depend on live-model
// judgement, so the deterministic fixture's every response is a pure function
// of the request. Run as part of `npm test` (unlike the older `.mjs`
// `node:test` harness checks) so a regression here is a real gate.
import { describe, expect, it } from 'vitest';
// @ts-expect-error - test-owned ESM acceptance harness, intentionally untyped
import {
  M39_PROMPTS,
  M39_ANSWERS,
  M39_FIXTURE_TOKEN,
  M39_REPOSITORY_FILE,
  M39_GITHUB_ISSUE,
  computeM39Response,
  toolResultPayload,
} from '../../../scripts/acceptance/m39AcceptanceHarness.mjs';
import { SCENARIO_REGISTRY } from '../../../scripts/acceptance/m32AcceptanceHarness.mjs';

const user = (content: string) => ({ role: 'user', content });
const tool = (name: string, payload: unknown) => ({ role: 'tool', content: `[${name}] exit=0\n${JSON.stringify(payload)}` });

const RECALL_WITH_CONTRADICTION = {
  entries: [
    { kind: 'unresolved_contradiction', memory: { id: 'mem_a', state: 'active' }, evidence: [{ id: 'e1' }], contradictions: [{ id: 'mcon_1', state: 'unresolved' }] },
    { kind: 'unresolved_contradiction', memory: { id: 'mem_b', state: 'active' }, evidence: [{ id: 'e2' }], contradictions: [{ id: 'mcon_1', state: 'unresolved' }] },
  ],
};

describe('M39 deterministic packaged fixture', () => {
  it('is registered as a mandatory packaged scenario', () => {
    const scenario = SCENARIO_REGISTRY.find((entry: { name: string }) => entry.name === 'm39-memory-knowledge-restart');
    expect(scenario).toBeTruthy();
    expect(scenario.requiresRealModel).toBe(false);
  });

  it('parses a governed tool result payload past the exit= prefix Core adds', () => {
    expect(toolResultPayload(tool('memory_recall', { entries: [] }), 'memory_recall')).toEqual({ entries: [] });
    expect(toolResultPayload({ content: '[read_file] exit=0\nnot json' }, 'read_file')).toBeNull();
    expect(toolResultPayload(tool('memory_recall', {}), 'memory_impact')).toBeNull();
  });

  it('proposes memory_remember with the exact scope, sensitivity and affected entities', () => {
    const first = computeM39Response({ messages: [user(M39_PROMPTS.rememberSqlite)] }, { productRecordKey: 'proj_1' });
    expect(first.toolCall.name).toBe('memory_remember');
    expect(first.toolCall.arguments).toMatchObject({ scopeType: 'project', scopeId: 'Atlas', sensitivity: 'internal', value: 'SQLite' });
    const keys = first.toolCall.arguments.affectedEntities.map((entry: { type: string; canonicalKey: string }) => `${entry.type}:${entry.canonicalKey}`);
    expect(keys).toEqual([`repository_file:${M39_REPOSITORY_FILE}`, `github_issue:${M39_GITHUB_ISSUE}`, 'product_record:proj_1']);

    const final = computeM39Response({ messages: [user(M39_PROMPTS.rememberSqlite), tool('memory_remember', { memoryId: 'mem_a' })] });
    expect(final.toolCall).toBeNull();
    expect(final.content).toBe(M39_ANSWERS.remembered);
  });

  it("reads the contradiction id out of Core's own recall result rather than an injected value", () => {
    expect(computeM39Response({ messages: [user(M39_PROMPTS.resolveContradiction)] }).toolCall.name).toBe('memory_recall');
    const step2 = computeM39Response({ messages: [user(M39_PROMPTS.resolveContradiction), tool('memory_recall', RECALL_WITH_CONTRADICTION)] });
    expect(step2.toolCall).toEqual({ name: 'memory_resolve_contradiction', arguments: { contradictionId: 'mcon_1', policy: 'prefer_later' } });
    const step3 = computeM39Response({ messages: [user(M39_PROMPTS.resolveContradiction), tool('memory_recall', RECALL_WITH_CONTRADICTION), tool('memory_resolve_contradiction', {})] });
    expect(step3.content).toBe(M39_ANSWERS.resolved);
  });

  it('reads the active memory id from Core for impact and forget', () => {
    const recall = { entries: [{ memory: { id: 'mem_active', state: 'active' } }, { memory: { id: 'mem_old', state: 'historical' } }] };
    expect(computeM39Response({ messages: [user(M39_PROMPTS.impact), tool('memory_recall', recall)] }).toolCall)
      .toEqual({ name: 'memory_impact', arguments: { memoryId: 'mem_active' } });
    expect(computeM39Response({ messages: [user(M39_PROMPTS.forget), tool('memory_recall', recall)] }).toolCall)
      .toEqual({ name: 'memory_forget', arguments: { memoryId: 'mem_active' } });
  });

  it('proposes a restricted memory containing the fixture token so the refusal path is exercised', () => {
    const restricted = computeM39Response({ messages: [user(M39_PROMPTS.restrictedSecret)] });
    expect(restricted.toolCall.arguments.sensitivity).toBe('restricted');
    expect(restricted.toolCall.arguments.value).toContain(M39_FIXTURE_TOKEN);
  });

  it('fails loudly rather than guessing on an unknown prompt or an impossible sequence', () => {
    expect(computeM39Response({ messages: [user('something the scenario never sends')] }).error).toMatch(/unrecognized M39 prompt/);
    expect(computeM39Response({ messages: [] }).error).toMatch(/no user message/);
    expect(computeM39Response({ messages: [user(M39_PROMPTS.resolveContradiction), tool('memory_recall', { entries: [] })] }).error)
      .toMatch(/no unresolved contradiction/);
    expect(computeM39Response({ messages: [user(M39_PROMPTS.rememberSqlite), tool('memory_remember', {}), tool('memory_remember', {})] }).error)
      .toMatch(/unexpected tool turn/);
  });
});
