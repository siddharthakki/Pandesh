/**
 * The Workshop as a governed capability: versions are Core artifacts, "it" is what the window shows (or the only
 * candidate — never a guess), view commands are DONE only when the window confirms, and consequential calls go
 * through the same Ask / Plan Only governance as every other tool.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { setConversationPermissionMode } from '../domain/permissionModes';
import { dispatchCapability } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createWorkshopCapabilityAdapter } from '../runtime/workshopCapability';
import {
  confirmWorkshopCommand, getWorkshop, listWorkshops, readWorkshopVersion, recordWorkshopFocus, resolveWorkshopTarget, writeWorkshopVersion,
} from '../domain/workshops';
import { verifyGlb } from '../shared/workshop/glb';
import type { RuntimeEventRecord } from '../shared/wireTypes';
import type { ToolExecutionResult } from '../runtime/toolRunner';

let dir: string;
let db: CoreDatabase;
let conversationId: string;
/** What the fake window does with each command; undefined = no window answers. */
let windowAnswer: ((action: string, metadata: Record<string, unknown>, commandId: string) => { ok: boolean; detail?: string; state?: Record<string, unknown> } | undefined) | undefined;
const seen: string[] = [];

const publish = (event: RuntimeEventRecord) => {
  if (event.eventType !== 'workshop_command_requested' || !windowAnswer) return;
  const m = event.metadata as Record<string, unknown>;
  seen.push(String(m.action));
  setTimeout(() => {
    const answer = windowAnswer?.(String(m.action), m, event.entityId);
    if (answer) confirmWorkshopCommand(db, { commandId: event.entityId, ok: answer.ok, detail: answer.detail ?? null, state: answer.state ?? null, actor: 'window' });
  }, 10);
};

const scene = {
  type: '3d',
  title: 'Gear assembly',
  components: [
    { id: 'base', name: 'Base plate', kind: 'box', params: { width: 160, height: 6, depth: 100 }, position: [0, -3, 0], material: 'aluminium' },
    { id: 'gear_a', name: 'Drive gear', kind: 'gear', params: { teeth: 24, radius: 30, thickness: 6, bore: 4 }, position: [-25, 4, 0], material: 'brass' },
    { id: 'gear_b', name: 'Driven gear', kind: 'gear', params: { teeth: 12, thickness: 6, bore: 3 }, meshWith: 'gear_a', material: 'brushed_steel' },
    { id: 'case', name: 'Outer case', kind: 'tube', params: { outerRadius: 90, innerRadius: 86, height: 20 }, position: [0, 10, 0], material: 'iron' },
  ],
};

