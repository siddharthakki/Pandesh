/**
 * Gmail inbox organization against a stateful fake Gmail API (nothing here spawns a process or touches the
 * network). Proves: honest partial-coverage reporting, a preview that changes nothing, an approved change that is
 * re-read and verified, undo from the captured prior state, refusal of destructive labels and of a missing
 * gmail.modify scope, and the governed flow (permission tier -> exact card -> execute).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchConnectorAction } from '../domain/connectorDispatch';
import { resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { setConnectorPermission } from '../domain/connectors';
import { createGmailOrganizeStore } from '../domain/gmailChangePlans';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { buildConnectorAdapters, CONNECTOR_CREDENTIAL_ENV } from '../runtime/connectors/connectorDefinitions';
import { createGwsGmailExecutor, createGwsGmailPrepare, createGwsGmailProbe, type GwsGmailAdapterConfig } from '../runtime/connectors/gwsGmailAdapter';
import { classifyMessage, parseSender, type GmailChangePlan, type GmailOrganizeStore } from '../runtime/connectors/gmailOrganize';
import type { RunGwsResult } from '../runtime/connectors/gwsTransport';
import type { ToolExecutionContext } from '../runtime/toolRunner';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let binaryPath: string;
let ctx: ToolExecutionContext;
let hasModify: boolean;

interface FakeMessage { id: string; threadId: string; labelIds: string[]; from: string; subject: string; date: string; unsubscribe?: boolean }

function msg(i: number, kind: 'promo' | 'personal' | 'update' | 'noise', overrides: Partial<FakeMessage> = {}): FakeMessage {
  const base: Record<string, Partial<FakeMessage>> = {
    promo: { labelIds: ['INBOX', 'CATEGORY_UPDATES'], from: `Shop ${i % 3} <deals${i % 3}@shop.example>`, subject: `50% off sale ${i}`, unsubscribe: true },
    personal: { labelIds: ['INBOX', 'CATEGORY_PERSONAL'], from: `Anna <anna@friends.example>`, subject: `Dinner ${i}?` },
    update: { labelIds: ['INBOX', 'CATEGORY_UPDATES'], from: `Bank <alerts@bank.example>`, subject: `Statement ${i}`, unsubscribe: true },
    noise: { labelIds: ['INBOX', 'CATEGORY_SOCIAL'], from: `Network <notifications@social.example>`, subject: `Someone liked ${i}`, unsubscribe: true },
  };
  return { id: `m${i}`, threadId: `t${i}`, date: 'Mon, 02 Nov 2026 09:00:00 +0100', labelIds: [], from: '', subject: '', ...base[kind], ...overrides } as FakeMessage;
}

/** A stateful Gmail: list (with paging, q filters), get (metadata|minimal), labels list/create, batchModify. */
function fakeGmail(messages: FakeMessage[], opts: { pageCap?: number; failGetIds?: Set<string>; denyBatch?: boolean } = {}) {
  const mailbox = new Map(messages.map((m) => [m.id, { ...m, labelIds: [...m.labelIds] }]));
  const userLabels = new Map<string, string>(); // id -> name
  const calls: Array<{ method: string; params: Record<string, any>; body?: Record<string, any> }> = [];
  const ok = (data: unknown): RunGwsResult => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '', timedOut: false, aborted: false });
  const err = (code: number, reason: string): RunGwsResult => ({ exitCode: 1, stdout: JSON.stringify({ error: { code, message: reason, reason } }), stderr: '', timedOut: false, aborted: false });
  let labelSeq = 0;
  const matches = (m: FakeMessage, q: string | undefined): boolean => {
    if (!q) return true;
    return q.split(/\s+/).every((term) => {
      if (term.startsWith('category:')) return m.labelIds.includes(`CATEGORY_${term.slice(9).toUpperCase()}`);
      if (term.startsWith('from:')) return m.from.toLowerCase().includes(term.slice(5).toLowerCase());
      if (term.startsWith('label:')) return [...userLabels].some(([id, name]) => name.toLowerCase() === term.slice(6).toLowerCase() && m.labelIds.includes(id));
      return true; // newer_than: etc. is not modelled
    });
  };
  const run = async (input: { args: string[] }): Promise<RunGwsResult> => {
    const [svc, res, sub, method] = input.args;
    if (svc !== 'gmail' || res !== 'users') return err(400, 'not gmail');
    const pIdx = input.args.indexOf('--params');
    const bIdx = input.args.indexOf('--json');
    const params = pIdx >= 0 ? JSON.parse(input.args[pIdx + 1]) : {};
    const body = bIdx >= 0 ? JSON.parse(input.args[bIdx + 1]) : undefined;
    calls.push({ method: `${sub}.${method}`, params, body });
    if (sub === 'getProfile') return ok({ emailAddress: 'me@example.com' });
    if (sub === 'messages' && method === 'list') {
      const all = [...mailbox.values()].filter((m) => matches(m, params.q));
      const start = params.pageToken ? Number(params.pageToken) : 0;
      const size = Math.min(Number(params.maxResults ?? 100), opts.pageCap ?? 500);
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return ok({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: all.length, ...(next ? { nextPageToken: next } : {}) });
    }
    if (sub === 'messages' && method === 'get') {
      const m = mailbox.get(params.id);
      if (!m || opts.failGetIds?.has(params.id)) return err(m ? 500 : 404, m ? 'backendError' : 'Requested entity was not found (notFound)');
      if (params.format === 'minimal') return ok({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
      const headers = [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Date', value: m.date }, ...(m.unsubscribe ? [{ name: 'List-Unsubscribe', value: '<mailto:u@x>' }] : [])];
      return ok({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, payload: { headers } });
    }
    if (sub === 'labels' && method === 'list') {
      return ok({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, ...[...userLabels].map(([id, name]) => ({ id, name, type: 'user' }))] });
    }
    if (sub === 'labels' && method === 'create') {
      labelSeq += 1;
      const id = `Label_${labelSeq}`;
      userLabels.set(id, String(body?.name));
      return ok({ id, name: body?.name });
    }
    if (sub === 'messages' && method === 'batchModify') {
      if (opts.denyBatch) return err(403, 'insufficientPermissions');
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
  return { mailbox, calls, userLabels, run: run as unknown as GwsGmailAdapterConfig['runGwsFn'] };
}

function memoryStore(): GmailOrganizeStore & { plans: Map<string, GmailChangePlan> } {
  const plans = new Map<string, GmailChangePlan>();
  return {
    plans,
    save: (plan) => { plans.set(plan.planId, JSON.parse(JSON.stringify(plan))); },
    get: (id) => { const p = plans.get(id); return p ? JSON.parse(JSON.stringify(p)) : undefined; },
    update(id, patch) {
      const current = plans.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      plans.set(id, next);
      return JSON.parse(JSON.stringify(next));
    },
  };
}

function config(fake: ReturnType<typeof fakeGmail>, store: GmailOrganizeStore, extra: Partial<GwsGmailAdapterConfig> = {}): GwsGmailAdapterConfig {
  return {
    getAccessToken: () => 'access-token',
    getAccountEmail: () => 'me@example.com',
    configDir: path.join(dir, 'config'),
    binaryPath,
    expectedSha256: crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex'),
    bindings: { record: (c) => ({ ...c, digest: 'x' }), get: () => undefined },
    runGwsFn: fake.run,
    organize: { store, hasModifyScope: () => hasModify },
    ...extra,
  };
}

const parse = (r: { output: string }) => JSON.parse(r.output) as Record<string, any>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-organize-'));
  binaryPath = path.join(dir, 'fake-gws.exe');
  fs.writeFileSync(binaryPath, 'pinned-for-test');
  ctx = { cwd: dir, signal: new AbortController().signal };
  hasModify = true;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('classification is deterministic and documented', () => {
  const ctx0 = { accountDomain: 'gmail.com', workDomains: [] as string[] };
  it('maps the signals to the six classes', () => {
    const c = (labelIds: string[], from: string, subject = 'x', listUnsubscribe = false, precedence = '') => classifyMessage({ labelIds, from, subject, listUnsubscribe, precedence }, ctx0);
    expect(c(['INBOX', 'CATEGORY_PROMOTIONS'], 'a@shop.example')).toBe('promotions');
    expect(c(['STARRED', 'INBOX'], 'boss@corp.example')).toBe('important');
    expect(c(['INBOX', 'CATEGORY_PERSONAL'], 'Anna <anna@friends.example>')).toBe('personal');
    expect(c(['INBOX', 'CATEGORY_UPDATES'], 'alerts@bank.example', 'Statement', true)).toBe('updates');
    expect(c(['INBOX'], 'news@brand.example', '30% off everything', true)).toBe('promotions');
    expect(c(['INBOX', 'CATEGORY_SOCIAL'], 'notifications@social.example', 'liked', true)).toBe('noise');
    expect(classifyMessage({ labelIds: ['INBOX'], from: 'kim@acme.example', subject: 'plan', listUnsubscribe: false, precedence: '' }, { accountDomain: 'acme.example', workDomains: [] })).toBe('work');
    expect(parseSender('"Bob B" <Bob@X.com>')).toEqual({ name: 'Bob B', address: 'bob@x.com', domain: 'x.com' });
  });
});

describe('gmail_analyze_inbox reports coverage honestly', () => {
  const mixed = () => [
    ...Array.from({ length: 30 }, (_, i) => msg(i, 'promo')),
    ...Array.from({ length: 20 }, (_, i) => msg(100 + i, 'personal')),
    ...Array.from({ length: 20 }, (_, i) => msg(200 + i, 'update')),
    ...Array.from({ length: 10 }, (_, i) => msg(300 + i, 'noise')),
  ];

  it('a capped sample is called PARTIAL with its real size, never the whole window', async () => {
    const fake = fakeGmail(mixed(), { pageCap: 25 });
    const exec = createGwsGmailExecutor(config(fake, memoryStore()));
    const result = await exec('gmail_analyze_inbox', { maxMessages: 40 }, ctx);
    expect(result.status).toBe('succeeded');
    const body = parse(result);
    expect(body.coverage.examined).toBe(40);
    expect(body.coverage.estimatedTotal).toBe(80);
    expect(body.coverage.complete).toBe(false);
    expect(body.coverage.stoppedBecause).toBe('message_cap');
    expect(body.coverage.statement).toMatch(/^PARTIAL: examined 40 of about 80/);
    expect(body.coverage.statement).toMatch(/Do not describe this as the whole mailbox/);
    const total = Object.values(body.byClass as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(40);
    expect(fake.calls.filter((c) => c.method === 'messages.list').length).toBeGreaterThan(1); // it paged
    expect(fake.calls.some((c) => c.method === 'messages.batchModify')).toBe(false);
  });

  it('is complete only when every matching message was listed and read', async () => {
    const fake = fakeGmail(mixed(), { pageCap: 25 });
    const body = parse(await createGwsGmailExecutor(config(fake, memoryStore()))('gmail_analyze_inbox', { maxMessages: 500 }, ctx));
    expect(body.coverage).toMatchObject({ examined: 80, complete: true, stoppedBecause: 'complete', failedLookups: 0 });
    expect(body.coverage.statement).toMatch(/^Complete: examined all 80/);
    expect(body.byClass).toMatchObject({ promotions: 30 + 0, personal: 20, updates: 20, noise: 10 });
    expect(body.topSenders[0].count).toBeGreaterThanOrEqual(10);
  });

  it('counts failed lookups and refuses to call the result complete', async () => {
    const fake = fakeGmail(mixed(), { failGetIds: new Set(['m1', 'm2']) });
    const body = parse(await createGwsGmailExecutor(config(fake, memoryStore()))('gmail_analyze_inbox', { maxMessages: 500 }, ctx));
    expect(body.coverage.failedLookups).toBe(2);
    expect(body.coverage.examined).toBe(78);
    expect(body.coverage.complete).toBe(false);
    expect(body.coverage.statement).toMatch(/PARTIAL/);
  });

  it('stops at its time budget and says so', async () => {
    const fake = fakeGmail(mixed());
    let clock = 0;
    const cfg = config(fake, memoryStore());
    cfg.organize = { ...cfg.organize!, now: () => { clock += 400; return clock; } };
    const body = parse(await createGwsGmailExecutor(cfg)('gmail_analyze_inbox', { maxMessages: 500, timeBudgetMs: 5000 }, ctx));
    expect(body.coverage.complete).toBe(false);
    expect(body.coverage.stoppedBecause).toBe('time_budget');
    expect(body.coverage.examined).toBeLessThan(80);
    expect(body.coverage.statement).toMatch(/time budget/);
  });
});

describe('preview, apply, verify and undo (scenario: five promotions recategorized and restored)', () => {
  it('previews without changing anything, applies exactly the planned messages, verifies, then restores them', async () => {
    const promos = Array.from({ length: 5 }, (_, i) => msg(i, 'promo'));
    const others = [msg(50, 'personal'), msg(51, 'update')];
    const fake = fakeGmail([...promos, ...others]);
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const before = JSON.stringify([...fake.mailbox.values()]);

    const planned = await exec('gmail_plan_changes', { query: 'from:shop.example', operation: { moveToCategory: 'promotions' } }, ctx);
    expect(planned.status).toBe('succeeded');
    const preview = parse(planned);
    expect(preview.willChange).toBe(5);
    expect(preview.nothingChanged).toBe(true);
    expect(preview.reversible).toMatch(/restores/);
    expect(JSON.stringify([...fake.mailbox.values()])).toBe(before);
    expect(fake.calls.some((c) => c.method === 'messages.batchModify')).toBe(false);

    const applied = await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    expect(applied.status).toBe('succeeded');
    const result = parse(applied);
    expect(result.verified).toBe(true);
    expect(result.verification).toBe('5 of 5 messages verified in Gmail');
    for (const m of promos) {
      const live = fake.mailbox.get(m.id)!.labelIds;
      expect(live).toContain('CATEGORY_PROMOTIONS');
      expect(live).not.toContain('CATEGORY_UPDATES');
      expect(live).toContain('INBOX');
    }
    // Messages outside the plan were not touched.
    expect(fake.mailbox.get('m50')!.labelIds).toEqual(['INBOX', 'CATEGORY_PERSONAL']);
    expect(fake.mailbox.get('m51')!.labelIds).toEqual(['INBOX', 'CATEGORY_UPDATES']);
    expect(store.get(preview.planId)?.status).toBe('applied');

    const undone = await exec('gmail_undo_plan', { planId: preview.planId }, ctx);
    expect(undone.status).toBe('succeeded');
    expect(parse(undone).verified).toBe(true);
    for (const m of promos) expect([...fake.mailbox.get(m.id)!.labelIds].sort()).toEqual([...m.labelIds].sort());
    expect(store.get(preview.planId)?.status).toBe('undone');
  });

  it('archives and adds a new user label (created only at apply time), then undoes both', async () => {
    const fake = fakeGmail([msg(1, 'promo'), msg(2, 'promo')]);
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const preview = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { archive: true, addLabels: ['Newsletters'] } }, ctx));
    expect(preview.change).toContain('archive');
    expect(preview.change).toContain('new: "Newsletters"');
    expect(fake.userLabels.size).toBe(0); // planning creates nothing
    const applied = parse(await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx));
    expect(applied.verified).toBe(true);
    const labelId = [...fake.userLabels.keys()][0];
    expect(fake.mailbox.get('m1')!.labelIds).toContain(labelId);
    expect(fake.mailbox.get('m1')!.labelIds).not.toContain('INBOX');
    expect(parse(await exec('gmail_undo_plan', { planId: preview.planId }, ctx)).verified).toBe(true);
    expect(fake.mailbox.get('m1')!.labelIds.sort()).toEqual(['CATEGORY_UPDATES', 'INBOX']);
  });

  it('plans only messages the change would alter', async () => {
    const already = msg(1, 'promo', { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] });
    const fake = fakeGmail([already, msg(2, 'promo')]);
    const preview = parse(await createGwsGmailExecutor(config(fake, memoryStore()))('gmail_plan_changes', { query: 'from:shop', operation: { moveToCategory: 'promotions' } }, ctx));
    expect(preview.willChange).toBe(1);
    expect(preview.alreadyInThatState).toBe(1);
  });

  it('reports a verification mismatch instead of claiming success', async () => {
    const fake = fakeGmail([msg(1, 'promo'), msg(2, 'promo')]);
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const preview = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { moveToCategory: 'promotions' } }, ctx));
    // Gmail "accepts" the change, but m2 is changed back behind our back before verification.
    const realRun = fake.run!;
    let sawBatch = false;
    const sneaky = (async (input: { args: string[] }) => {
      const result = await realRun(input as never);
      if (input.args[3] === 'batchModify') { sawBatch = true; fake.mailbox.get('m2')!.labelIds = ['INBOX']; }
      return result;
    }) as unknown as GwsGmailAdapterConfig['runGwsFn'];
    const applied = await createGwsGmailExecutor(config(fake, store, { runGwsFn: sneaky }))('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    expect(sawBatch).toBe(true);
    const body = parse(applied);
    expect(body.verified).toBe(false);
    expect(body.verification).toMatch(/1 of 2 messages verified in Gmail; 1 do not match/);
    expect(store.get(preview.planId)?.status).toBe('applied_unverified');
  });

  it('reports messages that disappeared before undo instead of guessing', async () => {
    const fake = fakeGmail([msg(1, 'promo'), msg(2, 'promo')]);
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const preview = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { moveToCategory: 'promotions' } }, ctx));
    await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    fake.mailbox.delete('m2');
    const undone = parse(await exec('gmail_undo_plan', { planId: preview.planId }, ctx));
    expect(undone.details.missing).toEqual(['m2']);
    expect(undone.verification).toMatch(/1 no longer exist/);
  });
});

