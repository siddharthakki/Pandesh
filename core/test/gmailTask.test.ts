/**
 * The durable Gmail-organization task against a stateful fake Gmail (no process, no network): real message ids,
 * verified totals, one approval card per batch, label-only changes, resume without re-planning, Retry-After, undo,
 * and the protected-mail guard. Also the reasoning-marker filter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createGwsGmailExecutor, createGwsGmailPrepare, parseRetryAfterMs, type GwsGmailAdapterConfig } from '../runtime/connectors/gwsGmailAdapter';
import type { GmailChangePlan, GmailOrganizeStore } from '../runtime/connectors/gmailOrganize';
import type { GmailOrganizeTask, GmailTaskStore } from '../runtime/connectors/gmailTask';
import type { RunGwsResult } from '../runtime/connectors/gwsTransport';
import type { ToolExecutionContext } from '../runtime/toolRunner';
import { createReasoningFilter, stripReasoningMarkers } from '../runtime/reasoningMarkers';

let dir: string;
let binaryPath: string;
let ctx: ToolExecutionContext;

interface FakeMessage { id: string; labelIds: string[]; from: string; subject: string }

function fakeGmail(messages: FakeMessage[], opts: { rateLimitBatchOnce?: string } = {}) {
  const mailbox = new Map(messages.map((m) => [m.id, { ...m, labelIds: [...m.labelIds] }]));
  const userLabels = new Map<string, string>();
  let labelSeq = 0;
  let rateLimited = false;
  const batchCalls: Array<Record<string, any>> = [];
  const ok = (data: unknown): RunGwsResult => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '', timedOut: false, aborted: false });
  const err = (code: number, reason: string): RunGwsResult => ({ exitCode: 1, stdout: JSON.stringify({ error: { code, message: reason, reason } }), stderr: '', timedOut: false, aborted: false });
  const matches = (m: FakeMessage, q?: string): boolean => {
    const from = /from:\(([^)]*)\)/.exec(q ?? '');
    if (!from) return true;
    return from[1].split(' OR ').some((s) => m.from.toLowerCase().includes(s.toLowerCase()));
  };
  const run = async (input: { args: string[] }): Promise<RunGwsResult> => {
    const [, , sub, method] = input.args;
    const pIdx = input.args.indexOf('--params');
    const bIdx = input.args.indexOf('--json');
    const params = pIdx >= 0 ? JSON.parse(input.args[pIdx + 1]) : {};
    const body = bIdx >= 0 ? JSON.parse(input.args[bIdx + 1]) : undefined;
    if (sub === 'messages' && method === 'list') {
      const all = [...mailbox.values()].filter((m) => matches(m, params.q));
      const start = params.pageToken ? Number(params.pageToken) : 0;
      const size = Math.min(Number(params.maxResults ?? 100), 100);
      const next = start + size < all.length ? String(start + size) : undefined;
      return ok({ messages: all.slice(start, start + size).map((m) => ({ id: m.id, threadId: `t${m.id}` })), resultSizeEstimate: 9999, ...(next ? { nextPageToken: next } : {}) });
    }
    if (sub === 'messages' && method === 'get') {
      const m = mailbox.get(params.id);
      if (!m) return err(404, 'notFound');
      if (params.format === 'minimal') return ok({ id: m.id, labelIds: m.labelIds });
      return ok({ id: m.id, threadId: `t${m.id}`, labelIds: m.labelIds, payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: 'Mon, 02 Nov 2026 09:00:00 +0100' }] } });
    }
    if (sub === 'labels' && method === 'list') return ok({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, ...[...userLabels].map(([id, name]) => ({ id, name, type: 'user' }))] });
    if (sub === 'labels' && method === 'create') { labelSeq += 1; userLabels.set(`Label_${labelSeq}`, String(body?.name)); return ok({ id: `Label_${labelSeq}`, name: body?.name }); }
    if (sub === 'messages' && method === 'batchModify') {
      if (opts.rateLimitBatchOnce && !rateLimited) { rateLimited = true; return err(429, `User-rate limit exceeded. Retry after ${opts.rateLimitBatchOnce}`); }
      batchCalls.push(body ?? {});
      for (const id of body?.ids ?? []) {
        const m = mailbox.get(id);
        if (!m) continue;
        const set = new Set(m.labelIds);
        for (const l of body?.addLabelIds ?? []) set.add(l);
        for (const l of body?.removeLabelIds ?? []) set.delete(l);
        m.labelIds = [...set];
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    return err(400, `unsupported ${sub}.${method}`);
  };
  const labelNamed = (name: string) => [...userLabels].find(([, n]) => n === name)?.[0];
  return { mailbox, userLabels, batchCalls, labelNamed, run: run as unknown as GwsGmailAdapterConfig['runGwsFn'] };
}

function stores(): { plans: GmailOrganizeStore; tasks: GmailTaskStore } {
  const plans = new Map<string, GmailChangePlan>();
  const tasks = new Map<string, GmailOrganizeTask>();
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  return {
    plans: {
      save: (p) => { plans.set(p.planId, clone(p)); },
      get: (id) => (plans.has(id) ? clone(plans.get(id)!) : undefined),
      update(id, patch) { const c = plans.get(id); if (!c) return undefined; const n = { ...c, ...patch }; plans.set(id, n); return clone(n); },
    },
    tasks: {
      save: (t) => { tasks.set(t.taskId, clone(t)); },
      get: (id) => (tasks.has(id) ? clone(tasks.get(id)!) : undefined),
      findActive: (email) => [...tasks.values()].filter((t) => t.status === 'active' && t.accountEmail.toLowerCase() === email.toLowerCase()).map(clone),
    },
  };
}

function mailbox(): FakeMessage[] {
  const out: FakeMessage[] = [];
  for (let i = 1; i <= 7; i += 1) out.push({ id: `k${i}`, labelIds: ['INBOX'], from: `Kotak <alerts@kotak.example>`, subject: `Statement ${i}` });
  for (let i = 1; i <= 3; i += 1) out.push({ id: `h${i}`, labelIds: ['INBOX'], from: `HDFC Bank <noreply@hdfcbank.example>`, subject: `Security alert ${i}` });
  for (let i = 1; i <= 2; i += 1) out.push({ id: `c${i}`, labelIds: ['INBOX'], from: `Conficar <booking@conficar.example>`, subject: `Rental ${i}` });
  for (let i = 1; i <= 4; i += 1) out.push({ id: `x${i}`, labelIds: ['INBOX'], from: `Anna <anna@friends.example>`, subject: `Dinner ${i}` });
  return out;
}

const RULES = [{ label: 'Finance', senders: ['Kotak', 'HDFC'] }, { label: 'Travel', senders: ['Conficar'] }];
const parse = (r: { output: string }) => JSON.parse(r.output) as Record<string, any>;

function setup(fake: ReturnType<typeof fakeGmail>, extra: Partial<GwsGmailAdapterConfig> = {}) {
  const s = stores();
  const config: GwsGmailAdapterConfig = {
    getAccessToken: () => 'access-token',
    getAccountEmail: () => 'me@example.com',
    configDir: path.join(dir, 'config'),
    binaryPath,
    expectedSha256: crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'),
    bindings: { record: (c) => ({ ...c, digest: 'x' }), get: () => undefined },
    runGwsFn: fake.run,
    organize: { store: s.plans, tasks: s.tasks, hasModifyScope: () => true },
    sleepMs: async () => undefined,
    ...extra,
  };
  const exec = createGwsGmailExecutor(config);
  const prepare = createGwsGmailPrepare(config);
  return { s, exec, prepare, run: (tool: string, args: Record<string, unknown>) => exec(tool, args, ctx) };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-task-'));
  binaryPath = path.join(dir, 'fake-gws.exe');
  fs.writeFileSync(binaryPath, 'pinned-for-test');
  ctx = { cwd: dir, signal: new AbortController().signal };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('gmail_create_task', () => {
  it('lists real ids per rule, ignores other senders, reports a verified total and changes nothing', async () => {
    const fake = fakeGmail(mailbox());
    const t = setup(fake);
    const created = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 4 }));
    expect(created.total).toBe(12);
    expect(created.progress).toBe('0 of 12 messages processed');
    expect(created.byLabel).toEqual([
      expect.objectContaining({ label: 'Finance', found: 10 }),
      expect.objectContaining({ label: 'Travel', found: 2 }),
    ]);
    expect(fake.batchCalls).toHaveLength(0);
    expect(fake.userLabels.size).toBe(0);
    // Asking again resumes the same task; it never creates a second one.
    const again = parse(await t.run('gmail_create_task', { rules: RULES }));
    expect(again.taskId).toBe(created.taskId);
    expect(again.resumed).toBe(true);
  });

  it('refuses labels it must never touch', async () => {
    const t = setup(fakeGmail(mailbox()));
    const result = await t.run('gmail_create_task', { rules: [{ label: 'TRASH', senders: ['kotak'] }] });
    expect(result.status).toBe('failed');
  });
});

describe('batches', () => {
  it('shows one exact card per batch, only adds the label, verifies, and reports verified progress', async () => {
    const fake = fakeGmail(mailbox());
    const t = setup(fake);
    const task = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 4 }));

    const first = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
    expect(first.willChange).toBe(4);
    const prepared = await t.prepare('gmail_apply_plan', { planId: first.planId, planDigest: first.planDigest }, undefined);
    expect(prepared.ok).toBe(true);
    const card = (prepared as { presentation: { cardText: string } }).presentation.cardText;
    for (const m of first.messages) expect(card).toContain(m.id);
    expect(card).toContain('only added');
    expect(card).not.toMatch(/archive \(remove/);

    const applied = parse(await t.run('gmail_apply_plan', { planId: first.planId, planDigest: first.planDigest }));
    expect(applied.verified).toBe(true);
    expect(applied.progress).toBe('4 of 12 messages processed');
    const finance = fake.labelNamed('Finance')!;
    for (const m of first.messages) {
      const stored = fake.mailbox.get(m.id)!;
      expect(stored.labelIds).toContain(finance);
      expect(stored.labelIds).toContain('INBOX'); // nothing was archived
    }

    // Finish: every remaining batch, then confirm nothing outside the rules was touched.
    for (let guard = 0; guard < 6; guard += 1) {
      const next = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
      if (!next.planId) { expect(next.status).toBe('complete'); break; }
      expect(parse(await t.run('gmail_apply_plan', { planId: next.planId, planDigest: next.planDigest })).verified).toBe(true);
    }
    const status = parse(await t.run('gmail_task_status', { taskId: task.taskId }));
    expect(status.progress).toBe('12 of 12 messages processed');
    expect(fake.mailbox.get('c1')!.labelIds).toContain(fake.labelNamed('Travel')!);
    expect(fake.mailbox.get('x1')!.labelIds).toEqual(['INBOX']);
  });

  it('returns the same open batch after an interruption instead of planning again', async () => {
    const fake = fakeGmail(mailbox());
    const t = setup(fake);
    const task = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 5 }));
    const first = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
    const second = parse(await t.run('gmail_task_next_batch', {}));
    expect(second.resumed).toBe(true);
    expect(second.planId).toBe(first.planId);
  });

  it('waits out a Google Retry-After and then applies the batch', async () => {
    const fake = fakeGmail(mailbox(), { rateLimitBatchOnce: new Date(Date.now() + 5000).toISOString() });
    const waits: number[] = [];
    const t = setup(fake, { sleepMs: async (ms) => { waits.push(ms); } });
    const task = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 3 }));
    const batch = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
    const applied = parse(await t.run('gmail_apply_plan', { planId: batch.planId, planDigest: batch.planDigest }));
    expect(applied.verified).toBe(true);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(3000);
    expect(waits[0]).toBeLessThanOrEqual(5000);
  });

  it('records a long Retry-After in the task and does not start another batch until then', async () => {
    const fake = fakeGmail(mailbox(), { rateLimitBatchOnce: new Date(Date.now() + 600_000).toISOString() });
    const t = setup(fake);
    const task = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 3 }));
    const batch = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
    const failed = await t.run('gmail_apply_plan', { planId: batch.planId, planDigest: batch.planDigest });
    expect(failed.status).toBe('failed');
    expect(failed.output).toContain('nothing was modified');
    const waiting = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
    expect(waiting.waiting).toBe(true);
    expect(waiting.processed).toBe(0);
  });

  it('a failed apply is reported as paused with no worker, never as running or completed', async () => {
    const fake = fakeGmail(mailbox(), { rateLimitBatchOnce: new Date(Date.now() + 600_000).toISOString() });
    const t = setup(fake, { organize: { store: stores().plans, tasks: stores().tasks, hasModifyScope: () => true, notifyCapability: () => ({ canNotify: false, statement: 'No desktop connected.' }) } });
    const created = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 3 }));
    expect(created.state).toBe('queued');
    expect(created.worker).toBe('none');
    expect(created.autonomous).toBe(false);
    expect(created.willContinueOnItsOwn).toBe(false);
    expect(created.notifyWhenDone).toBe(false);
    const batch = parse(await t.run('gmail_task_next_batch', { taskId: created.taskId }));
    expect(batch.state).toBe('awaiting_approval');
    const failed = await t.run('gmail_apply_plan', { planId: batch.planId, planDigest: batch.planDigest });
    expect(failed.status).toBe('failed');
    const status = parse(await t.run('gmail_task_status', { taskId: created.taskId }));
    expect(status.state).toBe('paused');
    expect(status.processed).toBe(0);
    expect(status.progress).toMatch(/^0 of 14|^0 of 12|^0 messages/);
    expect(status.stateReason).toMatch(/Nothing retries by itself/);
    expect([...fake.mailbox.values()].every((m) => !m.labelIds.some((l) => l.startsWith('Label_')))).toBe(true);
  });

  it('undoes an applied batch from the saved labels and the task counts it as unprocessed again', async () => {
    const fake = fakeGmail(mailbox());
    const t = setup(fake);
    const task = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 3 }));
    const batch = parse(await t.run('gmail_task_next_batch', { taskId: task.taskId }));
    await t.run('gmail_apply_plan', { planId: batch.planId, planDigest: batch.planDigest });
    const undone = parse(await t.run('gmail_undo_plan', { planId: batch.planId }));
    expect(undone.verified).toBe(true);
    for (const m of batch.messages) expect(fake.mailbox.get(m.id)!.labelIds).toEqual(['INBOX']);
    expect(parse(await t.run('gmail_task_status', { taskId: task.taskId })).progress).toBe('0 of 12 messages processed');
  });
});

describe('protected financial mail', () => {
  it('is never archived by a plan, and is reported as held back', async () => {
    const fake = fakeGmail(mailbox());
    const t = setup(fake);
    const plan = parse(await t.run('gmail_plan_changes', { messageIds: ['k1', 'h1', 'x1'], operation: { archive: true } }));
    expect(plan.willChange).toBe(1);
    expect(plan.heldBack).toBe(2);
  });
});

describe('Retry-After parsing', () => {
  it('reads seconds and Google timestamps without mistaking the year for seconds', () => {
    expect(parseRetryAfterMs('Retry-After: 12', 0)).toBe(12_000);
    expect(parseRetryAfterMs('Retry after 2026-11-03T10:00:05.000Z', Date.parse('2026-11-03T10:00:00.000Z'))).toBe(5000);
    expect(parseRetryAfterMs('boom', 0)).toBeNull();
  });
});

describe('reasoning markers', () => {
  it('drops thought blocks and stray markers, in one piece or split across chunks', () => {
    expect(stripReasoningMarkers('<|channel>thought\nplan it<channel|>Done: 4 of 12.')).toBe('Done: 4 of 12.');
    expect(stripReasoningMarkers('<think>hmm</think>Answer')).toBe('Answer');
    expect(stripReasoningMarkers('thought\n<channel|>The second attempt hit a rate limit.')).toBe('The second attempt hit a rate limit.');
    expect(stripReasoningMarkers('thought\nplan: retry later<channel|>Done.')).toBe('Done.');
    expect(stripReasoningMarkers('thought about it')).toBe('thought about it');
    expect(stripReasoningMarkers('thought\nno closing marker')).toBe('thought\nno closing marker');
    const lead = createReasoningFilter();
    expect(lead.push('thou') + lead.push('ght\npl') + lead.push('an<chan') + lead.push('nel|>Hi') + lead.flush()).toBe('Hi');
    expect(stripReasoningMarkers('Answer<channel|>')).toBe('Answer');
    const filter = createReasoningFilter();
    const pieces = ['Hel', 'lo <|chan', 'nel>tho', 'ught secret <chan', 'nel|>wor', 'ld'];
    expect(pieces.map((p) => filter.push(p)).join('') + filter.flush()).toBe('Hello world');
    expect(stripReasoningMarkers('a < b and 3 <|x')).toBe('a < b and 3 <|x');
  });
});

describe('durable store', () => {
  it('keeps the checkpoint across a database reopen and resumes the next batch from it', async () => {
    const { openCoreDatabase } = await import('../db/openCore');
    const { createGmailOrganizeStore, createGmailTaskStore } = await import('../domain/gmailChangePlans');
    const file = path.join(dir, 'tasks.db');
    const fake = fakeGmail(mailbox());
    let db = openCoreDatabase(file).db;
    const open = () => setup(fake, { organize: { store: createGmailOrganizeStore(db), tasks: createGmailTaskStore(db), hasModifyScope: () => true } });
    let t = open();
    const task = parse(await t.run('gmail_create_task', { rules: RULES, batchSize: 4 }));
    const first = parse(await t.run('gmail_task_next_batch', {}));
    await t.run('gmail_apply_plan', { planId: first.planId, planDigest: first.planDigest });
    const open2 = parse(await t.run('gmail_task_next_batch', {}));
    db.close();

    db = openCoreDatabase(file).db; // simulated restart
    t = open();
    const status = parse(await t.run('gmail_task_status', {}));
    expect(status.taskId).toBe(task.taskId);
    expect(status.progress).toBe('4 of 12 messages processed');
    const resumed = parse(await t.run('gmail_task_next_batch', {}));
    expect(resumed.planId).toBe(open2.planId);
    expect(resumed.resumed).toBe(true);
    db.close();
  });
});