let adapter: ReturnType<typeof createWorkshopCapabilityAdapter>;
const call = (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> =>
  adapter.run({ name, arguments: args }, { cwd: dir, correlationId: conversationId, attemptId: 'att_test' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-workshop-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
  windowAnswer = (action) => ({ ok: true, detail: `${action} done` });
  seen.length = 0;
  adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, publish, commandTimeoutMs: 1_500 });
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('creating and changing a 3D workshop', () => {
  it('creates version 1 as a verified artifact and reports that the window confirmed it is showing it', async () => {
    const r = await call('build_3d_model', scene);
    expect(r.status).toBe('succeeded');
    expect(r.output).toMatch(/^CREATED/);
    expect(r.output).toMatch(/window confirmed it is showing/);
    expect(seen).toEqual(['open']);
    const [w] = listWorkshops(db, { conversationId });
    expect(w.type).toBe('3d');
    expect(w.versions).toHaveLength(1);
    expect(r.activity).toMatchObject({ kind: 'workshop', artifactIds: [w.latestArtifactId], workshop: { workshopId: w.workshopId, type: '3d', action: 'create', version: 1 } });
    const { artifact, meta } = readWorkshopVersion(db, w.latestArtifactId);
    expect(artifact.availability).toBe('ready');
    expect(artifact.absolutePath.startsWith(path.join(dir, 'workshop', w.workshopId))).toBe(true);
    expect(meta.verification?.ok).toBe(true);
    expect(meta.engine).toMatchObject({ provider: 'local', costUsd: 0 });
  });

  it('refuses an invalid scene with the reasons and writes nothing', async () => {
    const r = await call('build_3d_model', { type: '3d', title: 'Bad', components: [{ name: 'x', kind: 'teapot' }] });
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/NOT CREATED[\s\S]*kind must be one of/);
    expect(listWorkshops(db, { conversationId })).toHaveLength(0);
  });

  it('edits only the named component of the workshop on screen, as a new version that keeps the old one', async () => {
    await call('build_3d_model', scene);
    const [w] = listWorkshops(db, { conversationId });
    recordWorkshopFocus(db, { conversationId, workshopId: w.workshopId, artifactId: w.latestArtifactId, open: true, actor: 'window' });
    const r = await call('workshop_edit', { edits: [{ op: 'set_material', target: 'the outer case', material: 'brushed steel' }], summary: 'Make the outer case brushed steel' });
    expect(r.status).toBe('succeeded');
    expect(r.output).toMatch(/CHANGED \(the workshop open in the window\): Outer case: material Iron .* → Brushed steel/);
    const after = getWorkshop(db, w.workshopId);
    expect(after.versions).toHaveLength(2);
    expect(after.versions[1].meta.parentArtifactId).toBe(after.versions[0].artifactId);
    const v1 = JSON.parse(readWorkshopVersion(db, after.versions[0].artifactId).bytes.toString('utf8'));
    const v2 = JSON.parse(readWorkshopVersion(db, after.versions[1].artifactId).bytes.toString('utf8'));
    for (const c of v1.components) {
      const next = v2.components.find((x: { id: string }) => x.id === c.id);
      if (c.id === 'case') expect(next.material.preset).toBe('brushed_steel');
      else expect(next).toEqual(c);
    }
  });

  it('asks instead of guessing when two workshops could be "it" and none is on screen', async () => {
    await call('build_3d_model', scene);
    await call('build_3d_model', { ...scene, title: 'Second assembly' });
    recordWorkshopFocus(db, { conversationId, workshopId: null, artifactId: null, open: false, actor: 'window' });
    const r = await call('workshop_edit', { edits: [{ op: 'set_color', target: 'Base plate', color: 'red' }] });
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/NOT CHANGED: this conversation has 2 workshops and none is open in the window[\s\S]*Ask the user which one/);
    expect(r.output).toMatch(/"Gear assembly"/);
    // Named explicitly, it is unambiguous.
    const named = await call('workshop_edit', { workshop: 'Second assembly', edits: [{ op: 'set_color', target: 'Base plate', color: 'red' }] });
    expect(named.status).toBe('succeeded');
    const target = resolveWorkshopTarget(db, { conversationId, named: 'Second' });
    expect(target.ok && target.workshop.versions).toHaveLength(2);
  });

  it('refuses an ambiguous component name with the candidates', async () => {
    await call('build_3d_model', scene);
    const r = await call('workshop_edit', { edits: [{ op: 'set_material', target: 'gear', material: 'gold' }] });
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/matches more than one component[\s\S]*Drive gear, Driven gear/);
  });

  it('undo makes the previous version current again as a byte-identical new version', async () => {
    await call('build_3d_model', scene);
    await call('workshop_edit', { edits: [{ op: 'remove', target: 'Outer case' }] });
    const r = await call('workshop_restore', { version: 'previous' });
    expect(r.status).toBe('succeeded');
    const w = listWorkshops(db, { conversationId })[0];
    expect(w.versions).toHaveLength(3);
    expect(readWorkshopVersion(db, w.versions[2].artifactId).artifact.sha256).toBe(readWorkshopVersion(db, w.versions[0].artifactId).artifact.sha256);
    expect(w.versions[2].meta.op.kind).toBe('restore');
  });
});

