import { describe, expect, it } from 'vitest';
import { glbNodeNames, verifyGlb } from '../shared/workshop/glb';
import { fixtureGlb as makeGlb } from './workshopGlbFixture';


describe('Core\'s own GLB check', () => {
  it('accepts a well-formed GLB and reports what is inside', () => {
    const r = verifyGlb(makeGlb());
    expect(r.ok).toBe(true);
    expect(r.meshes).toBe(1);
    expect(r.triangles).toBe(1);
    expect(r.checks.every((c) => c.startsWith('PASS'))).toBe(true);
    expect(glbNodeNames(makeGlb())).toEqual(['Drive gear']);
  });

  it('refuses a wrong magic, a wrong length, an accessor past its buffer, and a file without meshes', () => {
    expect(verifyGlb(makeGlb({ magic: 0x12345678 })).ok).toBe(false);
    expect(verifyGlb(makeGlb({ lengthDelta: 4 })).ok).toBe(false);
    const overflow = verifyGlb(makeGlb({ accessorCount: 99 }));
    expect(overflow.ok).toBe(false);
    expect(overflow.checks.join(' ')).toMatch(/accessor 0 needs/);
    expect(verifyGlb(makeGlb({ meshes: false })).ok).toBe(false);
    expect(verifyGlb(new Uint8Array(10)).ok).toBe(false);
  });
});
