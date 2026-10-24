import { describe, expect, it } from 'vitest';
import { EvidenceLedger, extractClaims } from '../platform/evidenceLedger';
import {
  CostGuard, ToolDiscipline, auditClaims, batchLineRanges, checkObjectiveCompletion, compactForCloud, groundedAnswerContract, tierEvidence,
  type BudgetMessage,
} from '../platform/cloudSkills';
import { OpenAICompatibleModelBackend } from '../runtime/openaiCompatibleBackend';

const big = (label: string, n = 6000) => `${label}:` + 'x'.repeat(n);

const history = (): BudgetMessage[] => [
    { role: 'system', content: 'SYSTEM RULES' },
    { role: 'user', content: 'OBJECTIVE: create a.txt b.txt c.txt' },
    { role: 'tool', content: big('read-1') },
    { role: 'tool', content: big('read-1') }, // exact duplicate of the previous one
    { role: 'assistant', content: big('thinking-old') },
    { role: 'tool', content: big('read-2') },
    { role: 'assistant', content: 'recent a' },
    { role: 'tool', content: big('recent-tool', 500) },
    { role: 'assistant', content: 'recent b' },
    { role: 'user', content: 'recent user' },
    { role: 'assistant', content: 'recent c' },
    { role: 'user', content: 'LATEST ASK' },
];

describe('cloud-token-budget', () => {
  it('is a no-op when the prompt already fits', () => {
    const { messages, report } = compactForCloud(history(), { maxContextTokens: 200_000, outputReserveTokens: 4000 });
    expect(report.changed).toBe(false);
    expect(messages).toEqual(history());
  });

  it('shrinks to the budget while keeping system, objective, recent turns and the latest ask', () => {
    const { messages, report } = compactForCloud(history(), { maxContextTokens: 4000, outputReserveTokens: 1000 });
    expect(report.charsAfter).toBeLessThanOrEqual(report.budgetChars);
    expect(report.changed).toBe(true);
    expect(messages[0].content).toBe('SYSTEM RULES');
    expect(messages.some(m => m.content.startsWith('OBJECTIVE'))).toBe(true);
    expect(messages.at(-1)?.content).toBe('LATEST ASK');
    expect(messages.some(m => m.content === 'recent b')).toBe(true);
    expect(history().length).toBe(12); // input untouched
  });

  it('never touches messages the caller marks as required implementation evidence, nor images', () => {
    const msgs = history();
    msgs[2] = { role: 'tool', content: big('FILE-BEING-EDITED', 9000) };
    msgs[5] = { role: 'user', content: 'see image', images: ['AAAA'] };
    const { messages } = compactForCloud(msgs, { maxContextTokens: 4000, outputReserveTokens: 1000, preserve: m => m.content.startsWith('FILE-BEING-EDITED') });
    expect(messages.find(m => m.content.startsWith('FILE-BEING-EDITED'))?.content.length).toBe(msgs[2].content.length);
    expect(messages.find(m => m.images?.length)).toBeDefined();
  });

  it('is applied to the real cloud request body by the OpenAI-compatible backend, and the cost guard stops runaway tasks', async () => {
    const sent: Array<{ messages: Array<{ content: unknown }> }> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\ndata: [DONE]\n', { status: 200 });
    }) as unknown as typeof fetch;
    const costGuard = new CostGuard({ mode: 'UNRESTRICTED' }, { maxRequests: 2, maxTotalTokens: 1000 });
    const backend = new OpenAICompatibleModelBackend({ baseUrl: 'https://x.test/v1', apiKey: 'k', provider: 'groq', label: 'Groq', fetchFn, cloudSkills: { costGuard } });
    const request = { model: 'm', messages: history() as never, contextBudget: { maxContextTokens: 4000, outputReserveTokens: 1000 } };
    await backend.streamChat(request, () => undefined);
    const total = sent[0].messages.reduce((n, m) => n + String(m.content).length, 0);
    expect(total).toBeLessThan(history().reduce((n, m) => n + m.content.length, 0) / 2);
    await backend.streamChat(request, () => undefined);
    await expect(backend.streamChat(request, () => undefined)).rejects.toMatchObject({ code: 'cloud_task_limit' });
    expect(sent).toHaveLength(2);
    expect(costGuard.snapshot().tokens).toBe(30);
  });
});

