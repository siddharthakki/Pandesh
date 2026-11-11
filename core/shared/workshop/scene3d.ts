/**
 * The 3D Workshop's scene: structured data, never code.
 *
 * A model proposes a scene as a list of components built from a fixed catalog of parametric shapes (box, cylinder,
 * tube, sphere, cone, torus, gear, capsule) with bounded numbers and named physically based materials. Core validates
 * and normalizes it before anything is stored; the window builds the meshes with Babylon.js from the validated data.
 * No generated script ever runs in Pandesh: the only "programs" are the preapproved component builders.
 *
 * Units are millimetres, Y is up. Rotations are degrees. Cylinders, tubes, gears and capsules stand on the Y axis.
 * Pure TypeScript (no Node, no DOM): Core, the host and the window share these rules.
 */

export const SCENE_FORMAT = 'pandesh.scene';
export const MAX_COMPONENTS = 64;
const MAX_COORD = 5_000;
const MAX_SIZE = 2_000;

export type Vec3 = [number, number, number];
export type ComponentKind = 'box' | 'cylinder' | 'tube' | 'sphere' | 'cone' | 'torus' | 'gear' | 'capsule';
export const COMPONENT_KINDS: readonly ComponentKind[] = ['box', 'cylinder', 'tube', 'sphere', 'cone', 'torus', 'gear', 'capsule'];

/** The parameters each component builder takes, with their bounds and defaults. */
export const COMPONENT_PARAMS: Record<ComponentKind, Record<string, { min: number; max: number; default: number; integer?: boolean }>> = {
  box: { width: { min: 0.05, max: MAX_SIZE, default: 20 }, height: { min: 0.05, max: MAX_SIZE, default: 20 }, depth: { min: 0.05, max: MAX_SIZE, default: 20 } },
  cylinder: { radius: { min: 0.05, max: MAX_SIZE / 2, default: 10 }, height: { min: 0.05, max: MAX_SIZE, default: 20 } },
  tube: { outerRadius: { min: 0.1, max: MAX_SIZE / 2, default: 20 }, innerRadius: { min: 0.05, max: MAX_SIZE / 2, default: 16 }, height: { min: 0.05, max: MAX_SIZE, default: 10 } },
  sphere: { radius: { min: 0.05, max: MAX_SIZE / 2, default: 10 } },
  cone: { radius: { min: 0.05, max: MAX_SIZE / 2, default: 10 }, height: { min: 0.05, max: MAX_SIZE, default: 20 } },
  torus: { radius: { min: 0.1, max: MAX_SIZE / 2, default: 20 }, tube: { min: 0.05, max: MAX_SIZE / 4, default: 3 } },
  gear: {
    teeth: { min: 6, max: 200, default: 24, integer: true },
    radius: { min: 1, max: MAX_SIZE / 2, default: 30 },
    thickness: { min: 0.1, max: MAX_SIZE / 4, default: 6 },
    bore: { min: 0, max: MAX_SIZE / 2, default: 0 },
  },
  capsule: { radius: { min: 0.05, max: MAX_SIZE / 2, default: 5 }, length: { min: 0.1, max: MAX_SIZE, default: 30 } },
};

export type MaterialPreset =
  | 'brushed_steel' | 'polished_steel' | 'aluminium' | 'brass' | 'gold' | 'copper' | 'iron' | 'titanium'
  | 'plastic' | 'rubber' | 'glass' | 'sapphire' | 'wood' | 'ceramic' | 'enamel' | 'painted' | 'ruby';

/** Physically based presets: base colour, metalness and roughness as a PBR (metallic-roughness) material uses them. */
export const MATERIAL_PRESETS: Record<MaterialPreset, { label: string; color: string; metalness: number; roughness: number; opacity?: number; anisotropy?: number }> = {
  brushed_steel: { label: 'Brushed steel', color: '#c3c8ce', metalness: 1, roughness: 0.34, anisotropy: 0.7 },
  polished_steel: { label: 'Polished steel', color: '#dfe3e7', metalness: 1, roughness: 0.2 },
  aluminium: { label: 'Aluminium', color: '#d6d9dd', metalness: 1, roughness: 0.32 },
  brass: { label: 'Brass', color: '#d6b064', metalness: 1, roughness: 0.28 },
  gold: { label: 'Gold', color: '#f0c75e', metalness: 1, roughness: 0.18 },
  copper: { label: 'Copper', color: '#d98c5f', metalness: 1, roughness: 0.27 },
  iron: { label: 'Iron', color: '#7c7f84', metalness: 1, roughness: 0.6 },
  titanium: { label: 'Titanium', color: '#9a9590', metalness: 1, roughness: 0.35 },
  plastic: { label: 'Plastic', color: '#e8e8e8', metalness: 0, roughness: 0.45 },
  rubber: { label: 'Rubber', color: '#232323', metalness: 0, roughness: 0.92 },
  glass: { label: 'Glass', color: '#e8f4ff', metalness: 0, roughness: 0.04, opacity: 0.25 },
  sapphire: { label: 'Sapphire crystal', color: '#eef6ff', metalness: 0, roughness: 0.02, opacity: 0.18 },
  wood: { label: 'Wood', color: '#9a6b3f', metalness: 0, roughness: 0.75 },
  ceramic: { label: 'Ceramic', color: '#f4f1ea', metalness: 0, roughness: 0.22 },
  enamel: { label: 'Enamel', color: '#fbfaf6', metalness: 0, roughness: 0.12 },
  painted: { label: 'Painted', color: '#3b6fd8', metalness: 0, roughness: 0.5 },
  ruby: { label: 'Ruby', color: '#b0103a', metalness: 0, roughness: 0.08, opacity: 0.85 },
};
export const MATERIAL_PRESET_IDS = Object.keys(MATERIAL_PRESETS) as MaterialPreset[];