describe('safety: nothing destructive, nothing without permission', () => {
  it('refuses to plan deleting, trashing or spam-marking, and has no delete tool at all', async () => {
    const fake = fakeGmail([msg(1, 'promo')]);
    const exec = createGwsGmailExecutor(config(fake, memoryStore()));
    for (const label of ['TRASH', 'spam', 'Trash']) {
      const refused = await exec('gmail_plan_changes', { query: 'from:shop', operation: { addLabels: [label] } }, ctx);
      expect(refused.status).toBe('failed');
      expect(refused.output).toMatch(/never changed/);
    }
    const unknown = await exec('gmail_delete_messages', { ids: ['m1'] }, ctx);
    expect(unknown.resultCategory).toBe('gws_not_allowlisted');
    expect(fake.calls.some((c) => c.method === 'messages.batchModify')).toBe(false);
  });

  it('without gmail.modify, apply says exactly what to do and changes nothing', async () => {
    const fake = fakeGmail([msg(1, 'promo')]);
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const preview = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { moveToCategory: 'promotions' } }, ctx));
    hasModify = false;
    const applied = await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    expect(applied.status).toBe('failed');
    expect(applied.output).toMatch(/NOT DONE/);
    expect(applied.output).toMatch(/Allow inbox organization/);
    expect(fake.calls.some((c) => c.method === 'messages.batchModify')).toBe(false);
    const prepared = await createGwsGmailPrepare(config(fake, store))('gmail_apply_plan', { planId: preview.planId }, undefined);
    expect(prepared).toMatchObject({ ok: false });
  });

  it('refuses a plan that drifted after approval, an expired plan, and a plan applied twice', async () => {
    const fake = fakeGmail([msg(1, 'promo')]);
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const preview = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { moveToCategory: 'promotions' } }, ctx));
    const drift = await exec('gmail_apply_plan', { planId: preview.planId, planDigest: 'not-the-digest' }, ctx);
    expect(drift.output).toMatch(/changed after it was approved/);
    const first = await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    expect(first.status).toBe('succeeded');
    const second = await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    expect(second.status).toBe('failed');
    expect(second.output).toMatch(/already "applied"/);

    const fresh = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { archive: true } }, ctx));
    store.update(fresh.planId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await exec('gmail_apply_plan', { planId: fresh.planId, planDigest: fresh.planDigest }, ctx);
    expect(expired.output).toMatch(/expired/);
  });

  it('a Gmail refusal partway is reported as partial, with the undo path', async () => {
    const fake = fakeGmail([msg(1, 'promo')], { denyBatch: true });
    const store = memoryStore();
    const exec = createGwsGmailExecutor(config(fake, store));
    const preview = parse(await exec('gmail_plan_changes', { query: 'from:shop', operation: { moveToCategory: 'promotions' } }, ctx));
    const applied = await exec('gmail_apply_plan', { planId: preview.planId, planDigest: preview.planDigest }, ctx);
    expect(applied.status).toBe('failed');
    expect(applied.output).toMatch(/PARTIALLY DONE/);
    expect(applied.output).toMatch(/insufficientPermissions/);
  });
});

