import { describe, expect, it } from 'vitest';
import { explorerAgentReach, explorerModels, explorerSkill } from '../runtime/capabilityExplorer';
import type { ModelSnapshot } from '../runtime/modelAwareness';
import type { SkillManifest } from '../platform/skills/skillRuntime';

const snap: ModelSnapshot = {
  at: '2026-11-15T00:00:00Z', available: true, gpu: { name: 'RTX', totalVramMb: 24576, freeVramMb: 20000 }, selected: 'gemma4:12b', selectedKind: 'local',
  models: [
    { name: 'gemma4:12b', capabilities: ['completion', 'tools'], canSee: false, canUseTools: true, isEmbedding: false, loaded: true, selected: true, fitsGpu: true, autoEligible: true },
    { name: 'qwen2.5vl:7b', capabilities: ['vision'], canSee: true, canUseTools: false, isEmbedding: false, loaded: false, selected: false, fitsGpu: true, autoEligible: true },
    { name: 'nomic-embed-text', capabilities: ['embedding'], canSee: false, canUseTools: false, isEmbedding: true, loaded: false, selected: false, fitsGpu: true, autoEligible: true },
    { name: 'huge:200b', capabilities: [], canSee: false, canUseTools: false, isEmbedding: false, loaded: false, selected: false, fitsGpu: false, autoEligible: true },
    { name: 'x-uncensored', capabilities: [], canSee: false, canUseTools: false, isEmbedding: false, loaded: false, selected: false, fitsGpu: null, autoEligible: false },
  ],
};

describe('capability explorer: models', () => {
  const m = explorerModels(snap);
  const by = (n: string) => m.models.find((x) => x.name === n)!;
  it('keeps installed, loaded, selected and usable apart', () => {
    expect(by('gemma4:12b')).toMatchObject({ installed: true, loaded: true, selected: true, usable: true, vision: false, tools: true });
    expect(by('qwen2.5vl:7b')).toMatchObject({ loaded: false, selected: false, usable: true, vision: true });
  });
  it('does not call an embedding model or a model that does not fit usable for chat, and says why', () => {
    expect(by('nomic-embed-text')).toMatchObject({ usable: false });
    expect(by('nomic-embed-text').note).toMatch(/search, not for chat/);
    expect(by('huge:200b')).toMatchObject({ usable: false });
    expect(by('huge:200b').note).toMatch(/graphics memory/);
  });
  it('flags hand-pick-only models and keeps an unknown fit usable', () => {
    expect(by('x-uncensored')).toMatchObject({ manualOnly: true, usable: true, fitsGpu: null });
  });
});

const skill = (over: Partial<SkillManifest> = {}): SkillManifest => ({
  id: 's', name: 'S', description: 'd', version: '1', kind: 'procedure', source: 'user', trust: 'user',
  provenance: { origin: 'x', hash: 'h', loadedAt: '' }, tags: [], intents: [], taskClasses: [], requires: { capabilities: [] }, validation: [], hostHooks: [], body: '', flags: [], ...over,
});

describe('capability explorer: skills', () => {
  it('names a missing model ability instead of calling the skill ready', () => {
    const s = explorerSkill(skill({ requires: { capabilities: [], vision: true } }), { vision: false, tools: true });
    expect(s.usable).toBe('blocked');
    expect(s.missing).toEqual(['a model that can see images']);
  });
  it('says "checked per chat" when the model is unknown, and is ready', () => {
    const s = explorerSkill(skill({ requires: { capabilities: ['terminal.execute'], vision: true, workspace: true } }), undefined);
    expect(s.usable).toBe('ready');
    expect(s.needs.map((n) => n.status)).toEqual(['checked_per_chat', 'checked_per_chat', 'checked_per_chat']);
  });
  it('blocks untrusted and directive-flagged skills, never blocks a builtin, and never claims authorization', () => {
    expect(explorerSkill(skill({ trust: 'untrusted' }), undefined)).toMatchObject({ usable: 'blocked', blockedBy: expect.stringMatching(/does not run until you approve/) });
    expect(explorerSkill(skill({ flags: [{ severity: 'block', rule: 'ignore-previous', excerpt: 'x' }] }), undefined).usable).toBe('blocked');
    const b = explorerSkill(skill({ trust: 'builtin', source: 'builtin' }), undefined);
    expect(b.usable).toBe('ready');
    expect(b.authorized).toMatch(/approval gates/);
  });
});

describe('capability explorer: Agent Reach', () => {
  it('reports not installed honestly, and installed with its public channels and consent rule', () => {
    const allowed = { web: ['read'], github: ['search', 'read'] };
    const off = explorerAgentReach(false, allowed);
    expect(off).toMatchObject({ installed: false, usable: false });
    expect(off.detail).toMatch(/Not installed/);
    const on = explorerAgentReach(true, allowed);
    expect(on.channels).toEqual([{ channel: 'web', actions: ['read'] }, { channel: 'github', actions: ['search', 'read'] }]);
    expect(on.authorized).toMatch(/consent/);
  });
});