const PRESET_ALIASES: Record<string, MaterialPreset> = {
  steel: 'brushed_steel', stainless: 'brushed_steel', stainless_steel: 'brushed_steel', brushed: 'brushed_steel', brushed_stainless_steel: 'brushed_steel',
  chrome: 'polished_steel', polished: 'polished_steel', mirror_steel: 'polished_steel', aluminum: 'aluminium', alu: 'aluminium',
  bronze: 'brass', golden: 'gold', rose_gold: 'copper', cast_iron: 'iron', metal: 'brushed_steel',
  crystal: 'sapphire', sapphire_glass: 'sapphire', clear_glass: 'glass', porcelain: 'ceramic', paint: 'painted', painted_metal: 'painted',
  jewel: 'ruby', ruby_jewel: 'ruby',
};

/** Colour names a person is likely to say, as hex. */
const COLOR_NAMES: Record<string, string> = {
  red: '#d33a2c', blue: '#2f6fe0', green: '#2e9d5b', yellow: '#f2c230', orange: '#ef7d22', purple: '#7d4ad8', violet: '#7d4ad8',
  pink: '#e86aa6', black: '#151515', white: '#f5f5f2', gray: '#8a8d91', grey: '#8a8d91', silver: '#c0c4c8', gold: '#d4af37',
  brown: '#7a5232', navy: '#1f2f5c', teal: '#1f9c9c', cyan: '#2cc4d8', magenta: '#c83fb0', beige: '#d9c7a3', cream: '#f2ead3',
  darkblue: '#1d3a8a', dark_blue: '#1d3a8a', lightblue: '#8ec3f2', light_blue: '#8ec3f2', darkgreen: '#1f5f3a', dark_green: '#1f5f3a',
  darkgray: '#45484c', darkgrey: '#45484c', dark_gray: '#45484c', dark_grey: '#45484c', lightgray: '#cfd2d6', light_grey: '#cfd2d6', light_gray: '#cfd2d6',
};

export interface SceneMaterial { preset: MaterialPreset; color: string; metalness: number; roughness: number; opacity: number }

export interface SceneComponent {
  /** Stable id: lower-case letters, digits, '-' and '_'. */
  id: string;
  name: string;
  kind: ComponentKind;
  params: Record<string, number>;
  position: Vec3;
  rotation: Vec3;
  material: SceneMaterial;
  /** Optional sub-assembly name, shown as a level of the scene hierarchy. */
  group: string | null;
  /** Text shown when labels are on (the name when absent). */
  label: string | null;
  /** Direction this part moves in the exploded view; derived from the assembly when absent. */
  explode: Vec3 | null;
  note: string | null;
}

export interface Scene3D {
  format: typeof SCENE_FORMAT;
  version: 1;
  title: string;
  units: 'mm';
  components: SceneComponent[];
  /** Honest notes about the scene (e.g. simplified gear teeth), shown with it. */
  notes: string[];
}

export type ValidationResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

function slug(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'part';
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function vec3(value: unknown, label: string, errors: string[], fallback: Vec3, limit = MAX_COORD): Vec3 {
  if (value === undefined || value === null) return [...fallback] as Vec3;
  const raw = Array.isArray(value) ? value : isRecord(value) ? [value.x, value.y, value.z] : null;
  if (!raw || raw.length !== 3) { errors.push(`${label} must be [x, y, z]`); return [...fallback] as Vec3; }
  const out = raw.map(num);
  if (out.some((n) => n === null || Math.abs(n) > limit)) { errors.push(`${label} values must be numbers within ±${limit}`); return [...fallback] as Vec3; }
  return out.map((n) => Math.round((n as number) * 1000) / 1000) as Vec3;
}

/** "brushed steel", "Brushed-Steel", "stainless" → a preset id, or null. */
export function materialPresetFromText(value: string): MaterialPreset | null {
  const key = value.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  if ((MATERIAL_PRESET_IDS as string[]).includes(key)) return key as MaterialPreset;
  if (PRESET_ALIASES[key]) return PRESET_ALIASES[key];
  for (const id of MATERIAL_PRESET_IDS) if (key.includes(id)) return id;
  for (const [alias, id] of Object.entries(PRESET_ALIASES)) if (key.split('_').includes(alias)) return id;
  return null;
}

/** "#3a7", "#33aa77", "dark blue" → #rrggbb, or null. */
export function colorFromText(value: string): string | null {
  const t = value.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return `#${h}`;
  }
  const key = t.replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
  return COLOR_NAMES[key] ?? COLOR_NAMES[key.replace(/_/g, '')] ?? null;
}

