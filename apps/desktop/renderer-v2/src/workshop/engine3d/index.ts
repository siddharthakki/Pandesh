/**
 * The 3D Workshop's renderer: Babylon.js (Apache-2.0), loaded only when a 3D workshop opens.
 *
 * Builds meshes from a validated Pandesh scene (core/shared/workshop/scene3d.ts) with Babylon's own builders and its
 * physically based material, an image-based-lighting environment from a CC0 studio HDRI (Poly Haven via Blender's
 * bundled studio lights, assets/ASSETS.md), Babylon's orbit camera, picking and highlight layer, transform gizmo,
 * tone-mapping pipeline and the official glTF serializer. Nothing here runs code from a scene: a scene is numbers.
 *
 * Bundled separately (renderer/v2/workshop3d.js) and exposed as `window.PandeshWorkshop3D`, so the main window
 * never pays for the engine unless a 3D workshop is opened.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { CreateTorus } from '@babylonjs/core/Meshes/Builders/torusBuilder';
import { CreateCapsule } from '@babylonjs/core/Meshes/Builders/capsuleBuilder';
import { CreateLathe } from '@babylonjs/core/Meshes/Builders/latheBuilder';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { BackgroundMaterial } from '@babylonjs/core/Materials/Background/backgroundMaterial';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer';
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools';
import { GLTF2Export } from '@babylonjs/serializers/glTF/2.0/glTFSerializer';
import { componentExtent, explodeOffsets, sceneBounds, type Scene3D, type SceneComponent, type Vec3 } from '../../../../../../core/shared/workshop/scene3d';
import studioHdrBase64 from '../../../assets/studio_small_01_512.hdr';
import { gearGeometry } from './gearGeometry';

export const ENGINE_LABEL = 'Babylon.js 9.32.1';

export type CameraPreset = 'front' | 'top' | 'side' | 'iso' | 'reset';

export interface InspectState {
  renderer: string;
  webgl: number;
  fps: number;
  canvas: [number, number];
  meshes: Array<{ id: string; name: string; visible: boolean; position: [number, number, number]; material: { albedo: string; metallic: number | null; roughness: number | null; alpha: number }; vertices: number; triangles: number }>;
  meshCount: number;
  selected: string | null;
  exploded: number;
  autoRotate: boolean;
  labels: boolean;
  camera: { alpha: number; beta: number; radius: number; target: [number, number, number] };
  environment: string;
}

export interface Workshop3DOptions {
  canvas: HTMLCanvasElement;
  /** Absolutely positioned layer over the canvas, for the component labels. */
  labelLayer: HTMLElement;
  onSelect(componentId: string | null): void;
  onError?(message: string): void;
  /** Background colour of the viewport (#rrggbb), from the window's theme. */
  background?: string;
}

export interface Workshop3DView {
  setScene(scene: Scene3D): void;
  select(componentId: string | null): void;
  setExploded(target: number): Promise<void>;
  exploded(): number;
  setAutoRotate(on: boolean): void;
  autoRotate(): boolean;
  setLabels(on: boolean): void;
  labels(): boolean;
  setCamera(preset: CameraPreset): void;
  cameraState(): { alpha: number; beta: number; radius: number; target: [number, number, number] };
  restoreCamera(state: { alpha: number; beta: number; radius: number; target: [number, number, number] }): void;
  focus(componentId: string): boolean;
  setVisible(componentId: string, visible: boolean): void;
  isolate(componentId: string | null): void;
  setMoveGizmo(on: boolean, onMoved?: (componentId: string, position: Vec3) => void): void;
  exportGlb(fileName: string): Promise<{ bytes: Uint8Array; nodes: string[] }>;
  inspect(): InspectState;
  screenshot(width: number): Promise<string>;
  setBackground(color: string): void;
  resize(): void;
  dispose(): void;
}

const hex = (c: Color3) => c.toHexString().toLowerCase();

/** A gear as vertex data from the pure geometry module (faces wound for Babylon's left-handed normals). */
function gearVertexData(teeth: number, radius: number, thickness: number, bore: number): VertexData {
  const { positions, indices } = gearGeometry(teeth, radius, thickness, bore);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  return data;
}