describe('building from a plain description (the local model fills a schema; Core checks every number)', () => {
  const seedRequest = (provider: string, model: string) => submitRequest(db, {
    clientId: 'desktop', currentMessage: 'Build a simple mechanical gear assembly.', requestedMode: 'baat_kar', conversationId, workspaceRoot: dir,
    requestedProvider: provider, requestedModel: model, selectedModel: model, toolPermissionPolicy: { profile: 'confirm-mutations' }, capability: { hasWorkspace: false, gitCapable: false },
    correlationId: `c-${Math.random()}`,
  });

  it('designs with the chat\'s own local model, keeps only buildable parts, and records which model designed it', async () => {
    seedRequest('ollama', 'gemma4:12b');
    const asked: string[] = [];
    adapter = createWorkshopCapabilityAdapter({
      db, dataDir: dir, publish, commandTimeoutMs: 1_500,
      designer: async (description, opts) => {
        asked.push(`${opts.model}:${description}`);
        opts.onStage?.('Designing the parts');
        const v = (await import('../shared/workshop/scene3d')).validateGeneratedScene({ title: 'Gear pair', components: [...scene.components, { name: 'Teapot', kind: 'teapot', params: {} }, { name: 'Odd box', kind: 'box', params: { width: 10, height: 10, depth: 10, radius: 5 }, position: [0, 0, 0], material: 'rubber' }] });
        return v.ok ? { ok: true, scene: v.value, warnings: v.warnings, attempts: 1, ms: 5, model: opts.model } : { ok: false, error: v.errors.join(';'), attempts: 1, ms: 5, model: opts.model };
      },
    });
    const r = await call('build_3d_model', { description: 'a simple mechanical gear assembly' });
    expect(r.status).toBe('succeeded');
    expect(asked).toEqual(['gemma4:12b:a simple mechanical gear assembly']);
    const w = listWorkshops(db, { conversationId })[0];
    const meta = w.versions[0].meta;
    expect(meta.engine).toMatchObject({ model: 'gemma4:12b', provider: 'local' });
    const stored = JSON.parse(readWorkshopVersion(db, w.latestArtifactId).bytes.toString('utf8'));
    expect(stored.components.map((c: { name: string }) => c.name)).toEqual(['Base plate', 'Drive gear', 'Driven gear', 'Outer case', 'Odd box']);
    expect(meta.notes?.join(' ')).toMatch(/left out "Teapot"/);
    const progress = db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'workshop_progress'").map((e) => JSON.parse(e.metadata).stage);
    expect(progress).toEqual(['Designing the parts', 'Saving version 1 (5 parts)']);
  });

  it('never uses a cloud model: without a local model for the chat it refuses and sends nothing', async () => {
    seedRequest('openrouter', 'provider::some-cloud-model');
    let called = false;
    adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, publish, designer: async () => { called = true; throw new Error('must not run'); } });
    const r = await call('build_3d_model', { description: 'a watch' });
    expect(r.status).toBe('failed');
    expect(r.output).toMatch(/needs a local \(Ollama\) model/);
    expect(called).toBe(false);
  });
});

describe('view commands are reported only when the window confirms them', () => {
  it('DONE with the state the window reported', async () => {
    await call('build_3d_model', scene);
    windowAnswer = (action) => ({ ok: true, detail: 'exploded view: 4 components moved apart', state: { exploded: 1, action } });
    const r = await call('workshop_view', { action: 'explode' });
    expect(r.status).toBe('succeeded');
    expect(r.output).toMatch(/^DONE: explode .* confirmed it\. exploded view: 4 components moved apart/);
    expect(r.output).toMatch(/"exploded":1/);
  });

  it('NOT CONFIRMED when no window answers, and NOT DONE when the window refuses', async () => {
    await call('build_3d_model', scene);
    adapter = createWorkshopCapabilityAdapter({ db, dataDir: dir, publish, commandTimeoutMs: 300 });
    windowAnswer = undefined;
    const silent = await call('workshop_view', { action: 'rotate' });
    expect(silent.status).toBe('failed');
    expect(silent.output).toMatch(/^NOT CONFIRMED/);
    windowAnswer = () => ({ ok: false, detail: 'the window is showing a different conversation' });
    const refused = await call('workshop_view', { action: 'labels_on' });
    expect(refused.output).toMatch(/^NOT DONE: .*different conversation/);
    expect((await call('workshop_view', { action: 'dance' })).output).toMatch(/unknown action/);
  });

  it('export: EXPORTED only after Core finds a verified GLB of the current version', async () => {
    await call('build_3d_model', scene);
    const w = listWorkshops(db, { conversationId })[0];
    const glb = (await import('./workshopGlbFixture')).fixtureGlb();
    windowAnswer = (action) => {
      if (action !== 'export') return { ok: true };
      const check = verifyGlb(glb);
      const { artifact } = writeWorkshopVersion(db, {
        dataDir: dir, conversationId, type: '3d', workshopId: w.workshopId, parentArtifactId: w.latestArtifactId, title: 'Gear assembly (GLB)',
        bytes: Buffer.from(glb), extension: 'glb', mimeType: 'model/gltf-binary', kind: 'file', op: { kind: 'export', summary: 'GLB export' },
        engine: { tool: 'workshop_export', engine: 'test', model: null, provider: 'local', costUsd: 0 }, verification: { ok: check.ok, checks: check.checks }, exportOf: w.latestArtifactId, actor: 'window',
      });
      return { ok: true, state: { exportArtifactId: artifact.id } };
    };
    const r = await call('workshop_export', { format: 'glb' });
    expect(r.status).toBe('succeeded');
    expect(r.output).toMatch(/^EXPORTED and verified by Core: .*\.glb/);
    expect(getWorkshop(db, w.workshopId).exports).toHaveLength(1);
    expect(getWorkshop(db, w.workshopId).versions).toHaveLength(1);
  });
});

