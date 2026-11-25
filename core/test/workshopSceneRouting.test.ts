import { describe, expect, it } from 'vitest';
import { localSceneWriter } from '../runtime/workshopSceneWriter';
import { composeScenePage, isScenePage, parseScenePage, withSceneRuntime } from '../shared/workshop/scenePage';
import type { ModelSnapshot } from '../runtime/modelAwareness';

const model = (name: string, paramsB: number, extra: Partial<ModelSnapshot['models'][number]> = {}): ModelSnapshot['models'][number] => ({
  name, paramsB, capabilities: [], canSee: false, canUseTools: true, isEmbedding: false, loaded: false, selected: false, fitsGpu: true, autoEligible: true, ...extra,
});
const snapshot = (models: ModelSnapshot['models'], available = true): ModelSnapshot => ({ at: '2026-11-23T00:00:00Z', available, gpu: null, selected: null, selectedKind: 'local', models });

describe('who writes a 3D scene', () => {
  it('is the largest local coding model, even when it does not fit graphics memory at the chat context', () => {
    const snap = snapshot([
      model('gemma4:26b-a4b-it-qat', 25.2, { selected: true, loaded: true, canSee: true }),
      model('qwen2.5-coder:3b', 3.1),
      model('qwen3-coder:swift-27b', 27.3, { fitsGpu: false }),
      model('nomic-embed-text:latest', 0.1, { isEmbedding: true, autoEligible: false }),
    ]);
    expect(localSceneWriter(snap)).toBe('qwen3-coder:swift-27b');
  });

  it('is nobody when there is no coding model of a useful size, or the model server is away (the chat model then writes)', () => {
    expect(localSceneWriter(snapshot([model('gemma4:26b-a4b-it-qat', 25.2), model('qwen2.5-coder:3b', 3.1)]))).toBeNull();
    expect(localSceneWriter(snapshot([model('qwen3-coder:swift-27b', 27.3)], false))).toBeNull();
    expect(localSceneWriter(snapshot([model('some-coder-heretic:30b', 30, { autoEligible: false })]))).toBeNull();
  });
});

describe('the scene page', () => {
  it('keeps the runtime intact when it is inlined: "$&" and "$\'" in three.js are not replacement patterns', () => {
    const page = composeScenePage({ title: 'T', description: 'd', code: 'kit.add(kit.box(1, 1, 1, "#fff"), "Box");' });
    const runtime = 'var a = "$&"; var b = "$\'"; var c = "$`"; precision mediump float;';
    const served = withSceneRuntime(page, runtime, 'nonce-1');
    expect(served).toContain(runtime);
    expect(served).toContain('window.__PANDESH_SCENE_NONCE="nonce-1"');
    expect(isScenePage(page)).toBe(true);
    expect(parseScenePage(page)?.code).toBe('kit.add(kit.box(1, 1, 1, "#fff"), "Box");');
  });
});
