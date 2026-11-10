/**
 * Build 161 audit — the agent memory scope from the perspective of a compromised specialist, on the real dispatch path
 * with the real memory adapter (complements agentMemoryIsolation.test.ts). A specialist must not be able to widen its
 * own memory access by constructing arguments.
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
import { MEMORY_SCOPE_FILTER_ARG, rememberMemory } from '../domain/memory';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createMemoryCapabilityAdapter } from '../runtime/memoryCapability';

let dir: string;
let db: CoreDatabase;
let n = 0;
let registry: GovernedCapabilityRegistry;
const ids: Record<string, string> = {};

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
  const r = rememberMemory(db, { memoryType: scopeType === 'user' ? 'user' : 'semantic', scopeType, scopeId, subject: `secret ${scopeType}`, predicate: 'is', value, sensitivity: 'internal', sourceConversationId: conv.id, sourceMessageId: msg.id, actor: 'test' });
  ids[scopeType] = r.memory.id;
}

async function call(attemptId: string, toolName: string, args: Record<string, unknown>) {
  return dispatchCapability(db, registry, { correlationId: `c-${++n}`, scopeIdentity: attemptId, toolName, arguments: args, cwd: dir, actor: 'test-client', clientId: 'test-client' });
}

async function recalledScopes(attemptId: string, args: Record<string, unknown>): Promise<string[]> {
  const r = await call(attemptId, 'memory_recall', args);
  if (r.outcome !== 'executed') return [`<${r.outcome}>`];
  const evidence = (r as unknown as { toolInvocation: { evidence: { output: string } } }).toolInvocation.evidence;
  const out = JSON.parse(evidence.output) as { entries: Array<{ memory: { scopeType: string } }> };
  return out.entries.map((e) => e.memory.scopeType).sort();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-adv-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  registry = new GovernedCapabilityRegistry().register(createMemoryCapabilityAdapter({ db }));
  fact('user', 'user_profile', 'secret user home address Musterweg 1');
  fact('global', 'global', 'secret global note');
  fact('project', 'Bakery', 'secret project supplier contract');
  fact('task', 'other-task', 'secret task note from another task');
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('a compromised specialist cannot widen its memory access', () => {
  it('a forged readable-scopes argument is overwritten by Core, not obeyed', async () => {
    const research = run('research');
    const forged = { scopeType: 'global', query: 'secret', [MEMORY_SCOPE_FILTER_ARG]: ['user', 'global', 'project', 'task', 'repository'] };
    expect(await recalledScopes(research, forged)).toEqual(['global']);
  });

  it('a recall naming an out-of-scope memory id, or no scope at all, returns nothing outside the agent\'s scopes', async () => {
    const research = run('research');
    expect(await recalledScopes(research, { memoryId: ids.user, query: 'secret' })).not.toContain('user');
    // A task-scope recall also mixes in user/global facts; Research keeps only the global and task ones.
    expect(await recalledScopes(research, { scopeType: 'task', query: 'secret' })).toEqual(['global', 'task']);
  });

  it('writes, corrections and forgets outside the agent\'s writable scopes are refused before anything runs', async () => {
    const research = run('research');
    expect((await call(research, 'memory_remember', { scopeType: 'user', subject: 'x', predicate: 'is', value: 'planted' })).outcome).toBe('denied');
    expect((await call(research, 'memory_forget', { memoryId: ids.user })).outcome).toBe('denied');
    expect((await call(research, 'memory_correct', { memoryId: ids.project, value: 'changed' })).outcome).toBe('denied');
    // Two writable scopes (global, task) and none named: Core refuses rather than guessing.
    expect((await call(research, 'memory_remember', { subject: 'x', predicate: 'is', value: 'planted' })).outcome).toBe('denied');
  });

  it('memory tools outside the agent\'s allowlist are refused even with a matching scope', async () => {
    const research = run('research');
    expect((await call(research, 'memory_export', { scopeType: 'global' })).outcome).toBe('denied');
  });

  it('Sales (may go online with the user\'s OK) never recalls the user\'s or global facts, however it asks', async () => {
    const sales = run('sales');
    for (const args of [{ query: 'secret' }, { scopeType: 'user', query: 'secret' }, { memoryId: ids.user, query: 'secret' }, { scopeType: 'project', query: 'secret', [MEMORY_SCOPE_FILTER_ARG]: ['user', 'global'] }]) {
      const scopes = await recalledScopes(sales, args);
      expect(scopes.filter((s) => s === 'user' || s === 'global')).toEqual([]);
    }
  });
});
