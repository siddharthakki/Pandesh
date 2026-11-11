import { describe, expect, it } from 'vitest';
import {
  applySceneEdits, diffScenes, explodeOffsets, explodedPosition, gearModule, materialPresetFromText, parseMaterial,
  parseSceneFile, resolveComponents, validateScene, type Scene3D,
} from '../shared/workshop/scene3d';
import { babylonFaceNormal, gearGeometry } from '../../apps/desktop/renderer-v2/src/workshop/engine3d/gearGeometry';

const gearPair = () => ({
  title: 'Gear pair',
  components: [
    { id: 'base', name: 'Base plate', kind: 'box', params: { width: 160, height: 6, depth: 100 }, position: [0, -3, 0], material: 'aluminium' },
    { id: 'gear_a', name: 'Drive gear', kind: 'gear', params: { teeth: 24, radius: 30, thickness: 6, bore: 4 }, position: [-25, 4, 0], material: 'brass' },
    { id: 'gear_b', name: 'Driven gear', kind: 'gear', params: { teeth: 12, thickness: 6, bore: 3 }, meshWith: 'gear_a', angle: 0, material: 'brushed steel' },
    { id: 'case', name: 'Outer case', kind: 'tube', params: { outerRadius: 90, innerRadius: 86, height: 20 }, position: [0, 10, 0], material: 'iron', group: 'Housing' },
    { id: 'case_back', name: 'Case back', kind: 'cylinder', params: { radius: 88, height: 2 }, position: [0, -1, 0], material: 'iron', group: 'Housing' },
  ],
});

function valid(raw: unknown): Scene3D {
  const v = validateScene(raw);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.value;
}

describe('3D scene validation (structured data only, never code)', () => {
  it('accepts the catalog shapes, normalizes materials and refuses unknown fields and kinds', () => {
    const scene = valid(gearPair());
    expect(scene.components).toHaveLength(5);
    expect(scene.components.find((c) => c.id === 'gear_b')!.material.preset).toBe('brushed_steel');
    expect(scene.notes.join(' ')).toMatch(/simplified trapezoid profile/);

    const bad = validateScene({ title: 'x', components: [{ name: 'evil', kind: 'script', params: {} }, { name: 'b', kind: 'box', onLoad: 'fetch()' }], script: 'alert(1)' });
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: string[] }).errors.join(' | ');
    expect(errors).toMatch(/'script' is not a scene field/);
    expect(errors).toMatch(/kind must be one of/);
    expect(errors).toMatch(/'onLoad' is not a component field/);
  });

  it('bounds every number and the component count', () => {
    expect(validateScene({ title: 't', components: [{ name: 'huge', kind: 'box', params: { width: 1e9, height: 1, depth: 1 } }] }).ok).toBe(false);
    expect(validateScene({ title: 't', components: [{ name: 'nan', kind: 'sphere', params: { radius: 'abc' } }] }).ok).toBe(false);
    expect(validateScene({ title: 't', components: [{ name: 'far', kind: 'sphere', position: [1e7, 0, 0] }] }).ok).toBe(false);
    expect(validateScene({ title: 't', components: Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, kind: 'box' })) }).ok).toBe(false);
    expect(validateScene({ title: 't', components: [{ name: 'ring', kind: 'tube', params: { outerRadius: 5, innerRadius: 6, height: 1 } }] }).ok).toBe(false);
  });

  it('places a gear that meshes with another so the pitch circles touch, with the same module', () => {
    const scene = valid(gearPair());
    const a = scene.components.find((c) => c.id === 'gear_a')!;
    const b = scene.components.find((c) => c.id === 'gear_b')!;
    expect(gearModule(b)).toBeCloseTo(gearModule(a), 6);
    expect(b.params.radius).toBeCloseTo(15, 6);
    const distance = Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]);
    expect(distance).toBeCloseTo(a.params.radius + b.params.radius, 3);
    expect(b.position[1]).toBe(a.position[1]);
  });

  it('warns honestly when two meshing gears have different tooth sizes', () => {
    const raw = gearPair();
    (raw.components[2].params as Record<string, number>).radius = 20;
    const v = validateScene(raw);
    expect(v.ok).toBe(true);
    expect((v as { warnings: string[] }).warnings.join(' ')).toMatch(/would not mesh/);
  });

  it('re-validates a stored file and refuses anything that is not a Pandesh scene', () => {
    const scene = valid(gearPair());
    const back = parseSceneFile(JSON.stringify(scene));
    expect(back.ok && back.value.components.map((c) => c.id)).toEqual(scene.components.map((c) => c.id));
    expect(parseSceneFile('{"format":"other"}').ok).toBe(false);
    expect(parseSceneFile('not json').ok).toBe(false);
  });
});

describe('targeting components', () => {
  const scene = valid(gearPair());
  it('resolves ids, names and plain words; an ambiguous word is refused with the candidates', () => {
    const one = (t: string) => { const r = resolveComponents(scene, t); return r.ok ? r.components.map((c) => c.id) : r.error; };
    expect(one('gear_a')).toEqual(['gear_a']);
    expect(one('the outer case')).toEqual(['case']);
    expect(one('Driven gear')).toEqual(['gear_b']);
    expect(one('kind:gear')).toEqual(['gear_a', 'gear_b']);
    expect(one('group:Housing')).toEqual(['case', 'case_back']);
    const ambiguous = resolveComponents(scene, 'gear');
    expect(ambiguous.ok).toBe(false);
    expect((ambiguous as { candidates: string[] }).candidates).toEqual(['Drive gear', 'Driven gear']);
    expect(resolveComponents(scene, 'flux capacitor').ok).toBe(false);
  });
});