describe('Gmail organization through Core governed dispatch (permission -> exact card -> execute)', () => {
  let db: CoreDatabase;
  beforeEach(() => {
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    delete process.env[CONNECTOR_CREDENTIAL_ENV.gmail];
    process.env[CONNECTOR_CREDENTIAL_ENV.gmail] = 'present';
  });
  afterEach(() => { db.close(); delete process.env[CONNECTOR_CREDENTIAL_ENV.gmail]; });

  function decisionFrom(approval: ApprovalRecord) {
    return {
      approvalId: approval.id, resolution: 'approved' as const, attemptId: approval.attemptId,
      expectedAttemptRevision: approval.expectedAttemptRevision, expectedAttemptStatus: approval.expectedAttemptStatus,
      requestedActionDigest: approval.requestedActionDigest, frozenContextHash: approval.frozenContextHash,
      actor: 'client-1', clientId: 'client-1', idempotencyKey: `approve:${approval.id}`,
    };
  }

  it('shows the exact change on the approval card, runs only after approval, and refuses a read-only request', async () => {
    const fake = fakeGmail(Array.from({ length: 5 }, (_, i) => msg(i, 'promo')));
    const store = createGmailOrganizeStore(db);
    const cfg = config(fake, store);
    const connectors = buildConnectorAdapters({
      gmail: { isConnected: () => true, probe: createGwsGmailProbe(cfg), executor: createGwsGmailExecutor(cfg), prepare: createGwsGmailPrepare(cfg) },
    });
    await connectors.get('gmail')!.probeHealth();
    const reg = new GovernedCapabilityRegistry();
    for (const adapter of connectors.values()) reg.register(adapter);
    for (const tier of ['read', 'draft', 'execute'] as const) setConnectorPermission(db, { connectorId: 'gmail', tier, granted: true, actor: 'operator' });
    const base = { correlationId: 'conv-gmail', cwd: process.cwd(), actor: 'core', clientId: 'client-1' };

    const planned = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'gmail_plan_changes', arguments: { query: 'from:shop', operation: { moveToCategory: 'promotions' } } });
    expect(planned.outcome).toBe('executed');
    let preview: Record<string, unknown> = {};
    try {
      preview = JSON.parse(String((planned.toolInvocation as { evidence?: { output?: string } }).evidence?.output ?? '{}'));
    } catch {
      preview = {};
    }
    const planId = preview.planId ?? [...(fake.calls)].length; // evidence shape differs per build; fall back to the store
    const storedPlanId = typeof planId === 'string' ? planId : (db.get<{ planId: string }>('SELECT planId FROM gmail_change_plans')!).planId;

    const analysisText = 'Analyze my inbox for the last 30 days. Do not change anything.';
    const refused = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'gmail_apply_plan', arguments: { planId: storedPlanId }, requestText: analysisText });
    expect(refused.outcome).toBe('denied');
    if (refused.outcome === 'denied') expect(refused.reason).toMatch(/no approval was requested/);

    const requested = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'gmail_apply_plan', arguments: { planId: storedPlanId }, requestText: 'Move my promotional emails to the Promotions category.' });
    if (requested.outcome !== 'approval_required') throw new Error(`expected approval_required, got ${requested.outcome}`);
    const card = String(requested.approval.presentation?.cardText);
    expect(card).toContain('Organize your Gmail (me@example.com)');
    expect(card).toContain('move to Gmail Promotions');
    expect(card).toContain('5 messages');
    expect(card).toContain('Nothing is deleted');
    expect([...fake.mailbox.values()].every((m) => !m.labelIds.includes('CATEGORY_PROMOTIONS'))).toBe(true); // nothing before approval

    resolveCapabilityApproval(db, decisionFrom(requested.approval));
    const executed = await dispatchConnectorAction(db, reg, connectors as never, { ...base, toolName: 'gmail_apply_plan', arguments: { planId: storedPlanId }, requestText: 'Move my promotional emails to the Promotions category.' });
    expect(executed.outcome).toBe('executed');
    expect([...fake.mailbox.values()].every((m) => m.labelIds.includes('CATEGORY_PROMOTIONS'))).toBe(true);
    expect(store.get(storedPlanId)?.status).toBe('applied');
  });
});

describe('the plan journal is durable', () => {
  it('survives reopening the database and keeps the prior labels', () => {
    const file = path.join(dir, 'plans.db');
    const db1 = openCoreDatabase(file).db;
    const plan: GmailChangePlan = {
      planId: 'gplan_1', accountEmail: 'me@example.com', status: 'planned', digest: 'd', query: 'q',
      coverage: { listed: 1, estimatedTotal: 1, exhausted: true, statement: 'Complete' },
      operation: { addLabelIds: ['CATEGORY_PROMOTIONS'], removeLabelIds: [], createLabels: [], summary: 's' },
      messages: [{ id: 'm1', threadId: 't1', from: 'a@b.c', subject: 's', date: '', priorLabelIds: ['INBOX'], class: 'promotions' }],
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(),
    };
    createGmailOrganizeStore(db1).save(plan);
    db1.close();
    const db2 = openCoreDatabase(file).db;
    expect(createGmailOrganizeStore(db2).get('gplan_1')?.messages[0].priorLabelIds).toEqual(['INBOX']);
    createGmailOrganizeStore(db2).update('gplan_1', { status: 'applied' });
    expect(createGmailOrganizeStore(db2).get('gplan_1')?.status).toBe('applied');
    db2.close();
  });
});