function buildMesh(c: SceneComponent, scene: Scene): Mesh {
  const p = c.params;
  const name = c.name;
  switch (c.kind) {
    case 'box': return CreateBox(name, { width: p.width, height: p.height, depth: p.depth }, scene);
    case 'cylinder': return CreateCylinder(name, { diameter: p.radius * 2, height: p.height, tessellation: 64 }, scene);
    case 'cone': return CreateCylinder(name, { diameterTop: 0, diameterBottom: p.radius * 2, height: p.height, tessellation: 64 }, scene);
    case 'sphere': return CreateSphere(name, { diameter: p.radius * 2, segments: 48 }, scene);
    case 'torus': return CreateTorus(name, { diameter: p.radius * 2, thickness: p.tube * 2, tessellation: 64 }, scene);
    case 'capsule': return CreateCapsule(name, { radius: p.radius, height: Math.max(p.length, p.radius * 2), tessellation: 32, subdivisions: 4 }, scene);
    case 'tube': {
      const h = p.height / 2;
      const shape = [new Vector3(p.innerRadius, -h, 0), new Vector3(p.outerRadius, -h, 0), new Vector3(p.outerRadius, h, 0), new Vector3(p.innerRadius, h, 0), new Vector3(p.innerRadius, -h, 0)];
      // Both sides: the lathe's facing depends on the profile's direction, and a ring is seen from inside and out.
      return CreateLathe(name, { shape, tessellation: 96, closed: true, sideOrientation: Mesh.DOUBLESIDE }, scene);
    }
    case 'gear': {
      const mesh = new Mesh(name, scene);
      gearVertexData(p.teeth, p.radius, p.thickness, p.bore).applyToMesh(mesh);
      mesh.convertToFlatShadedMesh();
      return mesh;
    }
    default: return CreateBox(name, { size: 10 }, scene);
  }
}

const geometryKey = (c: SceneComponent) => `${c.kind}:${JSON.stringify(c.params)}`;
const materialKey = (c: SceneComponent) => JSON.stringify(c.material);

function applyMaterial(mat: PBRMaterial, c: SceneComponent): void {
  const m = c.material;
  mat.albedoColor = Color3.FromHexString(m.color).toLinearSpace();
  mat.metallic = m.metalness;
  mat.roughness = m.roughness;
  mat.alpha = m.opacity;
  mat.transparencyMode = m.opacity < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
  mat.anisotropy.isEnabled = m.preset === 'brushed_steel';
  if (mat.anisotropy.isEnabled) mat.anisotropy.intensity = 0.8;
  mat.backFaceCulling = m.opacity >= 1;
}

