/** A minimal, real GLB for tests: one triangle mesh in one node named "Drive gear". */
export function fixtureGlb(opts: { magic?: number; lengthDelta?: number; accessorCount?: number; meshes?: boolean } = {}): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = new Uint8Array(positions.buffer);
  const gltf = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Drive gear', mesh: 0 }],
    meshes: opts.meshes === false ? [] : [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: opts.accessorCount ?? 3, type: 'VEC3' }],
  };
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const pad = (4 - (json.length % 4)) % 4;
  json = new Uint8Array([...json, ...new Array(pad).fill(0x20)]);
  const total = 12 + 8 + json.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, opts.magic ?? 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total + (opts.lengthDelta ?? 0), true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  v.setUint32(20 + json.length, bin.length, true);
  v.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}
