/**
 * Independent check of a binary glTF (GLB) file: the header, both chunks, the JSON, and that every accessor and
 * buffer view fits inside the binary chunk. Core runs this on every Workshop export before it calls the export
 * verified; the window's own "export finished" is never taken as proof.
 */

export interface GlbCheck {
  ok: boolean;
  checks: string[];
  meshes: number;
  nodes: number;
  materials: number;
  triangles: number | null;
  generator: string | null;
}

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function verifyGlb(bytes: Uint8Array): GlbCheck {
  const checks: string[] = [];
  const fail = (text: string): GlbCheck => ({ ok: false, checks: [...checks, `FAIL ${text}`], meshes: 0, nodes: 0, materials: 0, triangles: null, generator: null });
  if (bytes.byteLength < 20) return fail('file is shorter than a GLB header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return fail('magic is not "glTF"');
  const version = view.getUint32(4, true);
  if (version !== 2) return fail(`glTF container version ${version}, expected 2`);
  const length = view.getUint32(8, true);
  if (length !== bytes.byteLength) return fail(`header length ${length} does not match file size ${bytes.byteLength}`);
  checks.push(`PASS GLB header: glTF v2, ${length} bytes`);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) return fail('first chunk is not JSON');
  if (20 + jsonLength > length) return fail('JSON chunk runs past the end of the file');
  let gltf: Record<string, unknown>;
  try {
    gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
  } catch {
    return fail('JSON chunk does not parse');
  }
  const asset = (gltf.asset ?? {}) as Record<string, unknown>;
  if (asset.version !== '2.0') return fail(`asset.version is ${String(asset.version)}, expected 2.0`);
  checks.push('PASS JSON chunk parses; asset.version 2.0');
  let binLength = 0;
  const binStart = 20 + jsonLength;
  if (binStart + 8 <= length) {
    binLength = view.getUint32(binStart, true);
    if (view.getUint32(binStart + 4, true) !== CHUNK_BIN) return fail('second chunk is not BIN');
    if (binStart + 8 + binLength > length) return fail('BIN chunk runs past the end of the file');
    checks.push(`PASS BIN chunk: ${binLength} bytes`);
  }
  const arr = (key: string) => (Array.isArray(gltf[key]) ? (gltf[key] as Array<Record<string, unknown>>) : []);
  const bufferViews = arr('bufferViews');
  for (const [i, bv] of bufferViews.entries()) {
    const end = Number(bv.byteOffset ?? 0) + Number(bv.byteLength ?? 0);
    if ((bv.buffer ?? 0) === 0 && end > binLength) return fail(`bufferView ${i} ends at ${end}, past the ${binLength}-byte BIN chunk`);
  }
  const accessors = arr('accessors');
  const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const typeCount: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  for (const [i, a] of accessors.entries()) {
    if (a.bufferView === undefined) continue;
    const bv = bufferViews[Number(a.bufferView)];
    if (!bv) return fail(`accessor ${i} points at a missing bufferView`);
    const elem = (componentBytes[Number(a.componentType)] ?? 0) * (typeCount[String(a.type)] ?? 0);
    const stride = Number(bv.byteStride ?? elem);
    const need = Number(a.byteOffset ?? 0) + (Number(a.count) - 1) * stride + elem;
    if (!elem || need > Number(bv.byteLength ?? 0)) return fail(`accessor ${i} needs ${need} bytes but its bufferView has ${String(bv.byteLength)}`);
  }
  checks.push(`PASS ${bufferViews.length} buffer views and ${accessors.length} accessors fit inside the BIN chunk`);
  const meshes = arr('meshes');
  const nodes = arr('nodes');
  const materials = arr('materials');
  if (meshes.length === 0) return fail('the file contains no meshes');
  let triangles: number | null = 0;
  for (const mesh of meshes) {
    for (const prim of (Array.isArray(mesh.primitives) ? mesh.primitives : []) as Array<Record<string, unknown>>) {
      const mode = prim.mode === undefined ? 4 : Number(prim.mode);
      const idx = prim.indices !== undefined ? accessors[Number(prim.indices)] : undefined;
      const pos = accessors[Number((prim.attributes as Record<string, unknown> | undefined)?.POSITION)];
      const count = idx ? Number(idx.count) : pos ? Number(pos.count) : NaN;
      if (mode === 4 && Number.isFinite(count)) triangles = (triangles ?? 0) + Math.floor(count / 3);
      else triangles = null;
    }
  }
  checks.push(`PASS ${meshes.length} meshes, ${nodes.length} nodes, ${materials.length} materials${triangles !== null ? `, ${triangles} triangles` : ''}`);
  return { ok: true, checks, meshes: meshes.length, nodes: nodes.length, materials: materials.length, triangles, generator: typeof asset.generator === 'string' ? asset.generator.slice(0, 80) : null };
}

/** The node names in a GLB's JSON chunk (to check an export contains the scene's components). */
export function glbNodeNames(bytes: Uint8Array): string[] {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as { nodes?: Array<{ name?: string }> };
    return (gltf.nodes ?? []).map((n) => String(n.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}