function defaultMaterial(): SceneMaterial {
  const p = MATERIAL_PRESETS.plastic;
  return { preset: 'plastic', color: p.color, metalness: p.metalness, roughness: p.roughness, opacity: 1 };
}

/**
 * A material from what a model or a person wrote: a preset name ("brass"), a colour ("blue" → painted blue), or an
 * object { preset, color, metalness, roughness, opacity }.
 */
export function parseMaterial(input: unknown, base?: SceneMaterial): { ok: true; material: SceneMaterial } | { ok: false; error: string } {
  const fromPreset = (preset: MaterialPreset): SceneMaterial => {
    const p = MATERIAL_PRESETS[preset];
    return { preset, color: p.color, metalness: p.metalness, roughness: p.roughness, opacity: p.opacity ?? 1 };
  };
  if (typeof input === 'string') {
    const preset = materialPresetFromText(input);
    if (preset) return { ok: true, material: fromPreset(preset) };
    const color = colorFromText(input);
    if (color) {
      const metal = base && base.metalness > 0.5 ? base : null;
      // A colour on a metal part keeps the metal finish; on anything else it is a painted surface.
      return { ok: true, material: metal ? { ...metal, color } : { ...fromPreset('painted'), color } };
    }
    return { ok: false, error: `unknown material "${input.slice(0, 40)}"; use one of ${MATERIAL_PRESET_IDS.join(', ')} or a colour` };
  }
  if (!isRecord(input)) return { ok: false, error: 'material must be a preset name, a colour, or { preset, color, metalness, roughness }' };
  let material: SceneMaterial = base ? { ...base } : fromPreset('plastic');
  if (typeof input.preset === 'string') {
    const preset = materialPresetFromText(input.preset);
    if (!preset) return { ok: false, error: `unknown material preset "${input.preset.slice(0, 40)}"` };
    material = fromPreset(preset);
  }
  if (input.color !== undefined) {
    const color = typeof input.color === 'string' ? colorFromText(input.color) : null;
    if (!color) return { ok: false, error: `colour "${String(input.color).slice(0, 30)}" is not a colour name or #rrggbb` };
    material.color = color;
  }
  for (const key of ['metalness', 'roughness', 'opacity'] as const) {
    if (input[key] === undefined) continue;
    const n = num(input[key]);
    if (n === null || n < 0 || n > 1) return { ok: false, error: `${key} must be between 0 and 1` };
    material[key] = key === 'opacity' ? Math.max(0.05, n) : n;
  }
  return { ok: true, material };
}

function componentParams(kind: ComponentKind, raw: unknown, label: string, errors: string[]): Record<string, number> {
  const spec = COMPONENT_PARAMS[kind];
  const input = isRecord(raw) ? raw : {};
  const out: Record<string, number> = {};
  for (const [key, bound] of Object.entries(spec)) {
    const given = input[key] === undefined ? null : num(input[key]);
    if (input[key] !== undefined && given === null) { errors.push(`${label}: ${key} must be a number`); continue; }
    let value = given ?? bound.default;
    if (bound.integer) value = Math.round(value);
    if (value < bound.min || value > bound.max) { errors.push(`${label}: ${key} must be between ${bound.min} and ${bound.max} (got ${value})`); continue; }
    out[key] = Math.round(value * 1000) / 1000;
  }
  for (const key of Object.keys(input)) if (!(key in spec)) errors.push(`${label}: '${key}' is not a ${kind} parameter (${Object.keys(spec).join(', ')})`);
  if (kind === 'tube' && out.innerRadius >= out.outerRadius) errors.push(`${label}: innerRadius must be smaller than outerRadius`);
  if (kind === 'torus' && out.tube >= out.radius) errors.push(`${label}: tube must be smaller than radius`);
  if (kind === 'gear' && out.bore >= out.radius * 0.85) errors.push(`${label}: bore must be smaller than the gear (at most 85% of its radius)`);
  return out;
}

/** The gear module (pitch radius per tooth × 2): two gears mesh only when their modules match. */
export function gearModule(component: Pick<SceneComponent, 'params'>): number {
  return (2 * component.params.radius) / component.params.teeth;
}

const GEAR_NOTE = 'Gear teeth are drawn with a simplified trapezoid profile, not an engineered involute profile; the model shows arrangement, not manufacturable tolerances.';

/**
 * A generated scene (Pandesh's own local designer, not a tool call): parameters that do not belong to a component's
 * shape are dropped, and a component that is still invalid is left out, each with a warning, as long as at least one
 * valid component remains. A model writing a tool call gets the strict errors instead, so it learns what it may write.
 */
