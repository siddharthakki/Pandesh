/**
 * The gear component's geometry: an extruded outline of simplified (trapezoid, not involute) teeth around the Y
 * axis, with an optional round bore. Pure numbers, so it can be checked without a GPU.
 *
 * Winding follows Babylon.js's left-handed convention, where a face's normal is (p1 − p2) × (p3 − p2): every face
 * points outwards (top +Y, bottom −Y, outer wall away from the axis, bore wall towards it). gearGeometry.test.ts
 * checks that with Babylon's own formula.
 */
export interface GearGeometry { positions: number[]; indices: number[]; tipRadius: number; rootRadius: number }

export function gearGeometry(teeth: number, radius: number, thickness: number, bore: number): GearGeometry {
  const module = (2 * radius) / teeth;
  const tip = radius + module;
  const root = Math.max(radius - 1.25 * module, bore > 0 ? bore + module * 0.6 : radius * 0.35);
  const pitch = (2 * Math.PI) / teeth;
  const outline: Array<[number, number]> = [];
  for (let i = 0; i < teeth; i += 1) {
    const c = i * pitch;
    outline.push([c - 0.3 * pitch, root], [c - 0.15 * pitch, tip], [c + 0.15 * pitch, tip], [c + 0.3 * pitch, root], [c + 0.5 * pitch, root]);
  }
  const n = outline.length;
  const h = thickness / 2;
  const positions: number[] = [];
  const indices: number[] = [];
  const add = (x: number, y: number, z: number) => { positions.push(x, y, z); return positions.length / 3 - 1; };
  const ring = (r: number | null, y: number) => outline.map(([a, rr]) => add(Math.cos(a) * (r ?? rr), y, Math.sin(a) * (r ?? rr)));
  // Each triangle is listed (a, c, b): the order that makes Babylon's left-handed normal point outwards.
  const tri = (a: number, b: number, c: number) => indices.push(a, c, b);
  const outerTop = ring(null, h);
  const outerBottom = ring(null, -h);
  if (bore > 0) {
    const innerTop = ring(bore, h);
    const innerBottom = ring(bore, -h);
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      tri(outerTop[i], innerTop[i], outerTop[j]); tri(outerTop[j], innerTop[i], innerTop[j]);
      tri(outerBottom[i], outerBottom[j], innerBottom[i]); tri(outerBottom[j], innerBottom[j], innerBottom[i]);
      tri(innerTop[i], innerBottom[i], innerTop[j]); tri(innerTop[j], innerBottom[i], innerBottom[j]);
    }
  } else {
    const top = add(0, h, 0);
    const bottom = add(0, -h, 0);
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      tri(top, outerTop[j], outerTop[i]);
      tri(bottom, outerBottom[i], outerBottom[j]);
    }
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    tri(outerTop[i], outerTop[j], outerBottom[i]); tri(outerTop[j], outerBottom[j], outerBottom[i]);
  }
  return { positions, indices, tipRadius: tip, rootRadius: root };
}

/** Babylon.js's face normal (left-handed): (p1 − p2) × (p3 − p2). */
export function babylonFaceNormal(positions: number[], a: number, b: number, c: number): [number, number, number] {
  const p = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const [p1, p2, p3] = [p(a), p(b), p(c)];
  const u = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const v = [p3[0] - p2[0], p3[1] - p2[1], p3[2] - p2[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
