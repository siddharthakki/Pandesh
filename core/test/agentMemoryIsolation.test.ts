/**
 * Release blocker (2026-11-09): agent memory scopes must hold on recall, not only on the requested scopeType.
 * A recall at one scope also returns user/global facts, and a user-scope keyword recall includes project facts, so a
 * specialist could read memories outside its scopes. Proven here on the real dispatch path with the real memory adapter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { appendMessage, createConversation } from '../domain/conversations';
import { dispatchCapability } from '../domain/capabilityDispatch';
import { assignAgentRun } from '../domain/agents';
import { rememberMemory } from '../domain/memory';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';

let dir: string;
let db: CoreDatabase;
let n = 0;
let registry: GovernedCapabilityRegistry;

function run(agentId?: string) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const r = submitRequest(db, {
    clientId: 'test-client', currentMessage: 'recall', requestedMode: 'baat_kar', conversationId: conv.id, workspaceRoot: dir,
    capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`, toolPermissionPolicy: {},
    selectedProvider: 'ollama', selectedModel: 'zeta:1b',
  });
  if (agentId) assignAgentRun(db, { requestId: r.request.id, agentId, conversationRoot: dir });
  return r.attempt.id;
}

function fact(scopeType: 'user' | 'global' | 'project' | 'task', scopeId: string, value: string) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const msg = appendMessage(db, conv.id, { role: 'user', content: value, actor: 'test' }) as { id: string };
  rememberMemory(db, { memoryType: scopeType === 'user' ? 'user' : 'semantic', scopeType, scopeId, subject: `secret ${scopeType}`, predicate: 'is', value, sensitivity: 'internal', sourceConversationId: conv.id, sourceMessageId: msg.id, actor: 'test' });
}

async function recall(attemptId: string, args: Record<string, unknown>): Promise<string[]> {
  const r = await dispatchCapability(db, registry, { correlationId: `recall-${++n}`, scopeIdentity: attemptId, toolName: 'memory_recall', arguments: args, cwd: dir, actor: 'test-client', clientId: 'test-client' });
  if (r.outcome !== 'executed') return [`<${r.outcome}>`];
  const out = JSON.parse(String((r as { toolInvocation: { evidence: unknown } }).toolInvocation.evidence && JSON.parse(JSON.stringify((r as { toolInvocation: { evidence: { output: string } } }).toolInvocation.evidence)).output));
  return (out.entries as Array<{ memory: { scopeType: string } }>).map((e) => e.memory.scopeType).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  registry = new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db }));
  fact('user', 'user_profile', 'secret user home address Musterweg 1');
  fact('global', 'global', 'secret global note');
  fact('project', 'Bakery', 'secret project supplier contract');
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('agent memory isolation on recall', () => {
  it('Research (global + task) cannot read the user\'s private facts or project facts, however it asks', async () => {
    const research = run('research');
    expect(await recall(research, { scopeType: 'global', query: 'secret' })).toEqual(['global']);
    expect(await recall(research, { scopeType: 'user', query: 'secret' })).toEqual(['<denied>']);
    expect(await recall(research, { scopeType: 'project', query: 'secret' })).toEqual(['<denied>']);
  });

  it('Personal (user + task) sees the user fact but not global or project facts that recall would mix in', async () => {
    const personal = run('personal');
    expect(await recall(personal, { scopeType: 'user', query: 'secret' })).toEqual(['user']);
  });

  it('Coding has no memory tool at all', async () => {
    expect(await recall(run('coding'), { scopeType: 'project', query: 'secret' })).toEqual(['<denied>']);
  });

  it('Social Media (task only) reads nothing it was not given', async () => {
    const social = run('social');
    expect(await recall(social, { scopeType: 'task', query: 'secret' })).toEqual([]);
  });

  it('the user\'s own chat (no agent scope) still recalls across user, global and project facts', async () => {
    const plain = run();
    expect(await recall(plain, { scopeType: 'user', query: 'secret' })).toEqual(['global', 'project', 'user']);
  });
});