export function validateGeneratedScene(raw: unknown): ValidationResult<Scene3D> {
  if (!isRecord(raw) || !Array.isArray(raw.components)) return validateScene(raw);
  const warnings: string[] = [];
  const allowed = new Set(['id', 'name', 'kind', 'type', 'params', 'position', 'rotation', 'material', 'group', 'label', 'explode', 'note', 'meshWith', 'angle', 'color']);
  const kept: Record<string, unknown>[] = [];
  for (const entry of raw.components.slice(0, MAX_COMPONENTS)) {
    if (!isRecord(entry)) continue;
    const kind = String(entry.kind ?? entry.type ?? '').toLowerCase() as ComponentKind;
    const name = cleanText(entry.name, 60) ?? kind;
    if (!COMPONENT_KINDS.includes(kind)) { warnings.push(`left out "${name}": "${String(entry.kind ?? '')}" is not a shape Pandesh can build`); continue; }
    const params = isRecord(entry.params) ? Object.fromEntries(Object.entries(entry.params).filter(([k]) => k in COMPONENT_PARAMS[kind])) : {};
    const clean = Object.fromEntries(Object.entries(entry).filter(([k]) => allowed.has(k)));
    const candidate = { ...clean, kind, params };
    const alone = validateScene({ title: 't', components: [candidate] });
    if (!alone.ok && !('meshWith' in candidate)) { warnings.push(`left out "${name}": ${alone.errors[0]}`); continue; }
    kept.push(candidate);
  }
  if (!kept.length) return { ok: false, errors: ['none of the generated components could be built', ...warnings].slice(0, 12) };
  const result = validateScene({ title: raw.title, components: kept });
  if (!result.ok) {
    // A gear pointing at a partner that was left out: build it where it stands instead.
    const fallback = kept.map((c) => { const { meshWith: _m, angle: _a, ...rest } = c; return rest; });
    const second = validateScene({ title: raw.title, components: fallback });
    if (!second.ok) return second;
    return { ok: true, value: second.value, warnings: [...warnings, 'gears could not be meshed as described; they stand where the design put them', ...second.warnings] };
  }
  return { ok: true, value: result.value, warnings: [...warnings, ...result.warnings] };
}

/**
 * Validates and normalizes a proposed scene. Unknown fields are refused rather than ignored, so a model learns
 * what it may write; numbers are bounded; ids are made unique; a gear may say `meshWith: <gear id>` (and `angle`) and
 * is then placed so the two pitch circles touch, instead of trusting the model's arithmetic.
 */
export function validateScene(raw: unknown): ValidationResult<Scene3D> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['a scene must be an object with a title and components'] };
  const title = cleanText(raw.title, 120) ?? 'Untitled scene';
  const list = Array.isArray(raw.components) ? raw.components : null;
  if (!list || list.length === 0) return { ok: false, errors: ['a scene needs at least one component'] };
  if (list.length > MAX_COMPONENTS) return { ok: false, errors: [`a scene may have at most ${MAX_COMPONENTS} components (got ${list.length})`] };
  const allowedTop = new Set(['format', 'version', 'title', 'units', 'components', 'notes', 'description']);
  for (const key of Object.keys(raw)) if (!allowedTop.has(key)) errors.push(`'${key}' is not a scene field`);
  const ids = new Set<string>();
  const components: SceneComponent[] = [];
  const meshRequests: Array<{ index: number; partner: string; angle: number; raw: Record<string, unknown> }> = [];
  const allowed = new Set(['id', 'name', 'kind', 'type', 'params', 'position', 'rotation', 'material', 'group', 'label', 'explode', 'note', 'meshWith', 'angle', 'color']);
  list.forEach((entry, index) => {
    const label = `component ${index + 1}`;
    if (!isRecord(entry)) { errors.push(`${label} must be an object`); return; }
    for (const key of Object.keys(entry)) if (!allowed.has(key)) errors.push(`${label}: '${key}' is not a component field`);
    const kindRaw = typeof entry.kind === 'string' ? entry.kind : typeof entry.type === 'string' ? entry.type : '';
    const kind = kindRaw.toLowerCase().trim() as ComponentKind;
    if (!COMPONENT_KINDS.includes(kind)) { errors.push(`${label}: kind must be one of ${COMPONENT_KINDS.join(', ')}`); return; }
    const name = cleanText(entry.name, 60) ?? `${kind} ${index + 1}`;
    let id = typeof entry.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(entry.id) ? entry.id.toLowerCase() : slug(name);
    if (ids.has(id)) { let n = 2; while (ids.has(`${id}_${n}`)) n += 1; id = `${id}_${n}`; }
    ids.add(id);
    const params = componentParams(kind, entry.params, `${label} (${name})`, errors);
    const materialInput = entry.material ?? (entry.color !== undefined ? { preset: 'painted', color: entry.color } : 'plastic');
    const parsed = parseMaterial(materialInput);
    if (!parsed.ok) errors.push(`${label} (${name}): ${parsed.error}`);
    const component: SceneComponent = {
      id,
      name,
      kind,
      params,
      position: vec3(entry.position, `${label} position`, errors, [0, 0, 0]),
      rotation: vec3(entry.rotation, `${label} rotation`, errors, [0, 0, 0], 3600),
      material: parsed.ok ? parsed.material : defaultMaterial(),
      group: cleanText(entry.group, 60),
      label: cleanText(entry.label, 80),
      explode: entry.explode === undefined || entry.explode === null ? null : vec3(entry.explode, `${label} explode`, errors, [0, 1, 0], 10),
      note: cleanText(entry.note, 200),
    };
    components.push(component);
    if (entry.meshWith !== undefined) {
      if (kind !== 'gear') errors.push(`${label}: only a gear can meshWith another gear`);
      else meshRequests.push({ index: components.length - 1, partner: String(entry.meshWith).toLowerCase(), angle: num(entry.angle) ?? 0, raw: entry });
    }
  });
  // Gears that mesh with another gear are placed from the partner (in order, so a train can chain).
  for (const request of meshRequests) {
    const gear = components[request.index];
    const partner = components.find((c) => c.id === request.partner || c.name.toLowerCase() === request.partner);
    if (!partner || partner.kind !== 'gear') { errors.push(`${gear.name}: meshWith "${request.partner}" is not a gear in this scene`); continue; }
    if (partner === gear) { errors.push(`${gear.name}: a gear cannot mesh with itself`); continue; }
    const rawParams = isRecord(request.raw.params) ? request.raw.params : {};
    if (rawParams.radius === undefined) {
      // Same module as the partner, so the teeth really fit.
      gear.params.radius = Math.round(((gearModule(partner) * gear.params.teeth) / 2) * 1000) / 1000;
    } else if (Math.abs(gearModule(gear) - gearModule(partner)) / gearModule(partner) > 0.03) {
      warnings.push(`${gear.name} and ${partner.name} have different tooth sizes (module ${gearModule(gear).toFixed(2)} vs ${gearModule(partner).toFixed(2)}); real gears with these sizes would not mesh.`);
    }
    const distance = gear.params.radius + partner.params.radius;
    const a = (request.angle * Math.PI) / 180;
    gear.position = [
      Math.round((partner.position[0] + distance * Math.cos(a)) * 1000) / 1000,
      request.raw.position === undefined ? partner.position[1] : gear.position[1],
      Math.round((partner.position[2] + distance * Math.sin(a)) * 1000) / 1000,
    ];
    // Turn the gear so a gap faces the partner's tooth at the contact point (see meshPhaseDegrees).
    gear.rotation = [gear.rotation[0], meshPhaseDegrees(partner, gear, request.angle), gear.rotation[2]];
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((n) => cleanText(n, 200)).filter((n): n is string => Boolean(n)).slice(0, 5);
  if (components.some((c) => c.kind === 'gear') && !notes.includes(GEAR_NOTE)) notes.push(GEAR_NOTE);
  return { ok: true, value: { format: SCENE_FORMAT, version: 1, title, units: 'mm', components, notes }, warnings };
}

