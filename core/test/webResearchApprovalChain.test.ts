/**
 * One isolated verification of the whole web-research approval chain, on the
 * existing governed approval engine (no second approval path).
 *
 * The action genuinely requires approval under current policy: the research
 * capability is classified `consequential` because the gated resource is
 * network egress (ADR-7). The real research adapter is used, with a stubbed
 * fetch, so nothing leaves this machine.
 *
 * The traced sequence:
 *   1. Core requests approval for the web search.
 *   2. Core creates the approval and publishes the pending authorization.
 *   3. The desktop host receives it and builds the card.
 *   4. The cockpit enters `authState: 'pending'`.
 *   5. The renderer shows an actionable card.
 *   6. The user's Approve reaches Core and the action resumes.
 *   7. The web search runs and the result carries the sources.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, listCapabilityActions, resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createResearchCapabilityAdapter } from '../runtime/researchCapability';
import { projectMissionCockpit } from '../../apps/desktop/src/host/missionCockpit';
import { selectActionableApproval, toDesktopApprovalCard, toApprovalEnvelope } from '../../apps/desktop/src/host/desktopApproval';

const CLIENT = 'desktop-web-research-test';
let dir: string;
let db: CoreDatabase;
let fetched: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-web-research-chain-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  fetched = [];
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The real research adapter, with the network replaced by a stub. */
function registryWithResearch(): GovernedCapabilityRegistry {
  const adapter = createResearchCapabilityAdapter({
    providerUrl: 'https://search.invalid',
    fetchFn: (async (url: string | URL) => {
      fetched.push(String(url));
      const target = String(url);
      if (target.includes('format=json')) {
        return new Response(JSON.stringify({
          results: [{ url: 'https://example.com/story', title: 'A fresh local AI story' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        `<html><body><article>${'Local model work continues. '.repeat(20)}</article></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch,
  });
  return new GovernedCapabilityRegistry().register(adapter);
}

describe('a web research request that needs approval reaches the user and can be approved', () => {
  it('runs the whole chain: request -> card -> decision -> search', async () => {
    const registry = registryWithResearch();

    // 1. The action genuinely needs approval: Core asks, it does not just run it.
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'web-research-1',
      toolName: 'governed_research',
      arguments: { query: 'latest local AI news' },
      cwd: process.cwd(),
      actor: 'core',
      clientId: CLIENT,
    });
    expect(requested.outcome).toBe('approval_required');
    expect(fetched).toHaveLength(0); // nothing was searched before the decision

    // 2. Core created a durable approval and published the pending authorization.
    const approval = requested.approval;
    expect(approval.status).toBe('pending');
    const events = db.all<{ eventType: string }>(
      'SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence', [approval.id],
    );
    expect(events.map((e) => e.eventType)).toContain('approval_requested');

    // 3. The desktop host reads the same durable state and builds the card.
    const actions = listCapabilityActions(db, { correlationId: 'web-research-1', clientId: CLIENT });
    const action = selectActionableApproval(actions.actions);
    expect(action, 'the desktop must find an actionable approval').not.toBeNull();
    expect(action!.approvalId).toBe(approval.id);
    expect(action!.status).toBe('pending');
    expect(action!.actionable).toBe(true);

    const card = toDesktopApprovalCard(action!);
    expect(card.toolName).toBe('governed_research');
    expect(card.detail).toBeTruthy();

    // 4. The cockpit enters authState: 'pending' — the state the renderer reads.
    const cockpit = projectMissionCockpit([], {
      requestId: 'req-1',
      attemptId: action!.attemptId,
      running: true,
      terminal: false,
      pendingApproval: card,
      approvedApproval: null,
      startedAt: new Date().toISOString(),
      nowMs: Date.now(),
    } as Parameters<typeof projectMissionCockpit>[1]);
    expect(cockpit.authState).toBe('pending');
    expect(cockpit.pendingApproval?.toolName).toBe('governed_research');

    // 5./6. The user's decision reaches Core through the same envelope the
    // desktop renders, and the action resumes.
    const envelope = toApprovalEnvelope(action!);
    const resolvedApproval = resolveCapabilityApproval(db, {
      ...envelope,
      resolution: 'approved',
      actor: CLIENT,
      clientId: CLIENT,
    });
    expect(resolvedApproval.status).toBe('approved');

    const executed = await dispatchCapability(db, registry, {
      correlationId: 'web-research-1',
      toolName: 'governed_research',
      arguments: { query: 'latest local AI news' },
      cwd: process.cwd(),
      actor: 'core',
      clientId: CLIENT,
    });
    expect(executed.outcome).toBe('executed');

    // 7. The web search really ran and the result carries the source.
    expect(fetched.length).toBeGreaterThan(0);
    const after = listCapabilityActions(db, { correlationId: 'web-research-1', clientId: CLIENT });
    expect(after.actions[0].actionable).toBe(false);
    expect(after.actions[0].outcome).toBe('succeeded');
  });
});
