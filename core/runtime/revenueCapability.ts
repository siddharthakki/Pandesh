/**
 * Revenue capability: the tools Sales, Marketing and Social Media use to record their work in the revenue pipeline
 * (core/domain/revenuePipeline.ts). They only write Pandesh's own local notebook — nothing is sent, published or spent —
 * and they cannot record responses, orders or money: those come only from the user, through the app.
 */
import type { GovernedCapabilityAdapter, CapabilityHealth } from './governedCapability';
import type { ModelToolCall, ModelToolDefinition } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';
import { pipelineSummary, readPipeline, recordDraft, recordLead, recordOffer, requireTrack, TRACKS } from '../domain/revenuePipeline';

const track = { type: 'string', enum: ['catering', 'digital'], description: 'catering = Kha Ke Dikha catering; digital = Wish-to-Reality digital services. Keep the two separate.' };

const definitions: ModelToolDefinition[] = [
  {
    name: 'revenue_record_lead',
    description: 'Record one qualified prospect you found in a lawful PUBLIC source (company website, public directory, public event listing). Requires the source URL. Never record private persons or personal contact data that was not published for business enquiries.',
    parameters: { type: 'object', properties: { track, name: { type: 'string' }, category: { type: 'string' }, sourceUrl: { type: 'string' }, why: { type: 'string', description: 'Why this is a fit, from the source.' }, contactRoute: { type: 'string', description: 'The published business channel (e.g. "contact form on website", "office phone"), not a private address.' }, qualified: { type: 'boolean' } }, required: ['track', 'name', 'category', 'sourceUrl', 'why'] },
  },
  {
    name: 'revenue_record_offer',
    description: 'Record an offer you wrote to a file in the workspace (write it with write_file first). The file must exist.',
    parameters: { type: 'object', properties: { track, title: { type: 'string' }, file: { type: 'string', description: 'Absolute path of the offer file.' }, summary: { type: 'string' } }, required: ['track', 'title', 'file', 'summary'] },
  },
  {
    name: 'revenue_record_draft',
    description: 'Record an outreach or social-media draft. It goes to the owner\'s approval queue; nothing is sent or published by Pandesh.',
    parameters: { type: 'object', properties: { track, kind: { type: 'string', enum: ['outreach', 'social'] }, channel: { type: 'string', description: 'letter, phone script, instagram, facebook, google business, …' }, text: { type: 'string' }, leadId: { type: 'string' } }, required: ['track', 'kind', 'channel', 'text'] },
  },
  {
    name: 'revenue_list',
    description: 'Read the revenue pipeline of one track: leads, offers, drafts and the owner-recorded outcomes, with the dashboard counts.',
    parameters: { type: 'object', properties: { track }, required: ['track'] },
  },
];

const ok = (payload: unknown): ToolExecutionResult => ({ status: 'succeeded', exitCode: 0, output: JSON.stringify(payload).slice(0, 12_000), resultCategory: 'revenue_ok' });
const fail = (message: string): ToolExecutionResult => ({ status: 'failed', exitCode: 1, output: `NOT DONE: ${message}`, resultCategory: 'revenue_refused' });

export function createRevenueCapabilityAdapter(options: { dataDir: string }): GovernedCapabilityAdapter {
  const health: CapabilityHealth = { state: 'available', checkedAt: new Date().toISOString() };
  return {
    id: 'revenue',
    definitions: () => definitions,
    // Local notebook entries only; the owner approves every draft and records every real-world outcome.
    classify: () => 'read_only',
    health: () => health,
    async run(call: ModelToolCall, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const a = (call.arguments ?? {}) as Record<string, unknown>;
      try {
        const t = requireTrack(a.track);
        switch (call.name) {
          case 'revenue_record_lead': return ok({ recorded: recordLead(options.dataDir, t, a as never, 'agent') });
          case 'revenue_record_offer': return ok({ recorded: recordOffer(options.dataDir, t, a as never, 'agent') });
          case 'revenue_record_draft': return ok({ recorded: recordDraft(options.dataDir, t, a as never, 'agent'), note: 'Waiting for the owner\'s approval in the Revenue dashboard. Nothing was sent.' });
          case 'revenue_list': { const p = readPipeline(options.dataDir)[t]; return ok({ track: TRACKS[t], summary: pipelineSummary(p), ...p }); }
          default: return fail(`unknown revenue tool ${call.name}`);
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