/**
 * The Y rotation (degrees) that interleaves `gear`'s teeth with `partner`'s when `gear` sits at `angle` degrees
 * around it. Tooth i of a gear with N teeth is centred at rotation + 360·i/N, measured from +X towards +Z.
 */
export function meshPhaseDegrees(partner: SceneComponent, gear: SceneComponent, angle: number): number {
  const pitchA = 360 / partner.params.teeth;
  const pitchB = 360 / gear.params.teeth;
  const phaseA = ((((angle - partner.rotation[1]) % pitchA) + pitchA) % pitchA) / pitchA;
  const phaseB = ((0.5 - phaseA) % 1 + 1) % 1;
  const rotation = angle + 180 - phaseB * pitchB;
  return Math.round(((((rotation % 360) + 360) % 360)) * 1000) / 1000;
}

/** Rough size of a component, for framing and for the exploded view. */
export function componentExtent(c: SceneComponent): Vec3 {
  const p = c.params;
  switch (c.kind) {
    case 'box': return [p.width, p.height, p.depth];
    case 'cylinder': return [p.radius * 2, p.height, p.radius * 2];
    case 'tube': return [p.outerRadius * 2, p.height, p.outerRadius * 2];
    case 'sphere': return [p.radius * 2, p.radius * 2, p.radius * 2];
    case 'cone': return [p.radius * 2, p.height, p.radius * 2];
    case 'torus': return [(p.radius + p.tube) * 2, p.tube * 2, (p.radius + p.tube) * 2];
    case 'gear': { const tip = p.radius + (2 * p.radius) / p.teeth; return [tip * 2, p.thickness, tip * 2]; }
    case 'capsule': return [p.radius * 2, p.length, p.radius * 2];
    default: return [10, 10, 10];
  }
}

/** Centre and radius of the assembled scene (component centres and sizes). */
export function sceneBounds(scene: Scene3D): { center: Vec3; radius: number } {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of scene.components) {
    const e = componentExtent(c);
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], c.position[i] - e[i] / 2);
      max[i] = Math.max(max[i], c.position[i] + e[i] / 2);
    }
  }
  if (!Number.isFinite(min[0])) { min = [0, 0, 0]; max = [0, 0, 0]; }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  return { center, radius };
}

/**
 * How far each component moves in the fully exploded view (factor 1). A component with its own `explode` direction
 * moves along it. Parts on the assembly's centre line (a watch's stacked layers, the parts on one shaft) move apart
 * along Y in their stacking order, so each layer separates from its neighbours. Every other part moves away from the
 * centre. At factor 0 every part is exactly at its stored position: reassembly is exact, not approximate.
 */
