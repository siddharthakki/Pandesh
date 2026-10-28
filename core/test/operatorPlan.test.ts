import { describe, expect, it } from 'vitest';
import {
  classifyPrivacy, classifyWorkflow, planWorkflow, sanitizeOutboundQuery, selectTool,
  type CatalogEntry, type ToolCatalog,
} from '../domain/operatorPlan';

const entry = (over: Partial<CatalogEntry> & Pick<CatalogEntry, 'id' | 'provides'>): CatalogEntry => ({
  kind: 'executor', label: over.id, locality: 'local', available: true, reason: null, preference: 50, ...over,
});
const catalog = (...entries: CatalogEntry[]): ToolCatalog => ({ probedAt: 'now', entries });

const RESEARCH = "Pandesh, research today's important AI developments and tell me which techniques could improve Pandesh.";
const FILES = 'Find PDF invoices in my Downloads folder and show me how they should be organized.';
const CODING = 'Build a small responsive website, test it and show me the finished result.';

describe('workflow planning from one instruction', () => {
  it('recognises the three first-slice workflows', () => {
    expect(classifyWorkflow(RESEARCH)).toBe('public_research');
    expect(classifyWorkflow(FILES)).toBe('local_files');
    expect(classifyWorkflow(CODING)).toBe('coding');
    expect(classifyWorkflow('hello there')).toBe('unsupported');
  });

  it('treats personal files as local-only and public research / generic coding as public', () => {
    expect(planWorkflow(FILES).privacy).toBe('local_only');
    expect(planWorkflow(RESEARCH).privacy).toBe('public');
    expect(planWorkflow(CODING).privacy).toBe('public');
    expect(classifyPrivacy('Summarise my Gmail from last week', 'unsupported').privacy).toBe('local_only');
    expect(classifyPrivacy('Review the JUGAAD margins', 'unsupported').privacy).toBe('local_only');
    expect(classifyPrivacy('Build a site. password: hunter2', 'coding').privacy).toBe('local_only');
  });

  it('plans file work read-only first with the move behind an approval', () => {
    const kinds = planWorkflow(FILES).steps.map(s => s.kind);
    expect(kinds.indexOf('verify_proposal')).toBeLessThan(kinds.indexOf('approve_move'));
    expect(kinds.indexOf('approve_move')).toBeLessThan(kinds.indexOf('apply_move'));
    expect(planWorkflow(FILES).steps.find(s => s.kind === 'approve_move')!.approval).toBe('file_move');
    expect(planWorkflow(RESEARCH).steps[0].approval).toBe('egress');
  });
});

describe('tool selection under the privacy policy', () => {
  const opencode = entry({ id: 'executor:opencode', provides: ['coding_executor'], preference: 10 });
  const hermes = entry({ id: 'executor:hermes', provides: ['coding_executor'], preference: 20 });
  const claude = entry({ id: 'executor:claude', label: 'Claude Code', provides: ['coding_executor'], locality: 'external', preference: 90 });

  it('prefers a local executor and reports what it considered', () => {
    const s = selectTool('coding_executor', catalog(claude, hermes, opencode), { privacy: 'public' });
    expect(s.ok && s.entry.id).toBe('executor:opencode');
    expect(s.considered.map(c => [c.id, c.verdict])).toEqual([
      ['executor:opencode', 'selected'], ['executor:hermes', 'available'], ['executor:claude', 'rejected'],
    ]);
  });

  it('skips an unavailable tool without consulting a less-preferred external one', () => {
    const s = selectTool('coding_executor', catalog({ ...opencode, available: false, reason: 'not installed' }, claude), { privacy: 'public' });
    expect(s).toMatchObject({ ok: false, code: 'external_consent_required' });
  });

  it('uses an external tool only with consent, and never for a private task', () => {
    const only = catalog(claude);
    expect(selectTool('coding_executor', only, { privacy: 'public', consent: { externalTransfer: true } }).ok).toBe(true);
    expect(selectTool('coding_executor', only, { privacy: 'local_only', consent: { externalTransfer: true } })).toMatchObject({ ok: false, code: 'privacy_blocked' });
  });

  it('never falls back across a boundary: a failed local choice does not become an external one', () => {
    const s = selectTool('coding_executor', catalog({ ...opencode, available: false, reason: 'down' }, { ...hermes, available: false, reason: 'down' }, claude), { privacy: 'local_only' });
    expect(s).toMatchObject({ ok: false, code: 'privacy_blocked' });
  });

  it('treats an explicit choice as binding', () => {
    const c = catalog(opencode, { ...hermes, available: false, reason: 'not installed' });
    expect(selectTool('coding_executor', c, { privacy: 'public', pinned: 'opencode' }).ok).toBe(true);
    const pinnedDown = selectTool('coding_executor', c, { privacy: 'public', pinned: 'hermes' });
    expect(pinnedDown).toMatchObject({ ok: false, code: 'pinned_unavailable' });
    expect(selectTool('coding_executor', c, { privacy: 'public', pinned: 'nonesuch' })).toMatchObject({ ok: false, code: 'pinned_unavailable' });
    expect(selectTool('coding_executor', catalog(claude), { privacy: 'local_only', pinned: 'claude', consent: { externalTransfer: true } })).toMatchObject({ ok: false, code: 'pinned_privacy_violation' });
    expect(selectTool('coding_executor', catalog(claude), { privacy: 'public', pinned: 'claude' })).toMatchObject({ ok: false, code: 'external_consent_required' });
  });

  it('matches a pinned model by bare name', () => {
    const m = entry({ id: 'ollama:gemma4:12b', kind: 'model', label: 'gemma4:12b', provides: ['local_model'] });
    expect(selectTool('local_model', catalog(m), { privacy: 'local_only', pinned: 'gemma4:12b' }).ok).toBe(true);
  });
});

describe('outbound query sanitization', () => {
  it('removes paths, addresses and long numbers', () => {
    expect(sanitizeOutboundQuery('AI agents C:\\Users\\sid\\Downloads\\x.pdf news bob@example.com 12345678')).toEqual({ ok: true, query: 'AI agents news' });
  });
  it('refuses a query that looks confidential', () => {
    expect(sanitizeOutboundQuery('api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789')).toMatchObject({ ok: false });
    expect(sanitizeOutboundQuery('C:\\Users\\sid')).toMatchObject({ ok: false });
  });
});