describe('governance: Ask and Plan Only apply to the Workshop like every other tool', () => {
  const registry = () => new GovernedCapabilityRegistry().register(createWorkshopCapabilityAdapter({ db, dataDir: dir, publish, commandTimeoutMs: 300 }));
  const submit = () => submitRequest(db, {
    clientId: 'desktop', currentMessage: 'build it', requestedMode: 'saath_kar', conversationId, workspaceRoot: dir,
    requestedProvider: 'ollama', selectedModel: 'm', toolPermissionPolicy: { profile: 'confirm-mutations' }, capability: { hasWorkspace: false, gitCapable: false },
    correlationId: `c-${Math.random()}`,
  }).attempt.id;

  it('classifies view and status as read-only and every write as consequential', () => {
    const a = createWorkshopCapabilityAdapter({ db, dataDir: dir });
    expect(['workshop_status', 'workshop_view'].map((t) => a.classify(t))).toEqual(['read_only', 'read_only']);
    expect(['build_3d_model', 'workshop_edit', 'workshop_restore', 'workshop_export'].map((t) => a.classify(t))).toEqual(['consequential', 'consequential', 'consequential', 'consequential']);
  });

  it('Ask: creating a workshop waits for the person\'s approval and writes nothing before it', async () => {
    const attemptId = submit();
    const r = await dispatchCapability(db, registry(), { correlationId: conversationId, permissionScope: attemptId, toolName: 'build_3d_model', arguments: scene, cwd: dir, actor: 'model', clientId: 'test' });
    expect(r.outcome).toBe('approval_required');
    expect(listWorkshops(db, { conversationId })).toHaveLength(0);
    // The card shows what will be built in words, bound to the exact data by digest.
    const summary = (r as { approval: { summary: Record<string, unknown> } }).approval.summary;
    expect(String((summary.arguments as Record<string, unknown>).components)).toMatch(/4 component\(s\): Base plate \(box, aluminium\)/);
    expect((summary.arguments as Record<string, unknown>).componentsSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('Plan Only: a create is refused and nothing is written; a view command is still allowed', async () => {
    setConversationPermissionMode(db, conversationId, 'plan', 'desktop');
    const attemptId = submit();
    const created = await dispatchCapability(db, registry(), { correlationId: conversationId, permissionScope: attemptId, toolName: 'build_3d_model', arguments: scene, cwd: dir, actor: 'model', clientId: 'test' });
    expect(created.outcome).toBe('denied');
    expect(listWorkshops(db, { conversationId })).toHaveLength(0);
    writeWorkshopVersion(db, {
      dataDir: dir, conversationId, type: '3d', title: 'Existing', bytes: Buffer.from(JSON.stringify({ format: 'pandesh.scene', version: 1, title: 'Existing', units: 'mm', components: [{ id: 'a', name: 'A', kind: 'box', params: { width: 1, height: 1, depth: 1 }, position: [0, 0, 0], rotation: [0, 0, 0], material: { preset: 'plastic', color: '#e8e8e8', metalness: 0, roughness: 0.45, opacity: 1 }, group: null, label: null, explode: null, note: null }], notes: [] })),
      extension: 'json', mimeType: 'application/vnd.pandesh.scene+json', kind: 'document', op: { kind: 'create', summary: 'seed' },
      engine: { tool: 'test', provider: 'local', costUsd: 0 }, actor: 'test',
    });
    const viewed = await dispatchCapability(db, registry(), { correlationId: conversationId, permissionScope: attemptId, toolName: 'workshop_view', arguments: { action: 'rotate' }, cwd: dir, actor: 'model', clientId: 'test' });
    expect(viewed.outcome).toBe('executed');
  });
});