export function explodeOffsets(scene: Scene3D): Record<string, Vec3> {
  const { center, radius } = sceneBounds(scene);
  const spread = radius * 0.9;
  const out: Record<string, Vec3> = {};
  const onAxis: SceneComponent[] = [];
  for (const c of scene.components) {
    if (c.explode) {
      const l = Math.hypot(...c.explode) || 1;
      out[c.id] = [(c.explode[0] / l) * spread, (c.explode[1] / l) * spread, (c.explode[2] / l) * spread];
      continue;
    }
    const d: Vec3 = [c.position[0] - center[0], c.position[1] - center[1], c.position[2] - center[2]];
    if (Math.hypot(d[0], d[2]) < radius * 0.08) { onAxis.push(c); continue; }
    const l = Math.hypot(d[0], d[1] * 0.5, d[2]) || 1;
    out[c.id] = [(d[0] / l) * spread, (d[1] / l) * spread * 0.5, (d[2] / l) * spread];
  }
  // Stacking order: by height, then by list order; the middle of the stack stays, the rest fan out up and down.
  const stack = onAxis.map((c, i) => ({ c, i })).sort((a, b) => a.c.position[1] - b.c.position[1] || a.i - b.i);
  const step = stack.length > 1 ? (spread * 1.6) / (stack.length - 1) : 0;
  stack.forEach(({ c }, rank) => { out[c.id] = [0, (rank - (stack.length - 1) / 2) * step, 0]; });
  return out;
}

/** A component's position at `factor` 0 (assembled) … 1 (exploded). */
export function explodedPosition(scene: Scene3D, component: SceneComponent, factor: number, offsets = explodeOffsets(scene)): Vec3 {
  const f = Math.max(0, Math.min(1, factor));
  const o = offsets[component.id] ?? [0, 0, 0];
  return [component.position[0] + o[0] * f, component.position[1] + o[1] * f, component.position[2] + o[2] * f];
}

// ---------------------------------------------------------------------------- edits

export type SceneEdit =
  | { op: 'set_material'; target: string; material: unknown }
  | { op: 'set_color'; target: string; color: string }
  | { op: 'move'; target: string; position?: unknown; by?: unknown }
  | { op: 'rotate'; target: string; rotation: unknown }
  | { op: 'set_params'; target: string; params: Record<string, unknown> }
  | { op: 'rename'; target: string; name: string }
  | { op: 'set_label'; target: string; label: string | null }
  | { op: 'add'; component: Record<string, unknown> }
  | { op: 'remove'; target: string }
  | { op: 'set_title'; title: string };

export const SCENE_EDIT_OPS = ['set_material', 'set_color', 'move', 'rotate', 'set_params', 'rename', 'set_label', 'add', 'remove', 'set_title'] as const;

export interface SceneChange { componentId: string | null; name: string; field: string; from: string; to: string }

const STOP_WORDS = new Set(['the', 'a', 'an', 'its', 'it', 'this', 'that', 'my', 'part', 'component', 'piece']);
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP_WORDS.has(w));

/**
 * Finds the component(s) a target names: an id, an exact name or label, `kind:<kind>` / `group:<name>` for several,
 * or a unique match of the words. More than one candidate is an ambiguity the caller must ask about, never guessed.
 */
export function resolveComponents(scene: Scene3D, target: string): { ok: true; components: SceneComponent[] } | { ok: false; error: string; candidates: string[] } {
  const t = String(target ?? '').trim();
  const all = scene.components;
  const names = () => all.map((c) => c.name);
  if (!t) return { ok: false, error: 'no component was named', candidates: names() };
  const lower = t.toLowerCase();
  const kindMatch = /^(?:kind|all):\s*(\w+)$/i.exec(t) ?? /^all\s+(\w+?)s?$/i.exec(t);
  if (kindMatch) {
    const kind = kindMatch[1].toLowerCase().replace(/s$/, '') as ComponentKind;
    const found = all.filter((c) => c.kind === kind);
    return found.length ? { ok: true, components: found } : { ok: false, error: `no ${kind} components in this scene`, candidates: names() };
  }
  const groupMatch = /^group:\s*(.+)$/i.exec(t);
  if (groupMatch) {
    const g = groupMatch[1].trim().toLowerCase();
    const found = all.filter((c) => c.group?.toLowerCase() === g);
    return found.length ? { ok: true, components: found } : { ok: false, error: `no group named "${groupMatch[1].trim()}"`, candidates: [...new Set(all.map((c) => c.group).filter((x): x is string => Boolean(x)))] };
  }
  const exact = all.filter((c) => c.id === lower || c.name.toLowerCase() === lower || c.label?.toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, components: exact };
  const want = tokens(t);
  if (!want.length) return { ok: false, error: `"${t}" does not name a component`, candidates: names() };
  const scored = all.map((c) => {
    const have = new Set([...tokens(c.name), ...tokens(c.label ?? ''), ...tokens(c.id.replace(/_/g, ' ')), c.kind]);
    const hits = want.filter((w) => have.has(w) || have.has(w.replace(/s$/, ''))).length;
    return { c, hits, all: hits === want.length };
  });
  const full = scored.filter((s) => s.all);
  if (full.length === 1) return { ok: true, components: [full[0].c] };
  if (full.length > 1) {
    // "case" matches "Outer case" and "Case back": prefer the one whose name has no extra words.
    const tight = full.filter((s) => tokens(s.c.name).length === want.length);
    if (tight.length === 1) return { ok: true, components: [tight[0].c] };
    return { ok: false, error: `"${t}" matches more than one component`, candidates: full.map((s) => s.c.name) };
  }
  return { ok: false, error: `no component matches "${t}"`, candidates: names() };
}

