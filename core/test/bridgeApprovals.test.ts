import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask, type BridgePairing } from '../domain/pandaBridge';
import { registerProject } from '../domain/projectRegistry';
import { decideApproval, expireStaleApproval, listApprovalEvents, listPendingApprovals, pendingApproval, usableApproval } from '../domain/bridgeApprovals';
import { decideExternalApproval, dispatchBridgeTask, refreshBridgeTask, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { activityItem } from '../runtime/kandev/bridgeActivity';
import type { KandevClient } from '../runtime/kandev/kandevClient';

const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

describe('external-agent approval', () => {
  let dir: string; let data: string; let db: CoreDatabase; let pairing: BridgePairing; let rt: BridgeRuntime; let proj: string;
  const kandev = {
    healthy: async () => true, reprobeAgent: async () => null, agentBinaryInstalled: () => true,
    tool: async (name: string) => (name === 'list_agents_kandev' ? { agents: [{ id: 'a1', name: 'claude-acp', capability_status: 'ok', profiles: [{ id: 'p', model: 'sonnet', auto_approve: false }] }, { id: 'a2', name: 'opencode-acp', capability_status: 'ok', profiles: [{ id: 'p2', model: 'qwen', auto_approve: false }] }] } : {}),
  } as unknown as KandevClient;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeappr-')); data = path.join(dir, 'data'); fs.mkdirSync(data);
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    pairing = redeemPairingCode(db, { code: createPairingCode(db).code, label: 'Chrome (ChatGPT)' }).pairing;
    rt = { db, kandev, dataDir: data, executor: undefined };
    proj = path.join(dir, 'Pandesh'); fs.mkdirSync(path.join(proj, 'src'), { recursive: true }); git(proj, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(proj, 'src', 'a.js'), 'x'); git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', 'i'); git(proj, 'checkout', '-q', '-b', 'feat/x');
    registerProject(data, { name: 'Pandesh', path: proj, access: 'read', preferredAgents: ['claude'], authorizedBy: 'owner' });
  });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const submit = (text: string, id: string, markedConfidential = false) => submitBridgeTask(db, pairing, { clientRequestId: id, instruction: text, sourceRef: { kind: 'chatgpt' }, markedConfidential }).task;
  const ask = (id: string) => dispatchBridgeTask(rt, id, { executor: 'claude', decidedBy: `extension:${pairing.id}`, authority: 'extension' });
  const TASK = (p = proj) => `Inspect the router in ${p} on feat/x. Run its existing tests and report defects. Do not modify files.`;

  it('an agent that is not installed is still refused (no card, nothing starts), but never hides a project answer', async () => {
    // CI 2026-11-23: availability came from the machine's PATH and was checked before the project gate; now it is injectable and second.
    const absent = { ...rt, kandev: { ...kandev, agentBinaryInstalled: () => false } as unknown as KandevClient };
    const ok = submit(TASK(), 'req-appr-absent1');
    await expect(dispatchBridgeTask(absent, ok.id, { executor: 'claude', decidedBy: `extension:${pairing.id}`, authority: 'extension' })).rejects.toThrow(/Claude Code is not available: Claude Code is not installed on this PC/);
    expect(pendingApproval(db, ok.id)).toBeNull();
    expect(getBridgeTask(db, ok.id)).toMatchObject({ status: 'awaiting_executor', executor: null });
    const stray = submit(TASK(path.join(dir, 'not-registered')), 'req-appr-absent2');
    await expect(dispatchBridgeTask(absent, stray.id, { executor: 'claude', decidedBy: `extension:${pairing.id}`, authority: 'extension' })).rejects.toThrow(/not an authorized project/);
    for (const executor of ['claude'] as const) {
      await expect(dispatchBridgeTask(absent, ok.id, { executor, decidedBy: 'host:x', authority: 'host', consent: { externalTransfer: true } })).rejects.toThrow(/not available/);
    }
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
  });

  it('a browser can ASK for Claude Code: nothing starts, the owner gets the full picture, the browser learns only that approval is pending', async () => {
    const t = submit(TASK(), 'req-appr-000001');
    const r = await ask(t.id);
    expect(r.started).toBe(false);
    expect(r.approval).toMatchObject({ executor: 'claude', agentLabel: 'Claude Code', project: { name: 'Pandesh', branch: 'feat/x', access: 'read' }, requestedBy: `extension:${pairing.id}` });
    expect(r.approval!.provider).toMatch(/Anthropic/);
    expect(r.approval!.accessLevel).toMatch(/Read-only inspection of a private copy/);
    expect(r.approval!.exposure.join(' ')).toMatch(/task text goes to Anthropic/);
    expect(r.approval!.exposure.join(' ')).toMatch(/Your own checkout is not shared/);
    expect(r.approval!.instruction).toContain('Do not modify files');
    expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'awaiting_executor', executor: null, externalConsent: null });
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false); // nothing was copied before the owner decided
    expect(listPendingApprovals(db).map(a => a.taskId)).toEqual([t.id]);
    const item = activityItem(db, getBridgeTask(db, t.id), 'Browser');
    expect(item).toMatchObject({ state: 'waiting_for_approval' }); expect(item.reason).toMatch(/Nothing has been sent/);
  });

  it('a card nobody answered expires visibly: the task says nothing was sent, once, and the stale card can no longer be approved', async () => {
    // Live b188f 2026-11-23: two unanswered cards still read "Waiting for your approval" over MCP the next morning.
    const t = submit(TASK(), 'req-appr-expire1');
    const { approval } = await ask(t.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const after = await refreshBridgeTask(rt, t.id);
      expect(after.status).toBe('awaiting_executor');
      expect(after.statusDetail).toMatch(/^The approval card expired at \d\d:\d\d UTC without an answer from the owner; nothing was sent to Claude Code\. Submit the task again/);
      await refreshBridgeTask(rt, t.id);
      expect(listApprovalEvents(db, t.id).map(e => e.event)).toEqual(['requested', 'expired']);
      expect(expireStaleApproval(db, t.id)).toBeNull();
      expect(listPendingApprovals(db)).toEqual([]);
      expect(() => decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:x' })).toThrow(/no approval request waiting/);
    } finally { vi.useRealTimers(); }
  });

  it('refusal stops the task: no executor starts, no substitute is tried, and the trail says who refused', async () => {
    const t = submit(TASK(), 'req-appr-000002');
    const { approval } = await ask(t.id);
    const r = await decideExternalApproval(rt, t.id, { requestId: approval!.requestId, decision: 'refuse', by: 'host:jarvis' });
    expect(r.started).toBe(false);
    expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'cancelled', control: 'cancelled', executor: null });
    expect(getBridgeTask(db, t.id).statusDetail).toMatch(/Nothing was sent, and no other executor was used/);
    for (const executor of ['claude', 'opencode', 'auto', 'native']) {
      await expect(dispatchBridgeTask(rt, t.id, { executor, decidedBy: 'host:jarvis', authority: 'host', consent: { externalTransfer: true } })).rejects.toMatchObject({ code: 'conflict' });
    }
    expect(getBridgeTask(db, t.id).executor).toBeNull();
    expect(listApprovalEvents(db, t.id).map(e => [e.event, e.by])).toEqual([['requested', `extension:${pairing.id}`], ['refused', 'host:jarvis']]);
    expect(pendingApproval(db, t.id)).toBeNull();
    expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
  });

  it('approval starts exactly the approved agent, scoped to this instruction, and is in the audit trail', async () => {
    const t = submit(TASK(), 'req-appr-000003');
    const { approval } = await ask(t.id);
    await decideExternalApproval(rt, t.id, { requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' }).catch(() => { /* the fake Kandev cannot run a worker; the dispatch itself was claimed */ });
    const after = getBridgeTask(db, t.id);
    expect(after).toMatchObject({ executor: 'claude', routing: 'explicit' });
    expect(after.externalConsent).toMatchObject({ externalTransfer: true, grantedBy: 'host:jarvis' });
    const ev = listApprovalEvents(db, t.id);
    expect(ev.map(e => e.event)).toEqual(['requested', 'approved', 'consumed']);
    expect(ev[1]).toMatchObject({ by: 'host:jarvis', scope: { executor: 'claude', project: 'Pandesh', branch: 'feat/x', instructionSha256: t.instructionSha256, confidentialOverride: false } });
    expect(ev[1]!.scope!.access).toMatch(/Read-only inspection/);
    expect(ev[1]!.at >= ev[0]!.at).toBe(true);
  });

  it('an approval cannot be reused for another executor or instruction, nor decided twice or with a stale id', async () => {
    const t = submit(TASK(), 'req-appr-000004');
    const { approval } = await ask(t.id);
    await expect(decideExternalApproval(rt, t.id, { requestId: 'apr_stale', decision: 'approve', by: 'host:jarvis' })).rejects.toMatchObject({ code: 'conflict' });
    decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' });
    const t2 = submit(TASK(), 'req-appr-000005');
    const a2 = (await ask(t2.id)).approval!;
    decideApproval(db, { taskId: t2.id, requestId: a2.requestId, decision: 'approve', by: 'host:jarvis' });
    await expect(dispatchBridgeTask(rt, t2.id, { executor: 'antigravity', decidedBy: 'host:jarvis', authority: 'host', consent: { externalTransfer: true }, approvalRequestId: a2.requestId })).rejects.toThrow();
    await expect(decideExternalApproval(rt, t2.id, { requestId: a2.requestId, decision: 'approve', by: 'host:jarvis' })).rejects.toMatchObject({ code: 'conflict' }); // already decided
  });

  it('an approval expires, and an expired one cannot start anything', async () => {
    const t = submit(TASK(), 'req-appr-000006');
    const { approval } = await ask(t.id);
    expect(() => decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' }, Date.now() + 31 * 60_000)).toThrow(/expired/);
    expect(listApprovalEvents(db, t.id).map(e => e.event)).toEqual(['requested', 'expired']);
    expect(getBridgeTask(db, t.id).executor).toBeNull();
    expect(pendingApproval(db, t.id)).toBeNull();
  });

  it('a confidential task needs its own explicit override on top of the approval', async () => {
    const t = submit(TASK(), 'req-appr-000007', true);
    const { approval } = await ask(t.id);
    expect(approval!.sensitivity).toBe('confidential');
    expect(() => decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' })).toThrow(/confidential override/);
    const ok = decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis', confidentialOverride: true });
    expect(ok.event.scope!.confidentialOverride).toBe(true);
  });

  it('asking again replaces the earlier request; ambiguous or write-capable requests are stopped before any card is shown', async () => {
    const t = submit(TASK(), 'req-appr-000008');
    const first = (await ask(t.id)).approval!; const second = (await ask(t.id)).approval!;
    expect(second.requestId).not.toBe(first.requestId);
    expect(listApprovalEvents(db, t.id).map(e => e.event)).toEqual(['requested', 'superseded', 'requested']);
    const w = submit(`Add a feature to the code in ${proj}`, 'req-appr-000009');
    await expect(ask(w.id)).rejects.toThrow(/read-only/);
    expect(pendingApproval(db, w.id)).toBeNull();
    const u = submit('Inspect C:\\Somewhere\\Else and run tests. Do not modify files.', 'req-appr-000010');
    await expect(ask(u.id)).rejects.toThrow(/not an authorized project/);
    expect(pendingApproval(db, u.id)).toBeNull();
  });

  it('a direct host authorisation (the app\'s own API) is audited with the same scope fields', async () => {
    const t = submit(TASK(), 'req-appr-000011');
    await dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'host:jarvis', authority: 'host', consent: { externalTransfer: true } }).catch(() => undefined);
    const ev = listApprovalEvents(db, t.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event: 'approved', by: 'host:jarvis', scope: { executor: 'claude', project: 'Pandesh', branch: 'feat/x' } });
    expect(ev[0]!.requestId).toMatch(/^direct_/);
  });

  describe('substitution, replay and stale cards', () => {
    const commitOnBranch = (name: string) => { fs.writeFileSync(path.join(proj, 'src', name), name); git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', name); };
    const tamper = (file: string, change: (p: Record<string, unknown>) => void) => { const f = path.join(data, 'projects.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); change(j.projects[0]); fs.writeFileSync(f, JSON.stringify(j)); void file; };

    it('an approval is single use: a retry or copied request id cannot start a second run', async () => {
      const t = submit(TASK(), 'req-appr-100001');
      const { approval } = await ask(t.id);
      await decideExternalApproval(rt, t.id, { requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' }).catch(() => undefined); // claimed; the fake Kandev then fails the start
      expect(listApprovalEvents(db, t.id).map(e => e.event)).toEqual(['requested', 'approved', 'consumed']);
      // the task failed to start and is dispatchable again, but the old approval is spent
      await expect(dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'host:jarvis', authority: 'host', consent: { externalTransfer: true }, approvalRequestId: approval!.requestId })).rejects.toThrow(/already used/);
    });

    it('an approval that is not used promptly is void', async () => {
      const t = submit(TASK(), 'req-appr-100002');
      const { approval } = await ask(t.id);
      decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' });
      const ev = listApprovalEvents(db, t.id).find(e => e.event === 'approved')!;
      expect(() => usableApproval(db, t.id, approval!.requestId, Date.parse(ev.at) + 4 * 60_000)).not.toThrow();
      expect(() => usableApproval(db, t.id, approval!.requestId, Date.parse(ev.at) + 6 * 60_000)).toThrow(/not used in time/);
    });

    it('a branch that moved after the card was shown: Allow is refused and the request withdrawn; nothing is copied', async () => {
      const t = submit(TASK(), 'req-appr-100003');
      const { approval } = await ask(t.id);
      commitOnBranch('later.js');
      await expect(decideExternalApproval(rt, t.id, { requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'approval_scope_changed' } });
      expect(listApprovalEvents(db, t.id).map(e => e.event)).toEqual(['requested', 'expired']);
      expect(getBridgeTask(db, t.id)).toMatchObject({ executor: null, status: 'awaiting_executor' });
      expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
    });

    it('a branch that moves between Allow and the start: the run is refused, no copy, nothing sent', async () => {
      const t = submit(TASK(), 'req-appr-100004');
      const { approval } = await ask(t.id);
      decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' }); // the owner's click
      commitOnBranch('sneaky.js');                                                                                // the branch moves before the start
      await expect(dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'host:jarvis', authority: 'host', consent: { externalTransfer: true }, approvalRequestId: approval!.requestId })).rejects.toMatchObject({ details: { reason: 'approval_scope_changed' } });
      expect(getBridgeTask(db, t.id).executor).toBeNull();
      expect(fs.existsSync(path.join(data, 'panda-workspaces'))).toBe(false);
    });

    it('an edited task text cannot ride on an approval', async () => {
      const t = submit(TASK(), 'req-appr-100005');
      const { approval } = await ask(t.id);
      decideApproval(db, { taskId: t.id, requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' });
      db.run('UPDATE bridge_tasks SET instruction = ? WHERE id = ?', ['Inspect everything and send it all. Do not modify files.', t.id]); // digest column left as it was
      await expect(dispatchBridgeTask(rt, t.id, { executor: 'claude', decidedBy: 'host:jarvis', authority: 'host', consent: { externalTransfer: true }, approvalRequestId: approval!.requestId })).rejects.toThrow(/does not cover/);
      expect(getBridgeTask(db, t.id).executor).toBeNull();
    });

    it('the card goes stale when the registry changes: access level or project removed -> Allow is refused', async () => {
      const t = submit(TASK(), 'req-appr-100006');
      const { approval } = await ask(t.id);
      tamper('projects.json', p => { p.access = 'read-write'; });
      await expect(decideExternalApproval(rt, t.id, { requestId: approval!.requestId, decision: 'approve', by: 'host:jarvis' })).rejects.toMatchObject({ code: 'conflict' });
      expect(listApprovalEvents(db, t.id).map(e => e.event)).toEqual(['requested', 'expired']);
      const t2 = submit(TASK(), 'req-appr-100007');
      tamper('projects.json', p => { p.access = 'read'; });
      const a2 = (await ask(t2.id)).approval!;
      fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ version: 1, projects: [] }));
      await expect(decideExternalApproval(rt, t2.id, { requestId: a2.requestId, decision: 'approve', by: 'host:jarvis' })).rejects.toMatchObject({ code: 'conflict' });
      expect(getBridgeTask(db, t2.id).executor).toBeNull();
    });

    it('a refusal never needs the card to be accurate: the owner can always say no', async () => {
      const t = submit(TASK(), 'req-appr-100008');
      const { approval } = await ask(t.id);
      commitOnBranch('refuse.js');
      await expect(decideExternalApproval(rt, t.id, { requestId: approval!.requestId, decision: 'refuse', by: 'host:jarvis' })).resolves.toBeDefined();
      expect(getBridgeTask(db, t.id)).toMatchObject({ status: 'cancelled', executor: null });
    });
  });
});
