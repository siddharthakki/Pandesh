/**
 * Alpha closure: Chief → specialist delegation through Core, and per-agent internet access enforced in Core
 * (default deny; prohibited, permitted, and delegations that try to exceed the parent).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { appendMessage, createConversation, getConversation } from '../domain/conversations';
import { createApproval } from '../domain/approvals';
import { dispatchCapability, listCapabilityActions } from '../domain/capabilityDispatch';
import {
  BUILTIN_AGENTS, agentScopeForAttempt, assignAgentRun, checkEgress, chiefDelegationScope, deriveScope, egressOf, egressPreapproved,
  isToolAllowed, listScopeRefusals, type EffectiveScope,
} from '../domain/agents';
import { delegationOutcome, startDelegation } from '../domain/delegation';
import { groupsForText, groupOfTool } from '../runtime/chatToolSelection';

let dir: string;
let db: CoreDatabase;
let n = 0;
const def = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!;

function submit(message: string, agentId?: string) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const r = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'baat_kar', conversationId: conv.id, workspaceRoot: dir,
    capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`, toolPermissionPolicy: {},
    selectedProvider: 'ollama', selectedModel: 'zeta:1b',
  });
  if (agentId) assignAgentRun(db, { requestId: r.request.id, agentId, conversationRoot: dir });
  return r;
}

const delegate = (parentAttemptId: string, toAgentId: string, brief: string, grant: Record<string, unknown> | null = null) =>
  startDelegation(db, { parentAttemptId, toAgentId, brief, grant, clientId: 'test-client', defaults: { selectedProvider: 'ollama', selectedModel: 'zeta:1b' }, workspaceRoot: dir, conversation: 'own' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deleg-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('internet access per agent (Core)', () => {
  it('defaults to deny when no layer authorizes egress', () => {
    const bare: EffectiveScope = { agentId: 'x', agentVersion: 1, depth: 0, conversationRoot: dir, layers: [{ source: 's', tools: null, deny: [], roots: null, memory: null, egress: null, localOnly: true }] };
    expect(egressOf(bare).mode).toBe('none');
    expect(checkEgress(bare, 'web_research', { query: 'x' }).allowed).toBe(false);
  });

  it('prohibited: Coding has no internet, but a local preview page is not internet', () => {
    const coding = deriveScope(def('coding'), dir, chiefDelegationScope(dir));
    const web = checkEgress(coding, 'browser_open_site', { url: 'https://example.com' });
    expect(web.allowed).toBe(false);
    expect((web as { reason: string }).reason).toMatch(/no internet access/);
    expect(checkEgress(coding, 'browser_open_site', { url: 'http://127.0.0.1:5173/' })).toMatchObject({ allowed: true, network: false });
    expect(checkEgress(coding, 'read_file', { path: 'a.ts' })).toMatchObject({ allowed: true, network: false });
  });

  it('permitted: Research delegated by Pandesh may go online, only with the user\'s OK', () => {
    const research = deriveScope(def('research'), dir, chiefDelegationScope(dir));
    expect(checkEgress(research, 'web_research', { query: 'EU AI act summary' })).toMatchObject({ allowed: true, needsApproval: true, network: true });
  });

  it('a domain grant narrows: only listed domains, no open search', () => {
    const research = deriveScope(def('research'), dir, chiefDelegationScope(dir), { egress: { domains: ['github.com'] } });
    expect(checkEgress(research, 'browser_open_site', { url: 'https://github.com/org/repo' }).allowed).toBe(true);
    expect(checkEgress(research, 'browser_open_site', { url: 'https://api.github.com/x' }).allowed).toBe(true);
    expect(checkEgress(research, 'browser_open_site', { url: 'https://evil.example/' }).allowed).toBe(false);
    expect(checkEgress(research, 'web_research', { query: 'anything' }).allowed).toBe(false);
  });

  it('exceeding the parent: Research delegated by Coding gets no internet; a grant cannot add it back', () => {
    const coding = deriveScope(def('coding'), dir, chiefDelegationScope(dir));
    const research = deriveScope(def('research'), dir, coding, { egress: { domains: ['example.com'] } });
    expect(egressOf(research).mode).toBe('none');
    const r = checkEgress(research, 'browser_read', { url: 'https://example.com' });
    expect(r.allowed).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/delegation does not authorize/);
  });

  it('a claimed pre-approval only counts when Core holds a real approved record', () => {
    const parent = submit('research something');
    const fake = deriveScope(def('research'), dir, chiefDelegationScope(dir), { egressApprovalId: 'apr_fake' });
    expect(egressPreapproved(db, fake)).toBe(false);
    const approval = createApproval(db, { attemptId: parent.attempt.id, kind: 'mutation', summary: { toolName: 'delegate_to_agent' }, actor: 'test', initialResolution: 'approved', resolvedBy: 'user' } as never);
    const real = deriveScope(def('research'), dir, chiefDelegationScope(dir), { egressApprovalId: approval.id });
    expect(egressPreapproved(db, real)).toBe(true);
  });

  it('dispatch refuses a network capability for an agent without internet and records it', async () => {
    const registry = { classify: () => null, healthSnapshot: () => ({}), prepare: async (_t: string, a: Record<string, unknown>) => a } as never;
    const run = submit('preview the site', 'coding');
    const r = await dispatchCapability(db, registry, { cwd: '', actor: 'model', clientId: 'test-client', correlationId: 'e1', scopeIdentity: run.attempt.id, toolName: 'browser_open_site', arguments: { url: 'https://example.com' } });
    expect(r.outcome).toBe('denied');
    expect((r as { reason?: string }).reason).toMatch(/no internet access/);
    expect(listScopeRefusals(db, 'coding')[0]).toMatchObject({ toolName: 'browser_open_site' });
    const local = await dispatchCapability(db, registry, { cwd: '', actor: 'model', clientId: 'test-client', correlationId: 'e2', scopeIdentity: run.attempt.id, toolName: 'browser_open_site', arguments: { url: 'http://localhost:3000' } });
    expect(local.outcome).toBe('unknown_tool');
  });
});

describe('Chief → specialist delegation', () => {
  it('an ordinary Pandesh turn delegates to Research in its own conversation with a scope bounded by the turn', () => {
    const parent = submit('Find out what changed in the EU AI Act this year');
    const started = delegate(parent.attempt.id, 'research', 'Summarise the 2026 changes to the EU AI Act with sources.');
    expect(started.duplicate).toBe(false);
    expect(started.handoff).toMatchObject({ fromAgentId: 'chief', toAgentId: 'research', status: 'running', depth: 1 });
    expect(getConversation(db, started.conversationId!).title).toMatch(/^Research · Summarise/);
    const scope = agentScopeForAttempt(db, started.attemptId)!;
    expect(scope.agentId).toBe('research');
    expect(scope.layers.map((l) => l.source)).toContain('chief-delegation');
    expect(isToolAllowed(scope, 'write_file').allowed).toBe(false);
    expect(isToolAllowed(scope, 'web_research').allowed).toBe(true);
  });

  it('returns the child\'s answer once its attempt completes', () => {
    const parent = submit('Check the project tests');
    const started = delegate(parent.attempt.id, 'coding', 'Run the project checks and report which passed.');
    expect(delegationOutcome(db, started.handoff.id)).toMatchObject({ answer: null });
    appendMessage(db, started.conversationId!, { role: 'assistant', content: 'All 12 checks passed.', actor: 'core', clientId: null } as never);
    db.run("UPDATE attempts SET status = 'completed' WHERE id = ?", [started.attemptId]);
    const out = delegationOutcome(db, started.handoff.id);
    expect(out).toMatchObject({ status: 'completed', answer: 'All 12 checks passed.', handoffStatus: 'returned' });
  });

  it('keeps the limits: dedupe, fan-out 3, depth 2', () => {
    const parent = submit('Plan a launch');
    const a = delegate(parent.attempt.id, 'research', 'Research three competitor launch pages and list their claims.');
    expect(delegate(parent.attempt.id, 'research', 'Research three competitor launch pages and list their claims.').duplicate).toBe(true);
    delegate(parent.attempt.id, 'coding', 'Check the landing page builds without errors.');
    delegate(parent.attempt.id, 'operations', 'Check free disk space for the build.');
    expect(() => delegate(parent.attempt.id, 'personal', 'Remind me on Friday about the launch review.')).toThrow(/3 active delegations/);
    const d2 = delegate(a.attemptId!, 'coding', 'Build a comparison table file from the research notes.');
    expect(d2.handoff.depth).toBe(2);
    expect(() => delegate(d2.attemptId!, 'operations', 'Check disk space before writing the table.')).toThrow(/depth 3/);
  });

  it('a Coding child inherits no internet and no folder outside the conversation', () => {
    const parent = submit('fix the failing test');
    const started = delegate(parent.attempt.id, 'coding', 'Fix the failing unit test in the selected project and run checks.');
    const scope = agentScopeForAttempt(db, started.attemptId)!;
    expect(checkEgress(scope, 'browser_open_site', { url: 'https://stackoverflow.com' }).allowed).toBe(false);
    expect(egressOf(scope).mode).toBe('none');
  });

  it('a delegated child\'s approval is listed under the delegating conversation, where the person is', () => {
    const parent = submit('run the tests');
    const started = delegate(parent.attempt.id, 'coding', 'Run calc.test.js with node and report the exact result.');
    const approval = createApproval(db, { attemptId: started.attemptId!, kind: 'mutation', summary: { toolName: 'run_checks', cardText: 'run node calc.test.js' }, actor: 'test' } as never);
    const listed = listCapabilityActions(db, { correlationId: parent.request.conversationId!, clientId: 'test-client' });
    expect(listed.actions.find((a) => a.approvalId === approval.id)).toMatchObject({ attemptId: started.attemptId, toolName: 'run_checks' });
    const other = submit('unrelated');
    expect(listCapabilityActions(db, { correlationId: other.request.conversationId!, clientId: 'test-client' }).actions.some((a) => a.approvalId === approval.id)).toBe(false);
  });

  it('the delegate tool is offered when the user asks for an agent', () => {
    expect(groupOfTool('delegate_to_agent')).toBe('agents');
    expect(groupsForText('Ask the research agent to compare three laptops').has('agents')).toBe(true);
    expect(groupsForText('What is 2 plus 3?').has('agents')).toBe(false);
  });
});