function describeMaterial(m: SceneMaterial): string {
  return `${MATERIAL_PRESETS[m.preset]?.label ?? m.preset} ${m.color}`;
}

/**
 * Applies edits to a copy of the scene. Only the components an edit names change; every other component is
 * carried over untouched (same id, same values), which the tests check. Any failed edit fails the whole change.
 */
export function applySceneEdits(scene: Scene3D, edits: unknown): { ok: true; scene: Scene3D; changes: SceneChange[]; warnings: string[] } | { ok: false; errors: string[]; candidates?: string[] } {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, errors: ['edits must be a non-empty list'] };
  if (edits.length > 40) return { ok: false, errors: ['at most 40 edits at once'] };
  const next: Scene3D = JSON.parse(JSON.stringify(scene)) as Scene3D;
  const changes: SceneChange[] = [];
  const errors: string[] = [];
  let candidates: string[] | undefined;
  const pick = (target: unknown) => {
    const r = resolveComponents(next, String(target ?? ''));
    if (!r.ok) { errors.push(r.error); candidates = r.candidates; return []; }
    return r.components;
  };
  edits.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.op !== 'string') { errors.push(`edit ${index + 1} must be { op, … }`); return; }
    const op = raw.op;
    switch (op) {
      case 'set_material':
      case 'set_color': {
        for (const c of pick(raw.target)) {
          const parsed = parseMaterial(op === 'set_color' ? String(raw.color ?? '') : raw.material, c.material);
          if (!parsed.ok) { errors.push(`${c.name}: ${parsed.error}`); continue; }
          changes.push({ componentId: c.id, name: c.name, field: 'material', from: describeMaterial(c.material), to: describeMaterial(parsed.material) });
          c.material = parsed.material;
        }
        return;
      }
      case 'move': {
        for (const c of pick(raw.target)) {
          const before = c.position.join(', ');
          const e: string[] = [];
          if (raw.position !== undefined) c.position = vec3(raw.position, `${c.name} position`, e, c.position);
          else if (raw.by !== undefined) { const by = vec3(raw.by, `${c.name} offset`, e, [0, 0, 0]); c.position = [c.position[0] + by[0], c.position[1] + by[1], c.position[2] + by[2]]; }
          else e.push(`${c.name}: move needs position or by`);
          if (e.length) { errors.push(...e); continue; }
          changes.push({ componentId: c.id, name: c.name, field: 'position', from: before, to: c.position.join(', ') });
        }
        return;
      }
      case 'rotate': {
        for (const c of pick(raw.target)) {
          const e: string[] = [];
          const before = c.rotation.join(', ');
          c.rotation = vec3(raw.rotation, `${c.name} rotation`, e, c.rotation, 3600);
          if (e.length) { errors.push(...e); continue; }
          changes.push({ componentId: c.id, name: c.name, field: 'rotation', from: before, to: c.rotation.join(', ') });
        }
        return;
      }
      case 'set_params': {
        for (const c of pick(raw.target)) {
          const e: string[] = [];
          const merged = componentParams(c.kind, { ...c.params, ...(isRecord(raw.params) ? raw.params : {}) }, c.name, e);
          if (e.length) { errors.push(...e); continue; }
          changes.push({ componentId: c.id, name: c.name, field: 'params', from: JSON.stringify(c.params), to: JSON.stringify(merged) });
          c.params = merged;
        }
        return;
      }
      case 'rename':
      case 'set_label': {
        for (const c of pick(raw.target)) {
          if (op === 'rename') {
            const name = cleanText(raw.name, 60);
            if (!name) { errors.push(`${c.name}: a new name is required`); continue; }
            changes.push({ componentId: c.id, name: c.name, field: 'name', from: c.name, to: name });
            c.name = name;
          } else {
            const label = raw.label === null ? null : cleanText(raw.label, 80);
            changes.push({ componentId: c.id, name: c.name, field: 'label', from: c.label ?? '', to: label ?? '' });
            c.label = label;
          }
        }
        return;
      }
      case 'add': {
        if (next.components.length >= MAX_COMPONENTS) { errors.push(`a scene may have at most ${MAX_COMPONENTS} components`); return; }
        // Local models often name the new part's field "parameters" or "part"; the part itself is still validated.
        const part = raw.component ?? raw.parameters ?? raw.part;
        if (!isRecord(part)) { errors.push('add needs { "op": "add", "component": { name, kind, params, position, material } }'); return; }
        const probe = validateScene({ title: next.title, components: [...next.components.map(toInput), part] });
        if (!probe.ok) { errors.push(...probe.errors); return; }
        const added = probe.value.components[probe.value.components.length - 1];
        next.components.push(added);
        changes.push({ componentId: added.id, name: added.name, field: 'added', from: '', to: `${added.kind} at ${added.position.join(', ')}` });
        return;
      }
      case 'remove': {
        const found = pick(raw.target);
        if (found.length && found.length >= next.components.length) { errors.push('a scene must keep at least one component'); return; }
        for (const c of found) {
          next.components = next.components.filter((x) => x !== c);
          changes.push({ componentId: c.id, name: c.name, field: 'removed', from: c.kind, to: '' });
        }
        return;
      }
      case 'set_title': {
        const title = cleanText(raw.title, 120);
        if (!title) { errors.push('a title is required'); return; }
        changes.push({ componentId: null, name: 'scene', field: 'title', from: next.title, to: title });
        next.title = title;
        return;
      }
      default:
        errors.push(`unknown edit op "${op}"; use one of ${SCENE_EDIT_OPS.join(', ')}`);
    }
  });
  if (errors.length) return { ok: false, errors: [...new Set(errors)].slice(0, 12), ...(candidates ? { candidates } : {}) };
  if (!changes.length) return { ok: false, errors: ['the edits changed nothing'] };
  return { ok: true, scene: next, changes, warnings: [] };
}

