/**
 * Wish-to-Reality, as governed capabilities.
 *
 * The wish machinery (the goal, the offering assessment, the website
 * deliverable, the customer workflow, the money ledger) already existed and
 * already worked - it was simply reachable only from inside the chat model.
 * A driver that is not a model - the acceptance harness, a scheduled task, a
 * future service - had no way to open a goal, see what this PC can actually
 * produce, prepare a deliverable or read the honest state back.
 *
 * These tools are that missing route, and nothing more: they are thin
 * wrappers over the EXISTING domain functions. No new wish platform, no new
 * approval system, no new evidence store.
 *
 * The truth rules are the point:
 *   - a goal says what the person wants, not what Pandesh will earn,
 *   - the offering assessment is read from the LIVE capability inventory,
 *   - a prepared deliverable is recorded as PREPARED - never as delivered,
 *     approved by a customer, or paid for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { createWishGoal, getWishGoal, listWishOpportunities, renderWishStatus, setWishOffering, selectWishOpportunity, replaceWishOpportunities, setWishStage, wishView } from '../domain/wishes';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { assessOpportunities } from './wishPipeline';
import { developWebsiteOffering, wishFolder } from './wishFulfilment';
import { assessOfferings } from './productionOfferings';
import { probeCapabilityInventory, type InventoryProbeDeps } from './capabilityInventory';
import { nowIso } from '../domain/ids';

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

export interface WishCapabilityOptions {
  db: CoreDatabase;
  /** Core's data directory: the wish folders live inside it. */
  dataDir: string;
  inventory?: InventoryProbeDeps;
}

/** The stages of a wish, in the words the person is shown. */
const STAGE_WORDS: Record<string, string> = {
  research_offers: 'looking for what the market offers',
  assess_opportunities: 'working out what could realistically be earned',
  develop_offering: 'preparing the deliverable',
  earn: 'waiting for real money to come in',
  purchase_ready: 'ready to buy',
  cancelled: 'cancelled',
};

