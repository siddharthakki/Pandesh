import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { explicitSpecialistRequest } from '../runtime/agentRouting';
import { createRevenueCapabilityAdapter } from '../runtime/revenueCapability';
import { decideDraft, pipelineSummary, readPipeline, recordOutcome } from '../domain/revenuePipeline';
import { BUILTIN_AGENTS } from '../domain/agents';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenue-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const run = (name: string, args: Record<string, unknown>) => createRevenueCapabilityAdapter({ dataDir: dir }).run({ id: 'c', name, arguments: args } as never, { cwd: dir } as never);

describe('revenue team agents', () => {
  it('routes requests to Sales, Marketing, Social Media and the Reviewer', () => {
    expect(explicitSpecialistRequest('Ask the Sales agent to find five catering prospects in Ulm.')).toBe('sales');
    expect(explicitSpecialistRequest('Ask your Social Media agent to draft three posts.')).toBe('social');
    expect(explicitSpecialistRequest('Ask Marketing to write a corporate catering offer.')).toBe('marketing');
    expect(explicitSpecialistRequest('Ask the Reviewer to check the offer.')).toBe('reviewer');
    expect(explicitSpecialistRequest('Ask the Coding specialist to fix the tests.')).toBe('coding');
  });

  it('none of them can send, publish or order anything', () => {
    for (const id of ['sales', 'marketing', 'social', 'reviewer']) {
      const a = BUILTIN_AGENTS.find((x) => x.id === id)!;
      expect(a.enabled).toBe(true);
      expect(a.tools.some((t) => /send|publish|wish_order|post_/.test(t))).toBe(false);
    }
    expect(BUILTIN_AGENTS.find((x) => x.id === 'reviewer')!.tools).not.toContain('write_file');
  });
});

describe('revenue pipeline is evidence-backed', () => {
  it('a lead needs its public source, an offer needs its file, and drafts always wait for the owner', async () => {
    expect((await run('revenue_record_lead', { track: 'catering', name: 'Firma X', category: 'office', why: 'x' })).output).toMatch(/source URL/);
    expect((await run('revenue_record_lead', { track: 'catering', name: 'Firma X', category: 'office', sourceUrl: 'https://example.org/x', why: 'canteen-less office' })).status).toBe('succeeded');
    expect((await run('revenue_record_offer', { track: 'catering', title: 'T', file: path.join(dir, 'missing.md'), summary: 's' })).output).toMatch(/does not exist/);
    fs.writeFileSync(path.join(dir, 'offer.md'), '# offer');
    expect((await run('revenue_record_offer', { track: 'catering', title: 'Corporate lunch', file: path.join(dir, 'offer.md'), summary: 's' })).status).toBe('succeeded');
    const draft = JSON.parse((await run('revenue_record_draft', { track: 'catering', kind: 'social', channel: 'instagram', text: 'Biryani Sunday is back in Neu-Ulm …' })).output).recorded;
    expect(draft.status).toBe('awaiting_approval');
    const s = pipelineSummary(readPipeline(dir).catering);
    expect(s).toMatchObject({ qualifiedLeads: 1, offersPrepared: 1, draftsAwaitingApproval: 1, responsesReceived: 0, verifiedRevenueEur: 0 });
    expect(pipelineSummary(readPipeline(dir).digital).qualifiedLeads).toBe(0); // tracks stay separate
  });

  it('only the owner records outcomes, and money needs an amount and evidence', async () => {
    expect((await run('revenue_record_outcome', { track: 'catering', kind: 'payment', amountEur: 500, evidence: 'made up' })).status).toBe('failed');
    expect(() => recordOutcome(dir, 'catering', { kind: 'payment', evidence: 'PayPal 12 Nov' })).toThrow(/amount/);
    expect(() => recordOutcome(dir, 'catering', { kind: 'response', evidence: 'x' })).toThrow(/evidence/);
    recordOutcome(dir, 'catering', { kind: 'payment', amountEur: 240, evidence: 'Bank transfer from Firma X, 12 Nov, ref 4711' });
    expect(pipelineSummary(readPipeline(dir).catering).verifiedRevenueEur).toBe(240);
  });

  it('approving a draft changes its status only', async () => {
    const draft = JSON.parse((await run('revenue_record_draft', { track: 'digital', kind: 'outreach', channel: 'letter', text: 'Sehr geehrte Damen und Herren, …' })).output).recorded;
    expect(decideDraft(dir, 'digital', draft.id, 'approved', null).status).toBe('approved');
    expect(pipelineSummary(readPipeline(dir).digital)).toMatchObject({ approvedOutreach: 1, responsesReceived: 0 });
  });
});

describe('revenue tools reach the agents', () => {
  it('a business request selects the revenue capability', async () => {
    const { selectCapabilitiesForIntent } = await import('../runtime/piCapabilityBridge');
    expect(selectCapabilitiesForIntent('Ask the Sales agent to find catering prospects and record them as leads')).toContain('revenue');
    expect(selectCapabilitiesForIntent('What is the weather in Ulm?')).not.toContain('revenue');
  });
});

describe('turn verdict for a completed hand-off', () => {
  it('judges delegate_to_agent by its status line, not by words inside the specialist report', async () => {
    const { evaluateTurnOutcome } = await import('../runtime/turnOutcome');
    const report = (head: string) => ({ content: [{ type: 'text', text: `${head}\n\nThe offer notes that orders are rejected until the trade registration is extended; nothing was sent.` }] });
    const done = evaluateTurnOutcome([{ tool: 'delegate_to_agent', status: 'completed', result: report('RESULT FROM THE MARKETING AGENT (completed in 61s):') }] as never);
    expect(done.refused).toEqual([]);
    expect(done.performed).toContain('delegate_to_agent');
    const notDone = evaluateTurnOutcome([{ tool: 'delegate_to_agent', status: 'completed', result: report('NOT DONE: the sales agent\'s task ended as "failed" after 158s.') }] as never);
    expect(notDone.refused).toContain('delegate_to_agent');
  });
});