/** A component back in the input shape (for re-validation). */
export function toInput(c: SceneComponent): Record<string, unknown> {
  return { id: c.id, name: c.name, kind: c.kind, params: c.params, position: c.position, rotation: c.rotation, material: { preset: c.material.preset, color: c.material.color, metalness: c.material.metalness, roughness: c.material.roughness, opacity: c.material.opacity }, ...(c.group ? { group: c.group } : {}), ...(c.label ? { label: c.label } : {}), ...(c.explode ? { explode: c.explode } : {}), ...(c.note ? { note: c.note } : {}) };
}

/** A stored scene file read back: re-validated, so a file edited outside Pandesh can never smuggle in fields. */
export function parseSceneFile(text: string): ValidationResult<Scene3D> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, errors: ['the scene file is not valid JSON'] }; }
  if (!isRecord(raw) || raw.format !== SCENE_FORMAT) return { ok: false, errors: ['not a Pandesh scene file'] };
  const { format: _f, version: _v, units: _u, ...rest } = raw;
  const components = Array.isArray(rest.components) ? rest.components.map((c) => (isRecord(c) ? c : {})) : rest.components;
  return validateScene({ ...rest, components });
}

/** What differs between two versions of a scene, component by component (for "compare versions"). */
export function diffScenes(before: Scene3D, after: Scene3D): SceneChange[] {
  const out: SceneChange[] = [];
  if (before.title !== after.title) out.push({ componentId: null, name: 'scene', field: 'title', from: before.title, to: after.title });
  const old = new Map(before.components.map((c) => [c.id, c]));
  for (const c of after.components) {
    const o = old.get(c.id);
    if (!o) { out.push({ componentId: c.id, name: c.name, field: 'added', from: '', to: `${c.kind} at ${c.position.join(', ')}` }); continue; }
    old.delete(c.id);
    if (o.name !== c.name) out.push({ componentId: c.id, name: c.name, field: 'name', from: o.name, to: c.name });
    if (JSON.stringify(o.material) !== JSON.stringify(c.material)) out.push({ componentId: c.id, name: c.name, field: 'material', from: describeMaterial(o.material), to: describeMaterial(c.material) });
    if (o.position.join() !== c.position.join()) out.push({ componentId: c.id, name: c.name, field: 'position', from: o.position.join(', '), to: c.position.join(', ') });
    if (o.rotation.join() !== c.rotation.join()) out.push({ componentId: c.id, name: c.name, field: 'rotation', from: o.rotation.join(', '), to: c.rotation.join(', ') });
    if (JSON.stringify(o.params) !== JSON.stringify(c.params) || o.kind !== c.kind) out.push({ componentId: c.id, name: c.name, field: 'shape', from: `${o.kind} ${JSON.stringify(o.params)}`, to: `${c.kind} ${JSON.stringify(c.params)}` });
    if ((o.label ?? '') !== (c.label ?? '')) out.push({ componentId: c.id, name: c.name, field: 'label', from: o.label ?? '', to: c.label ?? '' });
  }
  for (const o of old.values()) out.push({ componentId: o.id, name: o.name, field: 'removed', from: o.kind, to: '' });
  return out;
}

/** One plain line per component, for tool results and the inspector. */
export function describeScene(scene: Scene3D): string {
  return scene.components.map((c) => `${c.name} [${c.id}] — ${c.kind} ${Object.entries(c.params).map(([k, v]) => `${k} ${v}`).join(', ')}; ${describeMaterial(c.material)}; at ${c.position.join(', ')} mm${c.group ? `; group ${c.group}` : ''}`).join('\n');
}