describe('component-level edits', () => {
  it('changes only the named component; every other component is carried over unchanged', () => {
    const scene = valid(gearPair());
    const r = applySceneEdits(scene, [{ op: 'set_material', target: 'the outer case', material: 'brushed steel' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = r.scene.components.find((c) => c.id === 'case')!;
    expect(after.material.preset).toBe('brushed_steel');
    expect(r.changes).toEqual([expect.objectContaining({ componentId: 'case', field: 'material' })]);
    for (const c of scene.components.filter((x) => x.id !== 'case')) expect(r.scene.components.find((x) => x.id === c.id)).toEqual(c);
    // The input scene itself is never mutated.
    expect(scene.components.find((c) => c.id === 'case')!.material.preset).toBe('iron');
  });

  it('fails the whole change on any bad edit, and never guesses an ambiguous target', () => {
    const scene = valid(gearPair());
    const r = applySceneEdits(scene, [{ op: 'set_color', target: 'Drive gear', color: 'blue' }, { op: 'set_material', target: 'gear', material: 'gold' }]);
    expect(r.ok).toBe(false);
    expect((r as { candidates?: string[] }).candidates).toEqual(['Drive gear', 'Driven gear']);
    expect(applySceneEdits(scene, [{ op: 'explode_everything', target: 'x' }]).ok).toBe(false);
    expect(applySceneEdits(scene, []).ok).toBe(false);
  });

  it('a colour on a metal keeps the metal finish; a colour on plastic is paint', () => {
    expect(materialPresetFromText('Brushed-Steel')).toBe('brushed_steel');
    expect(materialPresetFromText('stainless')).toBe('brushed_steel');
    const metal = parseMaterial('brass');
    expect(metal.ok).toBe(true);
    const blueBrass = parseMaterial('blue', (metal as { material: never }).material);
    expect(blueBrass.ok && blueBrass.material.metalness).toBe(1);
    const bluePaint = parseMaterial('blue');
    expect(bluePaint.ok && bluePaint.material.preset).toBe('painted');
    expect(parseMaterial('unobtainium').ok).toBe(false);
  });

  it('describes the difference between two versions', () => {
    const a = valid(gearPair());
    const r = applySceneEdits(a, [{ op: 'set_material', target: 'case', material: 'gold' }, { op: 'remove', target: 'Case back' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fields = diffScenes(a, r.scene).map((c) => `${c.componentId}:${c.field}`);
    expect(fields).toEqual(['case:material', 'case_back:removed']);
  });
});

describe('exploded view', () => {
  it('moves parts apart and puts every part back exactly where it was stored', () => {
    const scene = valid(gearPair());
    const offsets = explodeOffsets(scene);
    let moved = 0;
    for (const c of scene.components) {
      expect(explodedPosition(scene, c, 0, offsets)).toEqual(c.position);
      const out = explodedPosition(scene, c, 1, offsets);
      if (out.some((v, i) => Math.abs(v - c.position[i]) > 1)) moved += 1;
    }
    // The middle of a stack stays where it is; everything else moves.
    expect(moved).toBeGreaterThanOrEqual(scene.components.length - 1);
  });

  it('separates stacked layers in their stacking order', () => {
    const watch = valid({
      title: 'Watch layers',
      components: [
        { id: 'back', name: 'Case back', kind: 'cylinder', params: { radius: 20, height: 1 }, position: [0, -2, 0] },
        { id: 'movement', name: 'Movement', kind: 'cylinder', params: { radius: 18, height: 3 }, position: [0, 0, 0] },
        { id: 'dial', name: 'Dial', kind: 'cylinder', params: { radius: 18, height: 0.5 }, position: [0, 2, 0] },
        { id: 'crystal', name: 'Crystal', kind: 'cylinder', params: { radius: 19, height: 1 }, position: [0, 4, 0], material: 'sapphire' },
      ],
    });
    const ys = watch.components.map((c) => explodedPosition(watch, c, 1)[1]);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThan(watch.components[i].position[1] - watch.components[i - 1].position[1]);
  });
});

describe('gear geometry (Babylon.js left-handed faces)', () => {
  it('every face points outwards: top +Y, bottom −Y, rim away from the axis, bore towards it', () => {
    for (const bore of [0, 4]) {
      const g = gearGeometry(16, 20, 6, bore);
      let top = 0; let bottom = 0; let out = 0; let inward = 0;
      for (let i = 0; i < g.indices.length; i += 3) {
        const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
        const n = babylonFaceNormal(g.positions, a, b, c);
        const cy = (g.positions[a * 3 + 1] + g.positions[b * 3 + 1] + g.positions[c * 3 + 1]) / 3;
        const cx = (g.positions[a * 3] + g.positions[b * 3] + g.positions[c * 3]) / 3;
        const cz = (g.positions[a * 3 + 2] + g.positions[b * 3 + 2] + g.positions[c * 3 + 2]) / 3;
        if (Math.abs(n[1]) > 1e-9 && Math.abs(n[0]) + Math.abs(n[2]) < 1e-6) {
          if (cy > 0) { expect(n[1]).toBeGreaterThan(0); top += 1; } else { expect(n[1]).toBeLessThan(0); bottom += 1; }
        } else {
          const radial = n[0] * cx + n[2] * cz;
          const r = Math.hypot(cx, cz);
          if (bore > 0 && r < bore + 0.01) { expect(radial).toBeLessThan(0); inward += 1; } else { expect(radial).toBeGreaterThan(0); out += 1; }
        }
      }
      expect(top).toBeGreaterThan(0);
      expect(bottom).toBe(top);
      expect(out).toBeGreaterThan(0);
      if (bore > 0) expect(inward).toBeGreaterThan(0);
    }
  });
});