export function createWorkshop3D(options: Workshop3DOptions): Workshop3DView {
  const engine = new Engine(options.canvas, true, { stencil: true, preserveDrawingBuffer: true, premultipliedAlpha: false }, true);
  const scene = new Scene(engine);
  scene.clearColor = Color4.FromHexString(`${options.background ?? '#16181d'}ff`);
  scene.environmentTexture = new HDRCubeTexture(`data:application/octet-stream;base64,${studioHdrBase64}`, scene, 256, false, true, false, true, null, (message) => options.onError?.(`environment light could not load: ${message ?? 'unknown error'}`));
  scene.environmentIntensity = 1.35;

  const camera = new ArcRotateCamera('camera', -Math.PI / 2.4, Math.PI / 2.7, 300, Vector3.Zero(), scene);
  camera.attachControl(options.canvas, true);
  camera.wheelDeltaPercentage = 0.012;
  camera.pinchDeltaPercentage = 0.012;
  camera.panningSensibility = 40;
  camera.useNaturalPinchZoom = true;

  const key = new DirectionalLight('key', new Vector3(-0.6, -1, -0.45), scene);
  key.intensity = 2.2;
  const fill = new HemisphericLight('fill', new Vector3(0.2, 1, 0.1), scene);
  fill.intensity = 0.25;
  fill.groundColor = new Color3(0.12, 0.12, 0.14);
  const shadows = new ShadowGenerator(2048, key);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.01;
  shadows.darkness = 0.25;

  const ground = CreateGround('__ground', { width: 1, height: 1 }, scene);
  const groundMat = new BackgroundMaterial('__groundMat', scene);
  groundMat.shadowOnly = true;
  groundMat.shadowLevel = 0.45;
  groundMat.alpha = 0.9;
  ground.material = groundMat;
  ground.receiveShadows = true;
  ground.isPickable = false;

  const pipeline = new DefaultRenderingPipeline('pipeline', true, scene, [camera]);
  pipeline.samples = 4;
  pipeline.fxaaEnabled = true;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  pipeline.imageProcessing.exposure = 1.05;
  pipeline.imageProcessing.contrast = 1.08;

  const highlight = new HighlightLayer('selection', scene, { isStroke: true, blurHorizontalSize: 0.6, blurVerticalSize: 0.6 });
  highlight.innerGlow = false;

  const gizmos = new GizmoManager(scene, 1.4);
  gizmos.usePointerToAttachGizmos = false;
  gizmos.positionGizmoEnabled = false;

  let current: Scene3D | null = null;
  const meshes = new Map<string, { mesh: Mesh; geometry: string; material: string }>();
  let offsets: Record<string, Vec3> = {};
  let explodeValue = 0;
  let explodeTarget = 0;
  let explodeResolve: (() => void) | null = null;
  let selected: string | null = null;
  let labelsOn = false;
  let rotating = false;
  let isolated: string | null = null;
  const hidden = new Set<string>();
  const labelEls = new Map<string, HTMLDivElement>();
  let moveCallback: ((componentId: string, position: Vec3) => void) | undefined;
  let cameraAnim: { from: { a: number; b: number; r: number; t: Vector3 }; to: { a: number; b: number; r: number; t: Vector3 }; start: number; ms: number } | null = null;

  const componentOf = (id: string) => current?.components.find((c) => c.id === id) ?? null;

  function place(c: SceneComponent, mesh: Mesh): void {
    const o = offsets[c.id] ?? [0, 0, 0];
    mesh.position.set(c.position[0] + o[0] * explodeValue, c.position[1] + o[1] * explodeValue, c.position[2] + o[2] * explodeValue);
    const d = Math.PI / 180;
    mesh.rotation.set(c.rotation[0] * d, c.rotation[1] * d, c.rotation[2] * d);
  }

  function frameGround(): void {
    if (!current) return;
    const { center, radius } = sceneBounds(current);
    let minY = Infinity;
    for (const c of current.components) minY = Math.min(minY, c.position[1] - componentExtent(c)[1] / 2);
    ground.scaling.set(radius * 8, 1, radius * 8);
    ground.position.set(center[0], (Number.isFinite(minY) ? minY : 0) - radius * 0.02, center[2]);
    key.position = new Vector3(center[0] + radius * 2, center[1] + radius * 3, center[2] + radius * 2);
  }

  function applyVisibility(): void {
    for (const [id, entry] of meshes) entry.mesh.setEnabled(!hidden.has(id) && (!isolated || isolated === id));
  }

  function setScene(next: Scene3D): void {
    const first = current === null;
    current = next;
    offsets = explodeOffsets(next);
    const keep = new Set(next.components.map((c) => c.id));
    for (const [id, entry] of meshes) {
      if (!keep.has(id)) { shadows.removeShadowCaster(entry.mesh); highlight.removeMesh(entry.mesh); entry.mesh.material?.dispose(); entry.mesh.dispose(); meshes.delete(id); labelEls.get(id)?.remove(); labelEls.delete(id); }
    }
    // Component-level update: only a component whose shape changed is rebuilt; a material or a transform is changed in place.
    for (const c of next.components) {
      let entry = meshes.get(c.id);
      const g = geometryKey(c);
      if (entry && entry.geometry !== g) {
        shadows.removeShadowCaster(entry.mesh); highlight.removeMesh(entry.mesh); entry.mesh.material?.dispose(); entry.mesh.dispose(); meshes.delete(c.id); entry = undefined;
      }
      if (!entry) {
        const mesh = buildMesh(c, scene);
        mesh.id = c.id;
        mesh.metadata = { componentId: c.id };
        const mat = new PBRMaterial(`${c.name} material`, scene);
        applyMaterial(mat, c);
        mesh.material = mat;
        mesh.receiveShadows = true;
        shadows.addShadowCaster(mesh);
        entry = { mesh, geometry: g, material: materialKey(c) };
        meshes.set(c.id, entry);
      } else if (entry.material !== materialKey(c)) {
        applyMaterial(entry.mesh.material as PBRMaterial, c);
        entry.material = materialKey(c);
      }
      entry.mesh.name = c.name;
      place(c, entry.mesh);
    }
    applyVisibility();
    if (selected && !meshes.has(selected)) select(null); else if (selected) select(selected);
    frameGround();
    if (first) setCamera('reset', false);
    syncLabels();
  }

  function select(componentId: string | null): void {
    highlight.removeAllMeshes();
    selected = componentId && meshes.has(componentId) ? componentId : null;
    if (selected) {
      const mesh = meshes.get(selected)!.mesh;
      highlight.addMesh(mesh, Color3.FromHexString('#4c9aff'));
      if (moveCallback) gizmos.attachToMesh(mesh);
    } else gizmos.attachToMesh(null);
    for (const [id, el] of labelEls) el.classList.toggle('selected', id === selected);
  }

  scene.onPointerObservable.add((info) => {
    if (info.type !== PointerEventTypes.POINTERTAP) return;
    const hit = info.pickInfo?.hit ? info.pickInfo.pickedMesh : null;
    const id = hit?.metadata && typeof hit.metadata.componentId === 'string' ? hit.metadata.componentId as string : null;
    select(id);
    options.onSelect(id);
  });

  /** The distance at which a sphere of this radius fills the view with a margin, for the canvas's real shape. */
  function fitDistance(radius: number): number {
    const aspect = Math.max(0.2, engine.getAspectRatio(camera));
    const vertical = camera.fov;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    return (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.08;
  }

  function cameraGoal(preset: CameraPreset): { a: number; b: number; r: number; t: Vector3 } {
    const { center, radius } = current ? sceneBounds(current) : { center: [0, 0, 0] as Vec3, radius: 100 };
    const t = new Vector3(center[0], center[1], center[2]);
    const r = fitDistance(radius);
    switch (preset) {
      case 'front': return { a: -Math.PI / 2, b: Math.PI / 2.05, r, t };
      case 'top': return { a: -Math.PI / 2, b: 0.0001, r, t };
      case 'side': return { a: 0, b: Math.PI / 2.05, r, t };
      case 'iso': return { a: -Math.PI / 4, b: Math.PI / 3.3, r, t };
      default: return { a: -Math.PI / 2.4, b: Math.PI / 2.7, r, t };
    }
  }

  function setCamera(preset: CameraPreset, animate = true): void {
    const goal = cameraGoal(preset);
    const radius = current ? sceneBounds(current).radius : 100;
    camera.lowerRadiusLimit = radius * 0.25;
    camera.upperRadiusLimit = radius * 12;
    camera.minZ = Math.max(0.05, radius * 0.01);
    camera.maxZ = radius * 200;
    camera.panningSensibility = Math.max(1, 4000 / radius);
    if (!animate) { camera.alpha = goal.a; camera.beta = goal.b; camera.radius = goal.r; camera.setTarget(goal.t); cameraAnim = null; return; }
    cameraAnim = { from: { a: camera.alpha, b: camera.beta, r: camera.radius, t: camera.target.clone() }, to: goal, start: performance.now(), ms: 650 };
  }

  function syncLabels(): void {
    if (!current) return;
    for (const c of current.components) {
      let el = labelEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ws3d-label';
        el.dataset.componentId = c.id;
        options.labelLayer.appendChild(el);
        labelEls.set(c.id, el);
      }
      el.textContent = c.label ?? c.name;
      el.classList.toggle('selected', c.id === selected);
    }
    options.labelLayer.style.display = labelsOn ? 'block' : 'none';
  }

  function updateLabels(): void {
    if (!labelsOn || !current) return;
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const viewport = camera.viewport.toGlobal(width, height);
    const transform = scene.getTransformMatrix();
    const scale = options.canvas.clientWidth / Math.max(1, width);
    for (const [id, el] of labelEls) {
      const entry = meshes.get(id);
      if (!entry || !entry.mesh.isEnabled()) { el.style.display = 'none'; continue; }
      const center = entry.mesh.getBoundingInfo().boundingBox.centerWorld;
      const top = new Vector3(center.x, entry.mesh.getBoundingInfo().boundingBox.maximumWorld.y, center.z);
      const projected = Vector3.Project(top, Matrix.IdentityReadOnly, transform, viewport);
      if (projected.z < 0 || projected.z > 1) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.transform = `translate(-50%, -100%) translate(${(projected.x * scale).toFixed(1)}px, ${(projected.y * scale - 6).toFixed(1)}px)`;
    }
  }

  scene.onBeforeRenderObservable.add(() => {
    const dt = Math.min(64, engine.getDeltaTime());
    if (explodeValue !== explodeTarget && current) {
      const step = dt / 700;
      explodeValue = explodeTarget > explodeValue ? Math.min(explodeTarget, explodeValue + step) : Math.max(explodeTarget, explodeValue - step);
      for (const c of current.components) { const entry = meshes.get(c.id); if (entry) place(c, entry.mesh); }
      if (explodeValue === explodeTarget && explodeResolve) { const r = explodeResolve; explodeResolve = null; r(); }
    }
    if (cameraAnim) {
      const k = Math.min(1, (performance.now() - cameraAnim.start) / cameraAnim.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const { from, to } = cameraAnim;
      camera.alpha = from.a + (to.a - from.a) * e;
      camera.beta = from.b + (to.b - from.b) * e;
      camera.radius = from.r + (to.r - from.r) * e;
      camera.setTarget(Vector3.Lerp(from.t, to.t, e));
      if (k >= 1) cameraAnim = null;
    }
    if (rotating && !cameraAnim) camera.alpha += (dt / 1000) * 0.45;
  });
  scene.onAfterRenderObservable.add(updateLabels);

  engine.runRenderLoop(() => scene.render());

  const view: Workshop3DView = {
    setScene,
    select,
    setExploded(target: number) {
      explodeTarget = Math.max(0, Math.min(1, target));
      if (explodeValue === explodeTarget) return Promise.resolve();
      return new Promise<void>((resolve) => { explodeResolve?.(); explodeResolve = resolve; });
    },
    exploded: () => explodeValue,
    setAutoRotate(on: boolean) { rotating = on; },
    autoRotate: () => rotating,
    setLabels(on: boolean) { labelsOn = on; syncLabels(); updateLabels(); },
    labels: () => labelsOn,
    setCamera: (preset: CameraPreset) => setCamera(preset, true),
    cameraState: () => ({ alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: [camera.target.x, camera.target.y, camera.target.z] }),
    restoreCamera(state) {
      if (![state.alpha, state.beta, state.radius, ...state.target].every((n) => Number.isFinite(n))) return;
      camera.alpha = state.alpha; camera.beta = state.beta; camera.radius = state.radius; camera.setTarget(new Vector3(...state.target));
    },
    focus(componentId: string) {
      const entry = meshes.get(componentId);
      if (!entry) return false;
      const box = entry.mesh.getBoundingInfo().boundingBox;
      const size = box.maximumWorld.subtract(box.minimumWorld).length();
      cameraAnim = { from: { a: camera.alpha, b: camera.beta, r: camera.radius, t: camera.target.clone() }, to: { a: camera.alpha, b: camera.beta, r: Math.max(size * 2.2, camera.lowerRadiusLimit ?? 1), t: box.centerWorld.clone() }, start: performance.now(), ms: 600 };
      select(componentId);
      return true;
    },
    setVisible(componentId: string, visible: boolean) { if (visible) hidden.delete(componentId); else hidden.add(componentId); applyVisibility(); },
    isolate(componentId: string | null) { isolated = componentId && meshes.has(componentId) ? componentId : null; applyVisibility(); },
    setMoveGizmo(on: boolean, onMoved) {
      moveCallback = on ? onMoved : undefined;
      gizmos.positionGizmoEnabled = on;
      const g = gizmos.gizmos.positionGizmo;
      if (on && g) {
        g.onDragEndObservable.clear();
        g.onDragEndObservable.add(() => {
          if (!selected || !moveCallback || !current) return;
          const c = componentOf(selected);
          const mesh = meshes.get(selected)?.mesh;
          if (!c || !mesh) return;
          // The gizmo moved the exploded position; the stored position is that minus the explode offset.
          const o = offsets[c.id] ?? [0, 0, 0];
          const pos: Vec3 = [mesh.position.x - o[0] * explodeValue, mesh.position.y - o[1] * explodeValue, mesh.position.z - o[2] * explodeValue].map((v) => Math.round(v * 100) / 100) as Vec3;
          moveCallback(c.id, pos);
        });
      }
      gizmos.attachToMesh(on && selected ? meshes.get(selected)?.mesh ?? null : null);
    },
    async exportGlb(fileName: string) {
      // Exported assembled, as the version stores it, whatever the view shows.
      const saved = explodeValue;
      explodeValue = 0;
      if (current) for (const c of current.components) { const entry = meshes.get(c.id); if (entry) place(c, entry.mesh); }
      const exportable = new Set([...meshes.values()].map((e) => e.mesh));
      try {
        const data = await GLTF2Export.GLBAsync(scene, fileName.replace(/\.glb$/i, ''), { shouldExportNode: (node) => exportable.has(node as Mesh) });
        const blob = Object.values(data.files)[0] as Blob;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { bytes, nodes: [...meshes.values()].map((e) => e.mesh.name) };
      } finally {
        explodeValue = saved;
        if (current) for (const c of current.components) { const entry = meshes.get(c.id); if (entry) place(c, entry.mesh); }
      }
    },
    inspect(): InspectState {
      const list = [...meshes.entries()];
      return {
        renderer: ENGINE_LABEL,
        webgl: engine.webGLVersion,
        fps: Math.round(engine.getFps()),
        canvas: [engine.getRenderWidth(), engine.getRenderHeight()],
        meshes: list.slice(0, 24).map(([id, { mesh }]) => {
          const mat = mesh.material as PBRMaterial | null;
          const indices = mesh.getTotalIndices();
          return {
            id,
            name: mesh.name,
            visible: mesh.isEnabled(),
            position: [mesh.position.x, mesh.position.y, mesh.position.z].map((v) => Math.round(v * 100) / 100) as [number, number, number],
            material: { albedo: mat ? hex(mat.albedoColor.toGammaSpace()) : 'none', metallic: mat?.metallic ?? null, roughness: mat?.roughness ?? null, alpha: mat?.alpha ?? 1 },
            vertices: mesh.getTotalVertices(),
            triangles: Math.round(indices / 3),
          };
        }),
        meshCount: list.length,
        selected,
        exploded: Math.round(explodeValue * 100) / 100,
        autoRotate: rotating,
        labels: labelsOn,
        camera: { alpha: Math.round(camera.alpha * 1000) / 1000, beta: Math.round(camera.beta * 1000) / 1000, radius: Math.round(camera.radius * 10) / 10, target: [camera.target.x, camera.target.y, camera.target.z].map((v) => Math.round(v * 10) / 10) as [number, number, number] },
        environment: scene.environmentTexture?.isReady() ? 'studio_small_01 (CC0) image-based lighting, ready' : 'environment loading',
      };
    },
    screenshot: (width: number) => CreateScreenshotUsingRenderTargetAsync(engine, camera, { width, height: Math.round(width * (engine.getRenderHeight() / Math.max(1, engine.getRenderWidth()))) }, 'image/png', 4),
    setBackground(color: string) { if (/^#[0-9a-f]{6}$/i.test(color)) scene.clearColor = Color4.FromHexString(`${color}ff`); },
    resize: () => engine.resize(),
    dispose() {
      engine.stopRenderLoop();
      for (const el of labelEls.values()) el.remove();
      scene.dispose();
      engine.dispose();
    },
  };
  return view;
}

declare global {
  interface Window { PandeshWorkshop3D?: { createWorkshop3D: typeof createWorkshop3D; ENGINE_LABEL: string } }
}

window.PandeshWorkshop3D = { createWorkshop3D, ENGINE_LABEL };