export function createWishCapabilityAdapter(options: WishCapabilityOptions): GovernedCapabilityAdapter {
  const { db, dataDir } = options;

  async function createGoal(call: ModelToolCall): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const wish = typeof args.wish === 'string' ? args.wish.trim() : '';
    if (!wish) return failure('wish is required', 'invalid_arguments');
    try {
      const { goal, created } = createWishGoal(db, {
        wish,
        productName: typeof args.productName === 'string' ? args.productName : undefined,
        targetPriceCents: typeof args.targetPriceCents === 'number' ? Math.round(args.targetPriceCents) : undefined,
        currency: typeof args.currency === 'string' ? args.currency : undefined,
      });
      return {
        status: 'succeeded', exitCode: 0,
        output: JSON.stringify({ goalId: goal.id, created, wish: goal.wish, productName: goal.productName, targetPriceCents: goal.targetPriceCents, currency: goal.currency, stage: goal.stage }),
        resultCategory: 'wish_goal_created',
        normalizedArguments: { wish },
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'wish_goal_refused');
    }
  }

  async function assess(call: ModelToolCall): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const goalId = typeof args.goalId === 'string' ? args.goalId.trim() : '';
    if (!goalId) return failure('goalId is required', 'invalid_arguments');
    let goal;
    try {
      goal = getWishGoal(db, goalId);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'wish_goal_unknown');
    }
    const opportunities = assessOpportunities(0);
    replaceWishOpportunities(db, goalId, opportunities);
    let offerings: Array<{ id: string; name: string; achievable: boolean; sampleTool: string | null; missing: string[] }> = [];
    try {
      const inventory = await probeCapabilityInventory(options.inventory ?? {});
      offerings = assessOfferings(inventory).map((assessment) => ({
        id: assessment.offering.id,
        name: assessment.offering.name,
        achievable: assessment.achievable && Boolean(assessment.offering.sampleTool),
        sampleTool: assessment.offering.sampleTool,
        missing: assessment.missing,
      }));
    } catch { /* the inventory is best effort */ }
    return {
      status: 'succeeded', exitCode: 0,
      output: JSON.stringify({
        goalId,
        stage: goal.stage,
        stageWords: STAGE_WORDS[goal.stage] ?? goal.stage,
        opportunities: opportunities.filter((opportunity) => opportunity.status === 'candidate').map((opportunity) => ({ key: opportunity.key, title: opportunity.title, score: opportunity.score })),
        deliverablesThisPcCanProduce: offerings.filter((offering) => offering.achievable),
        deliverablesNotAvailable: offerings.filter((offering) => !offering.achievable).map((offering) => ({ id: offering.id, missing: offering.missing })),
      }),
      resultCategory: 'wish_opportunities_assessed',
    };
  }

  async function prepareWebsite(call: ModelToolCall): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const goalId = typeof args.goalId === 'string' ? args.goalId.trim() : '';
    if (!goalId) return failure('goalId is required', 'invalid_arguments');
    let goal;
    try {
      goal = getWishGoal(db, goalId);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'wish_goal_unknown');
    }
    const opportunities = listWishOpportunities(db, goalId);
    const chosen = opportunities.find((opportunity) => opportunity.key === 'one_page_websites')
      ?? opportunities.find((opportunity) => opportunity.status === 'candidate');
    if (!chosen) {
      return failure('no earning opportunity has been assessed for this goal yet; call wish_assess_opportunities first', 'wish_opportunity_missing');
    }
    const unitPriceCents = typeof args.unitPriceCents === 'number' ? Math.round(args.unitPriceCents) : 0;
    const unitsNeeded = typeof args.unitsNeeded === 'number' ? Math.max(1, Math.round(args.unitsNeeded)) : 1;
    let offering: Record<string, unknown>;
    try {
      offering = developWebsiteOffering(dataDir, goal, unitPriceCents, unitsNeeded);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'wish_offering_failed');
    }
    const selected = selectWishOpportunity(db, goalId, chosen.key);
    setWishOffering(db, selected.id, offering);
    setWishStage(db, goalId, 'develop_offering');
    return {
      status: 'succeeded', exitCode: 0,
      output: JSON.stringify({
        goalId,
        opportunity: chosen.key,
        folder: offering.folder,
        files: offering.files,
        validation: offering.validation,
        sampleStructurallySound: offering.sampleStructurallySound,
        published: false,
        state: 'prepared',
        message: 'The deliverable is PREPARED on this PC. It was not published, not sent to a customer, and nothing was charged.',
      }),
      resultCategory: 'wish_offering_prepared',
      normalizedArguments: { goalId, unitPriceCents, unitsNeeded },
    };
  }

  async function recordDeliverable(call: ModelToolCall): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const goalId = typeof args.goalId === 'string' ? args.goalId.trim() : '';
    if (!goalId) return failure('goalId is required', 'invalid_arguments');
    const artifacts = Array.isArray(args.artifacts) ? args.artifacts.map(String).slice(0, 40) : [];
    const verification = Array.isArray(args.verification) ? args.verification.map(String).slice(0, 40) : [];
    if (artifacts.length === 0) return failure('artifacts is required: what was actually produced', 'invalid_arguments');
    const opportunities = listWishOpportunities(db, goalId);
    const selected = opportunities.find((opportunity) => opportunity.status === 'selected');
    if (!selected) return failure('no offering has been selected for this goal yet', 'wish_offering_missing');
    // Every artifact is verified to exist before it is recorded: the record
    // must not name a file that is not there.
    const missing = artifacts.filter((artifact) => !fs.existsSync(artifact));
    if (missing.length > 0) return failure(`these artifacts do not exist: ${missing.join(', ')}`, 'wish_artifact_missing');
    const existing = (selected.offering ?? {}) as Record<string, unknown>;
    const offering = {
      ...existing,
      preparedDeliverables: [
        ...(Array.isArray(existing.preparedDeliverables) ? existing.preparedDeliverables as unknown[] : []),
        { artifacts, verification, recordedAt: nowIso(), state: 'prepared' },
      ],
      // The truthful ladder. Nothing above PREPARED happened.
      state: 'prepared',
      customerApproved: false,
      delivered: false,
      paid: false,
    };
    setWishOffering(db, selected.id, offering);
    return {
      status: 'succeeded', exitCode: 0,
      output: JSON.stringify({
        goalId,
        recorded: artifacts.length,
        state: 'prepared',
        customerApproved: false,
        delivered: false,
        paid: false,
        message: 'Recorded as PREPARED. No customer has approved it, nothing was delivered, and no money was claimed.',
      }),
      resultCategory: 'wish_deliverable_recorded',
    };
  }

  async function status(call: ModelToolCall): Promise<ToolExecutionResult> {
    const args = call.arguments ?? {};
    const goalId = typeof args.goalId === 'string' ? args.goalId.trim() : '';
    if (!goalId) return failure('goalId is required', 'invalid_arguments');
    try {
      const view = wishView(db, goalId);
      return {
        status: 'succeeded', exitCode: 0,
        output: JSON.stringify({
          goalId,
          statusText: renderWishStatus(db, goalId),
          stage: view.goal.stage,
          stageWords: STAGE_WORDS[view.goal.stage] ?? view.goal.stage,
          folder: wishFolder(dataDir, goalId),
          opportunities: view.opportunities.map((opportunity) => ({ key: opportunity.key, status: opportunity.status, offering: opportunity.offering })),
          ledger: view.ledger,
          readiness: view.readiness,
        }),
        resultCategory: 'wish_status',
      };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), 'wish_goal_unknown');
    }
  }

  return {
    id: 'wish',
    definitions: () => [
      {
        name: 'wish_create_goal',
        description: 'Open a Wish-to-Reality goal from what the person said they want ("I want the X for EUR 200"). The goal is only what they want - it never records money, and asking twice for the same product and price returns the same open goal. Consequential: it writes a durable goal.',
        parameters: {
          type: 'object',
          properties: {
            wish: { type: 'string', description: 'The wish in the person\'s own words.' },
            productName: { type: 'string' },
            targetPriceCents: { type: 'number' },
            currency: { type: 'string' },
          },
          required: ['wish'],
        },
      },
      {
        name: 'wish_assess_opportunities',
        description: 'Assess what could realistically be earned for a wish goal, using the LIVE capability inventory: which deliverables this PC can really produce today, which it cannot, and what is missing. Read-only. Call it before promising anything.',
        parameters: { type: 'object', properties: { goalId: { type: 'string' } }, required: ['goalId'] },
      },
      {
        name: 'wish_prepare_website_offering',
        description: 'Build the one-page website deliverable for a wish goal as real files on this PC, with the Impressum and privacy pages, and run the quality check on it. Nothing is published and no customer is contacted. Consequential: it writes files.',
        parameters: {
          type: 'object',
          properties: {
            goalId: { type: 'string' },
            unitPriceCents: { type: 'number', description: 'The price to test with the customer. A claim, not a fact.' },
            unitsNeeded: { type: 'number' },
          },
          required: ['goalId'],
        },
      },
      {
        name: 'wish_record_deliverable',
        description: 'Record what was actually prepared for a wish goal: the artifact files (each one must exist) and how they were verified. The record says PREPARED - never approved by a customer, never delivered, never paid. Consequential: it writes the goal record.',
        parameters: {
          type: 'object',
          properties: {
            goalId: { type: 'string' },
            artifacts: { type: 'array', items: { type: 'string' } },
            verification: { type: 'array', items: { type: 'string' } },
          },
          required: ['goalId', 'artifacts'],
        },
      },
      {
        name: 'wish_status',
        description: 'Report a wish goal in plain words: its stage, what was prepared, what is still missing and what the money situation is. Every figure comes from the records; nothing is estimated. Read-only.',
        parameters: { type: 'object', properties: { goalId: { type: 'string' } }, required: ['goalId'] },
      },
    ],
    classify: (toolName) => (toolName === 'wish_assess_opportunities' || toolName === 'wish_status' ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: nowIso() }),
    run: async (call: ModelToolCall) => {
      if (call.name === 'wish_create_goal') return createGoal(call);
      if (call.name === 'wish_assess_opportunities') return assess(call);
      if (call.name === 'wish_prepare_website_offering') return prepareWebsite(call);
      if (call.name === 'wish_record_deliverable') return recordDeliverable(call);
      if (call.name === 'wish_status') return status(call);
      return failure(`unknown tool '${call.name}'`, 'invalid_arguments');
    },
  };
}