describe('evidence-before-claim and objective-completion', () => {
  it('verifies claims only from recorded evidence', () => {
    const ledger = new EvidenceLedger();
    expect(ledger.verify({ kind: 'tests_passed' }).verified).toBe(false);
    ledger.record({ kind: 'file_written', subject: 'src/A.ts', summary: 'wrote A', ok: true, excerpt: 'export const answer = 42;' });
    ledger.record({ kind: 'test_run', subject: 'npm test', summary: 'vitest 12 passed', ok: true, exitCode: 0 });
    expect(ledger.verify({ kind: 'tests_passed' }).verified).toBe(true);
    expect(ledger.verify({ kind: 'file_exists', subject: 'SRC\\a.ts' }).verified).toBe(true);
    expect(ledger.verify({ kind: 'file_exists', subject: 'src/B.ts' }).verified).toBe(false);
    expect(ledger.verify({ kind: 'file_contains', subject: 'src/a.ts', text: 'ANSWER = 42' }).verified).toBe(true);
    expect(ledger.verify({ kind: 'file_contains', subject: 'src/a.ts', text: 'answer = 43' }).verified).toBe(false);
    expect(ledger.verify({ kind: 'build_succeeded' }).verified).toBe(false);
  });

  it('a later write invalidates a previous green run, and a failed run is never green', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ kind: 'test_run', subject: 'npm test', summary: 'green', ok: true, exitCode: 0 });
    expect(ledger.verify({ kind: 'tests_passed' }).verified).toBe(true);
    ledger.record({ kind: 'file_written', subject: 'src/new.ts', summary: 'edit', ok: true });
    const stale = ledger.verify({ kind: 'tests_passed' });
    expect(stale.verified).toBe(false);
    expect(stale.reason).toMatch(/re-run/);
    ledger.record({ kind: 'test_run', subject: 'npm test', summary: '2 failed', ok: false, exitCode: 1 });
    expect(ledger.verify({ kind: 'tests_passed' }).verified).toBe(false);
  });

  it('audits an answer: unverified claims are reported, unrecognised prose is not treated as verified evidence', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ kind: 'file_written', subject: 'a.txt', summary: 'w', ok: true });
    const audit = auditClaims('I created a.txt and all tests pass.', ledger);
    expect(audit.allVerified).toBe(false);
    expect(audit.unverified.map(v => v.claim.kind)).toEqual(['tests_passed']);
    expect(extractClaims('Here is an explanation.')).toEqual([]);
  });

  it('objective completion needs a recorded write for every required target', () => {
    const ledger = new EvidenceLedger();
    ledger.record({ kind: 'file_written', subject: 'a.txt', summary: 'w', ok: true });
    ledger.record({ kind: 'file_written', subject: 'b.txt', summary: 'w', ok: true });
    const partial = checkObjectiveCompletion(ledger, ['a.txt', 'b.txt', 'c.txt']);
    expect(partial.verified).toBe(false);
    expect(partial.reason).toContain('c.txt');
    ledger.record({ kind: 'file_written', subject: 'c.txt', summary: 'w', ok: true });
    expect(checkObjectiveCompletion(ledger, ['a.txt', 'b.txt', 'c.txt']).verified).toBe(true);
    expect(checkObjectiveCompletion(ledger, []).verified).toBe(false);
  });
});

describe('grounding, tool discipline and cost guard', () => {
  it('tiers evidence and states the contract in one short line', () => {
    const tiers = tierEvidence([{ label: 'a.ts', source: 'read' }, { label: 'graph edge', source: 'host-derived' }, { label: 'guess', source: 'model' }, { label: 'b.ts', source: 'missing' }]);
    expect(tiers.map(t => t.tier)).toEqual(['KNOWN', 'DERIVED', 'INFERRED', 'UNKNOWN']);
    expect(groundedAnswerContract(tiers).length).toBeLessThan(400);
  });

  it('refuses identical repeated reads until something changes, and caps calls per turn', () => {
    const discipline = new ToolDiscipline(4);
    expect(discipline.check({ name: 'read_file', args: { path: 'a.ts' } }).allow).toBe(true);
    expect(discipline.check({ name: 'read_file', args: { path: 'a.ts' } }).allow).toBe(false);
    discipline.noteMutation();
    expect(discipline.check({ name: 'read_file', args: { path: 'a.ts' } }).allow).toBe(true);
    expect(discipline.check({ name: 'propose_file_change', args: { path: 'a.ts' } }).allow).toBe(true);
    const over = discipline.check({ name: 'list_files', args: {} });
    expect(over).toMatchObject({ allow: false });
    discipline.resetTurn();
    expect(discipline.check({ name: 'list_files', args: {} }).allow).toBe(true);
  });

  it('merges line ranges', () => {
    expect(batchLineRanges([{ start: 1, end: 10 }, { start: 8, end: 20 }, { start: 100, end: 120 }, { start: 22, end: 30 }])).toEqual([{ start: 1, end: 30 }, { start: 100, end: 120 }]);
  });

  it('cost guard enforces the spend policy and per-task ceilings', () => {
    const guard = new CostGuard({ mode: 'FREE_ONLY' }, { maxRequests: 1, maxTotalTokens: 100 });
    const paid = { locality: 'cloud' as const, freeness: 'paid' as const, displayName: 'X', providerName: 'P' };
    const free = { ...paid, freeness: 'free' as const };
    expect(guard.beforeRequest(paid).allow).toBe(false);
    expect(guard.beforeRequest(free).allow).toBe(true);
    expect(guard.beforeRequest(free)).toMatchObject({ allow: false });
  });
});
