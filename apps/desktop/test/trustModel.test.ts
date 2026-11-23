import { describe, expect, it } from 'vitest';
import { buildTrust, type TrustInputs } from '../renderer-v2/src/trustModel';
import type { AgentStatus } from '../renderer-v2/src/agentsModel';

const NOW = Date.parse('2026-11-23T10:00:00Z');
const agent = (id: string, egress: AgentStatus['agent']['egress'], alwaysAsk: string[] = [], enabled = true): AgentStatus => ({
  agent: { id, name: id, role: '', enabled, availability: 'available', egress, alwaysAsk, modelPolicy: { localOnly: true, models: [] } },
  state: 'idle', activeRuns: 0, runs: 0, completed: 0, failed: 0, refusals: 0, lastRun: null,
});
// What the scratch Core and host reported on 2026-11-23 (trimmed).
const base: TrustInputs = {
  permission: { mode: 'ask', authorizations: [], categories: { workspace_git_commit: 'git add and git commit inside the trusted workspace' } },
  workspace: null,
  projects: [{ name: 'CalcDemo', access: 'read-write', paths: ['D:\\x'], preferredAgents: ['claude'] }, { name: 'Pandesh', access: 'read', paths: ['D:\\y'], preferredAgents: [] }],
  pairings: [{ label: 'ChatGPT (live test)', revokedAt: null, lastSeenAt: null }, { label: 'Old browser', revokedAt: '2026-11-20T00:00:00Z', lastSeenAt: null }],
  phone: { access: 'off', pairedCount: 0, devices: [] },
  agents: [agent('chief', 'none'), agent('research', { domains: ['duckduckgo.com'] }), agent('mail', 'approval', ['email_send'])],
  connectors: [{ id: 'gmail', label: 'Gmail', state: 'not_configured', permissions: { read: false, draft: false, execute: false } }],
  provider: 'ollama',
  routines: [],
  now: NOW,
};
const area = (i: TrustInputs, id: string) => buildTrust(i).find((a) => a.id === id)!;

describe('Trust Map model', () => {
  it('reads each area from its real record, never more open than the record says', () => {
    const levels = Object.fromEntries(buildTrust(base).map((a) => [a.id, a.level]));
    expect(levels).toEqual({ chat: 'asks', workspace: 'never', projects: 'asks', clients: 'asks', phone: 'never', internet: 'free', accounts: 'never', cloud: 'never', routines: 'never' });
    expect(area(base, 'clients').facts).toHaveLength(1); // the revoked pairing is not a live permission
    expect(area(base, 'internet').facts.map((f) => f.level)).toEqual(['never', 'free', 'asks']);
  });

  it('an Auto grant only counts while it has not expired; Plan only blocks changes', () => {
    const auto = { ...base, permission: { ...base.permission!, mode: 'auto' as const, authorizations: [{ categories: ['workspace_git_commit'], workspaceRoot: 'D:\\w', expiresAt: new Date(NOW + 600_000).toISOString() }] } };
    expect(area(auto, 'chat')).toMatchObject({ level: 'free' });
    expect(area(auto, 'chat').facts.some((f) => f.level === 'free' && f.text.includes('git add and git commit'))).toBe(true);
    const expired = { ...auto, permission: { ...auto.permission, authorizations: [{ ...auto.permission.authorizations[0], expiresAt: new Date(NOW - 1).toISOString() }] } };
    expect(area(expired, 'chat').level).toBe('asks');
    expect(area({ ...base, permission: { ...base.permission!, mode: 'plan' } }, 'chat').level).toBe('never');
  });

  it('a source that did not answer is shown as unknown, not as safe or open', () => {
    const a = area({ ...base, projects: null }, 'projects');
    expect(a.known).toBe(false);
    expect(a.facts).toEqual([]);
    expect(a.summary).toMatch(/did not answer/);
  });

  it('a read-only workspace cannot write; a cloud model is shown as leaving the PC', () => {
    expect(area({ ...base, workspace: { folder: 'D:\\w', access: 'read' } }, 'workspace').facts.map((f) => f.level)).toEqual(['free', 'never']);
    expect(area({ ...base, provider: 'cloud' }, 'cloud').level).toBe('free');
  });

  it('a routine with an active grant writes without asking, within its frozen limit', () => {
    const r = area({ ...base, routines: [{ title: 'Nightly notes', folder: 'D:\\n', status: 'active', active: { frozen: { limits: { maxFiles: 8 } } } }] }, 'routines');
    expect(r.level).toBe('free');
    expect(r.facts[0].text).toContain('up to 8 files');
  });
});

describe('Trust Map review fixes (2026-11-23)', () => {
  it('chat keeps reads and changes apart instead of implying everything asks', () => {
    const a = area(base, 'chat');
    expect(a.status).toBe('Reads freely · changes ask');
    expect(a.facts.map((f) => f.level)).toEqual(['free', 'asks']);
  });
  it('an allowed phone with nothing paired shows policy and availability separately, permission unchanged', () => {
    const a = area({ ...base, phone: { access: 'lan', pairedCount: 0, devices: [] } }, 'phone');
    expect(a.level).toBe('asks');
    expect(a.status).toBe('Approval required · no phone paired');
    expect(a.facts.map((f) => f.text.split(':')[0])).toEqual(['Policy', 'Availability']);
    expect(a.facts[1].level).toBe('never');
  });
});