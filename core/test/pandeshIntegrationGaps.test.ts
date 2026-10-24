/**
 * Pandesh's real integration gaps, closed and proved in one place.
 *
 * Three things were broken in a way no unit test could see:
 *
 *  1. The governed Core capabilities (Port Manager, System Management,
 *     Intelligence Scout, the browser/computer surface, Hermes skills) were
 *     registered but never offered to the live chat model — "check my
 *     setup" could not call anything.
 *  2. An Intelligence Scout watch was durable, but nothing ever fired it:
 *     only a manual `scout_run_all` ever checked a watch.
 *  3. Hermes had no skill discovery and no skill invocation at all.
 *
 * These tests cover exactly those three seams.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { EventBroadcaster } from '../ws/broadcaster';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createWorkspaceCapabilityAdapter } from '../runtime/governedCapability';
import { createPortManagementCapabilityAdapter } from '../runtime/portManagementCapability';
import { createSystemManagementCapabilityAdapter } from '../runtime/systemManagementCapability';
import { createIntelligenceScoutCapabilityAdapter } from '../runtime/intelligenceScoutCapability';
import { createIntelligenceScout } from '../runtime/intelligenceScout';
import { createBrowserCapabilityAdapter } from '../runtime/browserCapability';
import { createComputerUseCapabilityAdapter } from '../runtime/computerUseCapability';
import { createHermesSkillCapabilityAdapter } from '../runtime/hermesSkillCapability';
import { createWeatherCapabilityAdapter } from '../runtime/weatherCapability';
import { buildPiCapabilityBridge } from '../runtime/piCapabilityBridge';
import { startScheduledTaskLoop } from '../runtime/scheduler';
import { listMessages } from '../domain/conversations';
import { listScheduledTasks } from '../domain/scheduledTasks';
import { findScoutSchedule, listScoutSchedules } from '../domain/scoutRoutine';

let dir: string;
let db: CoreDatabase;
let dataDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-gap-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-gap-data-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function registry(scout = createIntelligenceScout({ dataDir })): GovernedCapabilityRegistry {
  return new GovernedCapabilityRegistry()
    .register(createWorkspaceCapabilityAdapter())
    .register(createPortManagementCapabilityAdapter({ dataDir }))
    .register(createSystemManagementCapabilityAdapter())
    .register(createWeatherCapabilityAdapter())
    .register(createIntelligenceScoutCapabilityAdapter({ dataDir, db, scout }))
    .register(createBrowserCapabilityAdapter({ browserBin: null }))
    .register(createComputerUseCapabilityAdapter({ dataDir }))
    .register(createHermesSkillCapabilityAdapter());
}

describe('the chat model can actually reach the governed capabilities', () => {
  it('offers the diagnostics, scout, computer and hermes tools, and nothing already owned', () => {
    const bridge = buildPiCapabilityBridge({
      db,
      registry: registry(),
      correlationId: 'conv-1',
      clientId: 'test-client',
      cwd: dir,
      actor: 'test',
    });
    const names = (bridge?.definitions ?? []).map((def) => def.name);
    expect(names).toContain('port_check_setup');
    expect(names).toContain('system_hardware_telemetry');
    expect(names).toContain('run_system_diagnostics');
    expect(names).toContain('system_list_models');
    expect(names).toContain('get_weather');
    expect(names).toContain('scout_add_watch');
    expect(names).toContain('inspect_page');
    expect(names).toContain('desktop_screenshot');
    expect(names).toContain('hermes_list_skills');
    expect(names).toContain('hermes_invoke_skill');
    // The workspace surface is already the chat agent's own tools.
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('run_command');
  });

  it('marks the read-only diagnostics read-only and the rest consequential', () => {
    const bridge = buildPiCapabilityBridge({
      db, registry: registry(), correlationId: 'c', clientId: 't', cwd: dir, actor: 'test',
    });
    const byName = new Map((bridge?.definitions ?? []).map((def) => [def.name, def.consequential]));
    expect(byName.get('port_check_setup')).toBe(false);
    expect(byName.get('system_hardware_telemetry')).toBe(false);
    expect(byName.get('run_system_diagnostics')).toBe(false);
    expect(byName.get('system_list_models')).toBe(false);
    expect(byName.get('get_weather')).toBe(false);
    expect(byName.get('hermes_list_skills')).toBe(false);
    expect(byName.get('hermes_invoke_skill')).toBe(true);
    expect(byName.get('scout_add_watch')).toBe(true);
  });

  it('dispatches a read-only diagnostic through the governed fabric and records the evidence', async () => {
    const bridge = buildPiCapabilityBridge({
      db, registry: registry(), correlationId: 'conv-diag', clientId: 'test-client', cwd: dir, actor: 'test',
    });
    const outcome = await bridge!.dispatch('port_check_setup', {});
    expect(outcome.outcome).toBe('executed');
    const invocation = (outcome as { toolInvocation: { status: string; evidence: Record<string, unknown> } }).toolInvocation;
    expect(invocation.status).toBe('succeeded');
    expect(String(invocation.evidence.output)).toContain('Managed services');
  });
});

describe('an Intelligence Scout watch fires on its own schedule', () => {
  function scoutWithVersion(tag: string) {
    return createIntelligenceScout({
      dataDir,
      fetchFn: vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ tag_name: tag, html_url: `https://example.com/${tag}`, published_at: '2026-10-20T00:00:00Z', body: 'notes' }),
        text: async () => '',
      })),
    });
  }

  it('a watch added through the capability becomes a durable scheduled task', async () => {
    const capability = createIntelligenceScoutCapabilityAdapter({ dataDir, db });
    const result = await capability.run(
      { name: 'scout_add_watch', arguments: { kind: 'github_repo', target: 'owner/repo', name: 'Repo' } },
      { cwd: dir },
    );
    expect(result.status).toBe('succeeded');
    expect(String(result.output)).toContain('scheduled daily at');

    const schedules = listScoutSchedules(db);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].task.routine).toBe('intelligence_scout');
    expect(schedules[0].task.enabled).toBe(true);
    expect(listScheduledTasks(db).some((task) => task.id === schedules[0].task.id)).toBe(true);
  });

  it('the scheduler fires the watch on its own and delivers the finding exactly once', async () => {
    const scout = scoutWithVersion('v1.0.0');
    const capability = createIntelligenceScoutCapabilityAdapter({ dataDir, db, scout });
    await capability.run({ name: 'scout_add_watch', arguments: { kind: 'github_repo', target: 'owner/repo' } }, { cwd: dir });

    const schedule = listScoutSchedules(db)[0].task;
    // Make it due right now, the way the scheduler's clock would.
    const dueAt = new Date(Date.now() - 1000).toISOString();
    db.run('UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?', [dueAt, schedule.id]);

    const broadcaster = new EventBroadcaster();
    const published: string[] = [];
    broadcaster.on('runtime_event', (event: { eventType: string }) => published.push(event.eventType));

    const stop = startScheduledTaskLoop(db, broadcaster, { execute: async () => undefined } as never, 60_000, { scout });
    try {
      // The loop's first tick runs after 5s; wait for the delivery.
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && !published.includes('scout_watch_baseline')) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      stop();
    }

    expect(published).toContain('scout_watch_baseline');
    const conversationId = listScoutSchedules(db)[0].task.conversationId!;
    expect(conversationId).toBeTruthy();
    const messages = listMessages(db, conversationId!);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(messages.find((m) => m.role === 'assistant')!.content).toContain('v1.0.0');

    // The schedule advanced: the same occurrence is not fired twice.
    const after = listScoutSchedules(db)[0].task;
    expect(new Date(after.nextRunAt).getTime()).toBeGreaterThan(new Date(dueAt).getTime());
  }, 30_000);

  it('a second occurrence with no change delivers nothing', async () => {
    const scout = scoutWithVersion('v1.0.0');
    const capability = createIntelligenceScoutCapabilityAdapter({ dataDir, db, scout });
    await capability.run({ name: 'scout_add_watch', arguments: { kind: 'github_repo', target: 'owner/repo' } }, { cwd: dir });
    const schedule = listScoutSchedules(db)[0].task;

    // Establish the baseline directly, then let the scheduler run once more.
    const watchId = scout.listWatches()[0].id;
    await scout.runWatch(watchId);
    db.run('UPDATE scheduled_tasks SET nextRunAt = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), schedule.id]);

    const broadcaster = new EventBroadcaster();
    const published: string[] = [];
    broadcaster.on('runtime_event', (event: { eventType: string }) => published.push(event.eventType));
    const stop = startScheduledTaskLoop(db, broadcaster, { execute: async () => undefined } as never, 60_000, { scout });
    try {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && !published.includes('scout_watch_unchanged')) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      stop();
    }
    expect(published).toContain('scout_watch_unchanged');
    expect(published).not.toContain('scout_watch_changed');
    const conversationId = listScoutSchedules(db)[0].task.conversationId!;
    expect(listMessages(db, conversationId!).filter((m) => m.role === 'assistant')).toHaveLength(0);
  }, 30_000);
});

describe('Hermes skills are discoverable and invocable', () => {
  it('lists the installed skills and says where the list came from', async () => {
    const capability = createHermesSkillCapabilityAdapter();
    const result = await capability.run({ name: 'hermes_list_skills', arguments: {} }, { cwd: dir });
    // On a host with no Hermes the result must be an honest failure, never a
    // fabricated skill list.
    if (result.status === 'succeeded') {
      expect(String(result.output)).toMatch(/source: (hermes-api|local-install)/);
    } else {
      expect(String(result.output)).toContain('No Hermes skills were found');
    }
  });

  it('refuses to invoke a skill that is not installed', async () => {
    const capability = createHermesSkillCapabilityAdapter();
    const result = await capability.run(
      { name: 'hermes_invoke_skill', arguments: { skill: 'definitely-not-installed-xyz', task: 'do a thing' } },
      { cwd: dir },
    );
    expect(result.status).toBe('failed');
    expect(String(result.output)).toMatch(/no installed skill|Hermes has no installed skill/);
  });

  it('requires a skill name and a task', async () => {
    const capability = createHermesSkillCapabilityAdapter();
    expect((await capability.run({ name: 'hermes_invoke_skill', arguments: { task: 'x' } }, { cwd: dir })).resultCategory)
      .toBe('invalid_arguments');
    expect((await capability.run({ name: 'hermes_invoke_skill', arguments: { skill: 'x' } }, { cwd: dir })).resultCategory)
      .toBe('invalid_arguments');
  });
});
