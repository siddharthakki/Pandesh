/**
 * Phase 2c — Tools, Skills & MCP hub. A read-only projection of registries
 * that already exist; nothing new is registered or executed here except the
 * existing capability-inventory probe (which only checks, never changes).
 *
 * - Governed capabilities: GovernedCapabilityRegistry (definitions, risk,
 *   health).
 * - Native chat-engine tools: the selection map in chatToolSelection.ts.
 * - Agent × tool mapping: computed with the Phase 2b scope rules, so the hub
 *   shows exactly what Core would allow — not a second permission table.
 * - Skills: the built-in skill manifests.
 * - MCP: Core has no MCP server registry yet; reported as such.
 * - Evidence: real tool_invocations per tool, and capability-test runs (the
 *   capability inventory probe) with a durable history.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiContext, ApiResult } from './context';
import type { Router } from './router';
import { CoreError } from '../domain/errors';
import type { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { BASE_TOOLS, NATIVE_GROUP } from '../runtime/chatToolSelection';
import { ALWAYS_ALLOWED, deriveScope, isToolAllowed, listAgentDefinitions } from '../domain/agents';
import { BUILTIN_SKILLS } from '../platform/skills/builtinSkills';
import { probeCapabilityInventory, type InventoryProbeDeps } from '../runtime/capabilityInventory';

function requireHost(ctx: ApiContext): void {
  const p = ctx.principal;
  if (!(p?.isTrustedHost && p.source === 'host_transport' && !p.isModelOrTool)) throw new CoreError('forbidden', 'only the Pandesh app can do this');
}
const ok = (body: unknown): ApiResult => ({ status: 200, body });

export interface ToolHubOptions { registry: GovernedCapabilityRegistry; connectors: InventoryProbeDeps['connectors']; dataDir: string | null }

interface TestRun { at: string; working: number; unverified: number; unreachable: number; missing: number; notConnected: number; durationMs: number }

function historyPath(dataDir: string | null): string | null { return dataDir ? path.join(dataDir, 'capability-test-history.json') : null; }
function readHistory(dataDir: string | null): TestRun[] {
  const p = historyPath(dataDir);
  try { return p ? JSON.parse(fs.readFileSync(p, 'utf8')) as TestRun[] : []; } catch { return []; }
}

export function registerToolHubRoutes(router: Router<ApiContext, ApiResult>, options: ToolHubOptions): void {
  router.get('/v1/tools/hub', (ctx) => {
    requireHost(ctx);
    const health = options.registry.healthSnapshot();
    const governed = options.registry.definitions().map((d) => {
      const c = options.registry.classify(d.name);
      return { name: d.name, description: String(d.description ?? '').split(/\n|\. /)[0].slice(0, 200), capabilityId: c?.capabilityId ?? 'unknown', risk: c?.risk ?? 'unknown', executor: 'governed' as const };
    });
    const governedNames = new Set(governed.map((t) => t.name));
    const native = [...new Set([...BASE_TOOLS, ...Object.keys(NATIVE_GROUP)])].filter((n) => !governedNames.has(n)).sort()
      .map((name) => ({ name, description: '', capabilityId: 'chat_engine', risk: /^(write_|create_|update_|dismiss_|cancel_|schedule_|print_|send_|delegate_|dev_stor|record_|advance_|build_|wish_order|run_checks)/.test(name) ? 'consequential' : 'read_only', executor: 'native' as const, group: NATIVE_GROUP[name] ?? 'base' }));
    const tools = [...governed, ...native];

    const capabilities = Object.entries(health).map(([id, h]) => ({ id, health: h, tools: governed.filter((t) => t.capabilityId === id).map((t) => t.name) }));

    const agents = listAgentDefinitions(ctx.db).map((a) => {
      const scope = deriveScope(a, null);
      return { id: a.id, name: a.name, enabled: a.enabled, availability: a.availability, allowed: tools.map((t) => t.name).filter((n) => !ALWAYS_ALLOWED.has(n) && isToolAllowed(scope, n).allowed) };
    });

    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const usage = ctx.db.all<{ toolName: string; status: string; n: number; last: string }>(
      'SELECT toolName, status, COUNT(*) AS n, MAX(startedAt) AS last FROM tool_invocations WHERE startedAt >= ? GROUP BY toolName, status', [since]);
    const usageByTool: Record<string, { total: number; byStatus: Record<string, number>; last: string }> = {};
    for (const u of usage) {
      const e = usageByTool[u.toolName] ??= { total: 0, byStatus: {}, last: u.last };
      e.total += u.n; e.byStatus[u.status] = u.n; if (u.last > e.last) e.last = u.last;
    }

    return ok({
      generatedAt: new Date().toISOString(),
      tools: tools.map((t) => ({ ...t, usage: usageByTool[t.name] ?? null })),
      capabilities,
      agents,
      skills: BUILTIN_SKILLS.map((s) => ({ id: s.id, name: s.name, description: s.description, kind: s.kind, source: s.source, trust: s.trust, version: s.version, requires: s.requires })),
      mcp: { servers: [], note: 'No MCP servers are registered with Core. A Core-side MCP registry is not part of this build; nothing is connected.' },
      testHistory: readHistory(options.dataDir),
    });
  });

  /** Runs the existing capability-inventory probe now (checks only) and records the outcome. */
  router.post('/v1/tools/test', async (ctx) => {
    requireHost(ctx);
    const t0 = Date.now();
    const inv = await probeCapabilityInventory({ db: ctx.db, connectors: options.connectors, probeWeb: false }, { refresh: true });
    const count = (s: string) => inv.items.filter((i) => i.status === s).length;
    const run: TestRun = { at: new Date().toISOString(), working: count('working'), unverified: count('installed_unverified'), unreachable: count('unreachable'), missing: count('missing'), notConnected: count('not_connected'), durationMs: Date.now() - t0 };
    const p = historyPath(options.dataDir);
    if (p) { try { fs.writeFileSync(p, JSON.stringify([run, ...readHistory(options.dataDir)].slice(0, 30))); } catch { /* history is a convenience */ } }
    return ok({ run, items: inv.items });
  });
}
