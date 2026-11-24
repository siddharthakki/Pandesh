/**
 * The 3D scene runtime (three.js, MIT), for scene pages in the Workshop's sandboxed preview.
 *
 * A scene page holds one function written for the request: `PandeshScene.run(function (THREE, kit) { ... })`. This file is
 * everything around it, the same for every scene: the renderer, sky, sun with shadows, orbit camera, the panel with a
 * toggle for each named group, and the reports to the Workshop (what was drawn, errors, a picture on request).
 *
 * It runs only inside the preview frame (host/designPreview.ts): an opaque origin with no network, no access to the
 * window, files or storage. The host inlines this file when it serves a scene page; nothing is fetched.
 * Plain JavaScript on purpose: it is bundled as one classic script (renderer/v2/sceneRuntime.js).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { installAssets } from './assets.js';

const NONCE = typeof window.__PANDESH_SCENE_NONCE === 'string' ? window.__PANDESH_SCENE_NONCE : '';
const post = (kind, data) => { try { window.parent.postMessage({ pandeshPreview: NONCE, kind, data }, '*'); } catch { /* no parent: opened on its own */ } };

// ------------------------------------------------------------------ helpers the scene code may use

function seeded(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function canvasTexture(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const shade = (hex, f) => { const c = new THREE.Color(hex).multiplyScalar(f); return `rgb(${Math.round(Math.min(1, c.r) * 255)}, ${Math.round(Math.min(1, c.g) * 255)}, ${Math.round(Math.min(1, c.b) * 255)})`; };

/** Painted surfaces: no image files, so nothing is loaded from anywhere. One tile is about one metre. */
const SURFACES = {
  brick: (base = '#a84e3a') => canvasTexture(512, (g, n) => {
    const rnd = seeded(7); g.fillStyle = '#d9cfc0'; g.fillRect(0, 0, n, n);
    const rows = 8; const cols = 4; const bh = n / rows; const bw = n / cols;
    for (let r = 0; r < rows; r++) for (let c = -1; c <= cols; c++) { g.fillStyle = shade(base, 0.82 + rnd() * 0.3); g.fillRect(c * bw + (r % 2 ? bw / 2 : 0) + 3, r * bh + 3, bw - 6, bh - 6); }
  }),
  roof: (base = '#964a3a') => canvasTexture(512, (g, n) => {
    const rnd = seeded(23); g.fillStyle = shade(base, 0.55); g.fillRect(0, 0, n, n);
    const rows = 10; const cols = 8; const th = n / rows; const tw = n / cols;
    for (let r = 0; r < rows; r++) for (let c = -1; c <= cols; c++) {
      const x = c * tw + (r % 2 ? tw / 2 : 0);
      g.fillStyle = shade(base, 0.85 + rnd() * 0.28); g.beginPath(); g.roundRect(x + 2, r * th + 2, tw - 4, th - 3, [0, 0, 10, 10]); g.fill();
      g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(x + 2, r * th + th - 6, tw - 4, 4);
    }
  }),
  grass: (base = '#5f9a3d') => canvasTexture(512, (g, n) => {
    const rnd = seeded(31); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 9000; i++) { g.strokeStyle = shade(base, 0.7 + rnd() * 0.7); g.globalAlpha = 0.55; const x = rnd() * n; const y = rnd() * n; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 5, y - 3 - rnd() * 6); g.stroke(); }
    g.globalAlpha = 1;
  }),
  wood: (base = '#b98a56') => canvasTexture(512, (g, n) => {
    const rnd = seeded(43); g.fillStyle = base; g.fillRect(0, 0, n, n);
    const boards = 8; const bw = n / boards;
    for (let b = 0; b < boards; b++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '70,40,10' : '255,230,190'}, ${0.06 + rnd() * 0.1})`; g.fillRect(b * bw, 0, bw, n); g.fillStyle = 'rgba(40,22,8,.45)'; g.fillRect(b * bw, 0, 2, n); }
  }),
  paving: (base = '#c9c2b4') => canvasTexture(256, (g, n) => {
    g.fillStyle = shade(base, 0.6); g.fillRect(0, 0, n, n); const h = n / 2;
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) { g.fillStyle = shade(base, (r + c) % 2 ? 1 : 0.9); g.fillRect(c * h + 3, r * h + 3, h - 6, h - 6); }
  }),
  soil: (base = '#4a3323') => canvasTexture(256, (g, n) => {
    const rnd = seeded(67); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 2200; i++) { g.fillStyle = shade(base, 0.5 + rnd() * 1.4); g.globalAlpha = 0.4; g.fillRect(rnd() * n, rnd() * n, 3, 3); }
    g.globalAlpha = 1;
  }),
  sand: (base = '#e3cf9f') => canvasTexture(256, (g, n) => {
    const rnd = seeded(71); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 3000; i++) { g.fillStyle = shade(base, 0.8 + rnd() * 0.35); g.fillRect(rnd() * n, rnd() * n, 2, 2); }
  }),
  water: (base = '#3f8fc4') => canvasTexture(256, (g, n) => {
    const rnd = seeded(79); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 260; i++) { g.strokeStyle = shade(base, 1.1 + rnd() * 0.4); g.globalAlpha = 0.5; const x = rnd() * n; const y = rnd() * n; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 14, y - 5, x + 28, y); g.stroke(); }
    g.globalAlpha = 1;
  }),
  stone: (base = '#9a948a') => canvasTexture(256, (g, n) => {
    const rnd = seeded(83); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 1800; i++) { g.fillStyle = shade(base, 0.7 + rnd() * 0.6); g.globalAlpha = 0.35; g.fillRect(rnd() * n, rnd() * n, 4, 4); }
    g.globalAlpha = 1;
  }),
  asphalt: (base = '#44474b') => canvasTexture(256, (g, n) => {
    const rnd = seeded(89); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 2600; i++) { g.fillStyle = shade(base, 0.7 + rnd() * 0.7); g.fillRect(rnd() * n, rnd() * n, 2, 2); }
  }),
};

const vec = (p) => (Array.isArray(p) ? p : [0, 0, 0]);

function createKit(scene, camera, controls, sun, state) {
  const mat = (color = '#cccccc', o = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: o.roughness ?? 0.8, metalness: o.metalness ?? 0 });
    if (o.opacity !== undefined && o.opacity < 1) { m.transparent = true; m.opacity = o.opacity; m.depthWrite = false; m.side = THREE.DoubleSide; }
    if (o.emissive) { m.emissive = new THREE.Color(o.emissive); m.emissiveIntensity = o.emissiveIntensity ?? 1; }
    if (o.surface && SURFACES[o.surface]) { const t = SURFACES[o.surface](o.surfaceColor ?? (typeof color === 'string' ? color : undefined)); t.repeat.set(o.repeat?.[0] ?? 1, o.repeat?.[1] ?? 1); m.map = t; m.color = new THREE.Color('#ffffff'); }
    return m;
  };
  const asMat = (c) => (c && c.isMaterial ? c : mat(c));
  const mesh = (geometry, color, position) => { const m = new THREE.Mesh(geometry, asMat(color)); m.position.set(...vec(position)); return m; };
  const kit = {
    THREE, scene, camera, controls,
    /** A material: mat('#aa3322', { roughness, metalness, opacity, emissive, surface: 'brick'|'roof'|'grass'|'wood'|'paving'|'soil'|'sand'|'water'|'stone'|'asphalt', repeat: [x, y] }). */
    mat,
    box: (w, h, d, color, position) => mesh(new THREE.BoxGeometry(w, h, d), color, position),
    cylinder: (radiusTop, radiusBottom, height, color, position, segments = 24) => mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), color, position),
    cone: (radius, height, color, position, segments = 20) => mesh(new THREE.ConeGeometry(radius, height, segments), color, position),
    sphere: (radius, color, position) => mesh(new THREE.SphereGeometry(radius, 24, 16), color, position),
    /** A flat outline pushed into depth: extrude([[x, y], ...], depth, color, [x, y, z]). The outline is in X/Y, the depth along Z, centred. */
    extrude(points, depth = 1, color, position) {
      const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(Number(p[0]) || 0, Number(p[1]) || 0)));
      const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }); g.translate(0, 0, -depth / 2);
      return mesh(g, color, position);
    },
    /** A profile spun round the Y axis: lathe([[radius, y], ...], color, [x, y, z]) for towers, vases, bottles, domes, wheels. */
    lathe(profile, color, position, segments = 32) {
      const m = mesh(new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(Math.max(0, Number(p[0]) || 0), Number(p[1]) || 0)), segments), color, position);
      m.material.side = THREE.DoubleSide; return m;
    },
    /** A round bar along a path: tube([[x, y, z], ...], radius, color) for ropes, pipes, rails, arches, branches. */
    tube(points, radius = 0.05, color) {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...vec(p))));
      return mesh(new THREE.TubeGeometry(curve, Math.max(8, points.length * 8), radius, 10, false), color);
    },
    /** A named part of the scene with its own Show toggle in the panel. Returns a THREE.Group already in the scene. */
    group(name) {
      const key = String(name || 'Scene').slice(0, 40);
      if (!state.groups.has(key)) { const g = new THREE.Group(); g.name = key; scene.add(g); state.groups.set(key, g); }
      return state.groups.get(key);
    },
    /** add(object) or add(object, 'Group name'). */
    add(object, groupName) { (groupName ? kit.group(groupName) : scene).add(object); return object; },
    /** A flat ground: ground(60, '#5f9a3d', 'grass'). */
    ground(size = 60, color = '#5f9a3d', surface = null) {
      const reach = Math.max(Number(size) || 60, 900);
      const g = new THREE.Mesh(new THREE.PlaneGeometry(reach, reach), mat(color, surface ? { surface, repeat: [reach / 3, reach / 3], roughness: 1 } : { roughness: 1 }));
      g.rotation.x = -Math.PI / 2; g.name = 'ground'; g.userData.noCast = true; scene.add(g);
      state.ground = { color: String(color), surface: surface ? String(surface) : null }; return g;
    },
    sky(top = '#5fa8e6', horizon = '#eef6fb') {
      // A dome, not a flat backdrop: the pale band sits at the real horizon, where the ground fades into it.
      const c = document.createElement('canvas'); c.width = 8; c.height = 512; const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, 512); grad.addColorStop(0, top); grad.addColorStop(0.455, top); grad.addColorStop(0.5, horizon); grad.addColorStop(1, horizon); g.fillStyle = grad; g.fillRect(0, 0, 8, 512);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      if (state.dome) scene.remove(state.dome);
      state.dome = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 24), new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false }));
      state.dome.name = 'sky'; state.dome.userData.noCast = true; scene.add(state.dome);
      scene.background = new THREE.Color(horizon); state.horizon = horizon; if (scene.fog) scene.fog.color.set(horizon);
    },
    sun(position = [18, 26, 16], intensity = 3.2, color = '#fff3dd') { sun.position.set(...vec(position)); sun.intensity = intensity; sun.color = new THREE.Color(color); },
    /** Where the camera starts: view([14, 9, 22], [0, 3, 0]). Without it the camera frames everything. */
    view(position, target = [0, 0, 0]) { camera.position.set(...vec(position)); controls.target.set(...vec(target)); controls.update(); state.viewSet = true; },
    /** Called every frame with seconds since start and since the last frame. */
    animate(fn) { if (typeof fn === 'function') state.animations.push(fn); },
    /**
     * A wall along X from -length/2 to +length/2, standing on y = 0, with real openings.
     * wall({ length, height, thickness, color, surface, openings: [{ x, w, y, h, kind: 'window' | 'door' | 'glassdoor' | 'gap' }] })
     */
    wall({ length = 6, height = 3, thickness = 0.25, color = '#f1e9da', surface = null, openings = [], frameColor = '#ffffff', doorColor = '#2f5d50' } = {}) {
      const group = new THREE.Group(); group.name = 'wall';
      const piece = (x0, x1, y0, y1) => {
        const w = x1 - x0; const h = y1 - y0; if (w <= 0.001 || h <= 0.001) return;
        group.add(kit.box(w, h, thickness, mat(color, surface ? { surface, repeat: [w, h / 0.6] } : {}), [(x0 + x1) / 2, (y0 + y1) / 2, 0]));
      };
      let cursor = -length / 2;
      for (const o of [...openings].sort((a, b) => a.x - b.x)) {
        const x0 = o.x - o.w / 2; const x1 = o.x + o.w / 2; const oy = o.y ?? 0;
        piece(cursor, x0, 0, height); piece(x0, x1, 0, oy); piece(x0, x1, oy + o.h, height); cursor = x1;
        if (o.kind === 'gap') continue;
        const frame = mat(frameColor, { roughness: 0.5 }); const bar = 0.09; const depth = thickness + 0.08; const cy = oy + o.h / 2;
        group.add(kit.box(o.w, bar, depth, frame, [o.x, oy + o.h - bar / 2, 0]));
        group.add(kit.box(bar, o.h, depth, frame, [o.x - o.w / 2 + bar / 2, cy, 0]));
        group.add(kit.box(bar, o.h, depth, frame, [o.x + o.w / 2 - bar / 2, cy, 0]));
        const glass = () => { const p = new THREE.Mesh(new THREE.PlaneGeometry(o.w - bar * 2, o.h - bar * 2), mat('#cfe6f2', { opacity: 0.28, roughness: 0.05 })); p.position.set(o.x, cy, 0); p.name = 'glass'; return p; };
        if (o.kind === 'door') {
          group.add(kit.box(o.w - bar * 2, o.h - bar, 0.07, mat(doorColor, { roughness: 0.55 }), [o.x, oy + (o.h - bar) / 2, 0.02]));
          group.add(kit.sphere(0.05, mat('#c9a54a', { metalness: 0.9, roughness: 0.3 }), [o.x + o.w / 2 - 0.24, oy + o.h * 0.47, 0.1]));
        } else {
          group.add(kit.box(o.w, bar, depth, frame, [o.x, oy + bar / 2, 0]));
          group.add(kit.box(0.05, o.h - bar * 2, 0.06, frame, [o.x, cy, 0]));
          if (o.kind !== 'glassdoor') { group.add(kit.box(o.w - bar * 2, 0.05, 0.06, frame, [o.x, cy + o.h * 0.12, 0])); group.add(kit.box(o.w + 0.24, 0.07, thickness + 0.3, mat('#e9e4da'), [o.x, oy - 0.035, 0.06])); }
          group.add(glass());
        }
      }
      piece(cursor, length / 2, 0, height);
      return group;
    },
    /** A gable roof over a width × depth footprint, ridge along X: gableRoof({ width, depth, rise, overhang, color, surface }). Its base is at y = 0. */
    gableRoof({ width = 10, depth = 8, rise = 2.7, overhang = 0.6, color = '#964a3a', surface = 'roof', gableColor = '#f1e9da' } = {}) {
      const g = new THREE.Group(); g.name = 'roof';
      const run = depth / 2 + overhang; const angle = Math.atan2(rise, run); const slope = Math.hypot(run, rise);
      for (const side of [1, -1]) {
        const slab = kit.box(width + 2 * overhang, 0.16, slope, mat(color, surface ? { surface, repeat: [(width + 2 * overhang) / 2, slope / 2] } : {}), [0, rise / 2, side * run / 2]);
        slab.rotation.x = side * angle; g.add(slab);
      }
      g.add(kit.box(width + 2 * overhang + 0.06, 0.14, 0.34, mat(color), [0, rise + 0.03, 0]));
      const tri = new THREE.Shape(); const gableRise = rise * (depth / 2) / run;
      tri.moveTo(-depth / 2, 0); tri.lineTo(depth / 2, 0); tri.lineTo(0, gableRise); tri.closePath();
      for (const side of [1, -1]) {
        const gable = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 0.25, bevelEnabled: false }), mat(gableColor));
        gable.rotation.y = Math.PI / 2; gable.position.set(side * (width / 2) - (side > 0 ? 0.25 : 0), 0, 0); g.add(gable);
      }
      return g;
    },
    /** tree('oak' | 'spruce' | 'apple' | 'palm' | 'birch', scale). Stands on y = 0. */
    tree(kind = 'oak', scale = 1) {
      const g = new THREE.Group(); g.name = `tree-${kind}`;
      if (kind === 'spruce' || kind === 'pine' || kind === 'fir') {
        g.add(kit.cylinder(0.16, 0.24, 1.6, '#5a3d27', [0, 0.8, 0], 10));
        [[2.0, 2.4, 2.0], [1.65, 2.2, 3.3], [1.3, 2.0, 4.5], [0.95, 1.8, 5.6], [0.6, 1.6, 6.6]].forEach(([r, h, y], i) => g.add(kit.cone(r, h, i % 2 ? '#256b44' : '#1f5a3a', [0, y, 0], 14)));
      } else if (kind === 'palm') {
        for (let i = 0; i < 8; i++) g.add(kit.cylinder(0.2 - i * 0.008, 0.22 - i * 0.008, 0.75, '#8a6a45', [Math.sin(i * 0.12) * 0.5, 0.375 + i * 0.72, 0], 10));
        for (let i = 0; i < 9; i++) { const leaf = kit.cone(0.38, 3.2, '#3f8f3a', [0, 0, 0], 6); const a = (i / 9) * Math.PI * 2; leaf.scale.set(1, 1, 0.25); leaf.position.set(0.45 + Math.cos(a) * 1.3, 5.8, Math.sin(a) * 1.3); leaf.rotation.z = -Math.cos(a) * 1.25; leaf.rotation.x = Math.sin(a) * 1.25; g.add(leaf); }
      } else if (kind === 'apple') {
        g.add(kit.cylinder(0.2, 0.3, 2.0, '#7a5536', [0, 1.0, 0], 10));
        g.add(kit.sphere(1.75, '#5fa046', [0, 3.3, 0])); g.add(kit.sphere(1.2, '#6fb152', [0.9, 3.0, 0.7])); g.add(kit.sphere(1.15, '#559640', [-0.9, 3.1, -0.5]));
        const rnd = seeded(101);
        for (let i = 0; i < 24; i++) { const a = rnd() * Math.PI * 2; const b = (rnd() - 0.35) * 1.3; g.add(kit.sphere(0.11, mat('#d62828', { roughness: 0.4 }), [Math.cos(a) * Math.cos(b) * 1.78, 3.3 + Math.sin(b) * 1.78, Math.sin(a) * Math.cos(b) * 1.78])); }
      } else {
        const birch = kind === 'birch';
        g.add(kit.cylinder(birch ? 0.14 : 0.32, birch ? 0.2 : 0.48, birch ? 4.2 : 3.2, birch ? '#e8e4da' : '#6b4a2f', [0, birch ? 2.1 : 1.6, 0], 12));
        const leaf = birch ? ['#8cc152', '#a0d468'] : ['#3f7d32', '#4b8f3a', '#356b2b'];
        [[0, 5.0, 0, 1.9], [1.5, 4.5, 0.3, 1.4], [-1.4, 4.6, 0.6, 1.45], [0.3, 4.4, -1.5, 1.4], [-0.5, 5.7, -0.4, 1.3], [0.9, 5.6, 0.9, 1.15]]
          .forEach(([x, y, z, r], i) => { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r * (birch ? 0.7 : 1), 2), mat(leaf[i % leaf.length])); m.position.set(x * (birch ? 0.6 : 1), y + (birch ? 0.4 : 0), z * (birch ? 0.6 : 1)); g.add(m); });
      }
      g.scale.setScalar(scale); return g;
    },
    /** A bed of soil planted with flowers: flowerBed(width, depth, ['#e63946', '#ffb703']). */
    flowerBed(width = 2, depth = 1, palette = ['#e63946', '#ff8fab', '#ffb703', '#9d4edd', '#ffffff']) {
      const g = new THREE.Group(); g.name = 'flower-bed'; const rnd = seeded(Math.round(width * 100 + depth * 10));
      g.add(kit.box(width, 0.18, depth, mat('#4a3323', { surface: 'soil', repeat: [width, depth] }), [0, 0.09, 0]));
      const cols = Math.max(2, Math.round(width / 0.36)); const rows = Math.max(2, Math.round(depth / 0.36));
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const x = -width / 2 + (i + 0.5) * (width / cols) + (rnd() - 0.5) * 0.12; const z = -depth / 2 + (j + 0.5) * (depth / rows) + (rnd() - 0.5) * 0.12; const h = 0.32 + rnd() * 0.3;
        g.add(kit.cylinder(0.014, 0.018, h, '#3d8b37', [x, 0.18 + h / 2, z], 5)); g.add(kit.sphere(0.1, '#4c9a3f', [x, 0.24, z]));
        const head = kit.sphere(0.09 + rnd() * 0.04, palette[Math.floor(rnd() * palette.length)], [x, 0.2 + h, z]); head.scale.y = 0.7; head.name = 'flower'; g.add(head);
      }
      return g;
    },
    /** A picket fence from [x0, z0] to [x1, z1]. */
    fence(from = [-5, 5], to = [5, 5], color = '#f6f3ec') {
      const g = new THREE.Group(); g.name = 'fence'; const [x0, z0] = from; const [x1, z1] = to;
      const len = Math.hypot(x1 - x0, z1 - z0); const n = Math.max(1, Math.round(len / 0.28)); const ang = Math.atan2(x1 - x0, z1 - z0);
      for (let i = 0; i <= n; i++) { const t = i / n; const p = kit.box(0.09, 0.95, 0.03, color, [x0 + (x1 - x0) * t, 0.5, z0 + (z1 - z0) * t]); p.rotation.y = ang + Math.PI / 2; g.add(p); }
      for (const y of [0.3, 0.72]) { const rail = kit.box(0.05, 0.06, len, color, [(x0 + x1) / 2, y, (z0 + z1) / 2]); rail.rotation.y = ang; g.add(rail); }
      return g;
    },
  };
  installAssets(kit, { SURFACES, canvasTexture, shade, seeded, state });
  // Simple shapes that stand in for something a renderer with real assets can replace (a tree, a bush, a rock…): each
  // carries its kind, so an export can leave it out and say where it stood.
  for (const [name, kind] of [['tree', 'tree'], ['shrub', 'shrub'], ['hedge', 'hedge'], ['rock', 'rock'], ['lamp', 'lamp'], ['patioSet', 'tableset'], ['cloud', 'cloud']]) {
    const make = kit[name]; if (typeof make !== 'function') continue;
    kit[name] = (...args) => { const o = make(...args); if (o && o.userData) o.userData.standIn = kind; return o; };
  }
  return kit;
}

// ------------------------------------------------------------------ the page around the scene

const STYLE = `html,body{margin:0;height:100%;overflow:hidden;background:#bcd9f2;font:14px/1.4 system-ui,"Segoe UI",sans-serif;color:#1c2430}canvas{display:block;width:100%;height:100%}
#ps-panel{position:fixed;top:10px;left:10px;max-width:220px;max-height:calc(100% - 20px);overflow:auto;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.92);box-shadow:0 6px 24px rgba(20,40,70,.22)}
#ps-panel h1{margin:0 0 6px;font-size:14px}#ps-panel label{display:flex;align-items:center;gap:8px;padding:2px 0;cursor:pointer}#ps-panel input{width:16px;height:16px}
#ps-panel button{font:inherit;margin-top:6px;padding:5px 8px;border:1px solid #c4ccd6;border-radius:8px;background:#fff;cursor:pointer}#ps-panel button[aria-pressed=true]{background:#1f6f5c;border-color:#1f6f5c;color:#fff}
#ps-hint{margin:6px 0 0;font-size:12px;color:#5a6675}#ps-panel h1{cursor:pointer;display:flex;justify-content:space-between;gap:10px}#ps-panel h1::after{content:"▾";color:#5a6675}#ps-panel.closed h1{margin:0}#ps-panel.closed h1::after{content:"▸"}#ps-panel.closed>:not(h1){display:none}#ps-error{position:fixed;left:10px;right:10px;bottom:10px;padding:10px 12px;border-radius:10px;background:#fde8e6;color:#8a1c12;white-space:pre-wrap}`;

function run(build) {
  const state = { groups: new Map(), animations: [], viewSet: false, frames: 0, error: null, rotating: false, clouds: 0, horizon: '#eef6fb' };
  const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
  const showError = (message) => { state.error = String(message).slice(0, 400); let el = document.getElementById('ps-error'); if (!el) { el = document.createElement('div'); el.id = 'ps-error'; el.setAttribute('role', 'alert'); document.body.appendChild(el); } el.textContent = `This scene could not be drawn: ${state.error}`; };

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); } catch (err) { showError(`3D graphics (WebGL) are not available here: ${err?.message ?? err}`); post('scene', { ok: false, error: state.error }); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI / 2 - 0.02;
  scene.add(new THREE.HemisphereLight('#dcecff', '#7d8f5c', 1.15));
  const sun = new THREE.DirectionalLight('#fff3dd', 3.2); sun.position.set(18, 26, 16); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun);
  const kit = createKit(scene, camera, controls, sun, state);
  kit.sky();
  // Soft reflections for glass, paint and metal, from a neutral room: no image is loaded.
  try { const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.45; pmrem.dispose(); } catch { /* reflections are a nicety */ }

  try { build(THREE, kit); } catch (err) { showError(err?.message ?? err); post('scene', { ok: false, error: state.error }); return; }

  // Everything drawn: shadows on, the sun's shadow box and the camera fitted to what is there.
  let meshes = 0; let triangles = 0;
  scene.traverse((o) => {
    if (!o.isMesh || o.name === 'sky') return;
    meshes += 1; const g = o.geometry; triangles += Math.round((g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3);
    const clear = Array.isArray(o.material) ? false : o.material?.transparent;
    o.castShadow = !clear && !o.userData.noCast; o.receiveShadow = true;
  });
  // The camera is fitted to the things in the scene, not to the land or water they stand on: a sea 200 m wide would
  // otherwise leave a lighthouse a few pixels tall. Wide flat meshes and inside-out shells (sky domes) count only when
  // they are no larger than about twice the rest.
  const bounds = new THREE.Box3(); const wide = []; const one = new THREE.Box3(); const extent = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || o.name === 'ground' || o.name === 'sky') return;
    one.setFromObject(o); if (one.isEmpty()) return; one.getSize(extent);
    const shell = !Array.isArray(o.material) && o.material?.side === THREE.BackSide;
    if (shell || extent.y < 0.04 * Math.max(extent.x, extent.z)) wide.push(one.clone()); else bounds.union(one);
  });
  if (bounds.isEmpty()) for (const b of wide) bounds.union(b);
  else { bounds.getSize(extent); const reach = Math.max(extent.x, extent.z, extent.y) * 2; for (const b of wide) { const e = b.getSize(new THREE.Vector3()); if (Math.max(e.x, e.z) <= reach) bounds.union(b); } }
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 1, 1));
  const size = bounds.getSize(new THREE.Vector3()); const center = bounds.getCenter(new THREE.Vector3()); const radius = Math.max(1, size.length() / 2);
  Object.assign(sun.shadow.camera, { left: -radius * 1.3, right: radius * 1.3, top: radius * 1.3, bottom: -radius * 1.3, near: 0.5, far: radius * 8 + 60 });
  sun.target.position.copy(center); scene.add(sun.target);
  if (sun.position.length() < radius * 1.5) sun.position.setLength(radius * 2.5);
  sun.shadow.camera.updateProjectionMatrix();
  // In a tall, narrow panel the same distance would cut the sides off: stand further back.
  const back = () => Math.max(1, 0.95 / camera.aspect);
  const home = () => { const k = back(); camera.position.set(center.x + radius * 1.25 * k, center.y + radius * 0.85 * k, center.z + radius * 1.7 * k); controls.target.copy(center); controls.update(); };
  // A starting view that was asked for is kept only when it can see the scene: not inside it, not from far away.
  const asked = camera.position.distanceTo(center);
  if (!state.viewSet || asked < radius * 0.6 || asked > radius * 5) home();
  const homeState = { position: camera.position.clone(), target: controls.target.clone() };
  controls.minDistance = Math.max(0.5, radius * 0.15); controls.maxDistance = radius * 8;
  camera.far = Math.max(4000, radius * 30); camera.updateProjectionMatrix();
  if (!scene.fog) scene.fog = new THREE.Fog(state.horizon, radius * 5, radius * 22);
  // A few clouds far off, unless the scene brought its own. They are scenery: not counted, not framed.
  if (state.clouds === 0) {
    const rnd = seeded(5); const backdrop = new THREE.Group(); backdrop.name = 'backdrop';
    for (let i = 0; i < 7; i++) { const c = kit.cloud(Math.max(1.5, radius * 0.16) * (0.7 + rnd() * 0.7)); const a = (i / 7) * Math.PI * 2 + rnd(); const d = radius * (3 + rnd() * 3); c.position.set(center.x + Math.cos(a) * d, center.y + radius * (1.3 + rnd() * 0.9) + 8, center.z + Math.sin(a) * d); c.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.fog = false; } }); backdrop.add(c); }
    scene.add(backdrop);
  }

  // Panel: one toggle per named group, slow turn, and the camera hint.
  const panel = document.createElement('div'); panel.id = 'ps-panel'; panel.setAttribute('aria-label', 'View controls');
  const h = document.createElement('h1'); h.textContent = document.title || '3D scene'; h.setAttribute('role', 'button'); h.tabIndex = 0; h.title = 'Show or hide the controls'; panel.appendChild(h);
  // In a narrow pane the controls start folded away, so they do not cover the scene.
  const fold = (closed) => { panel.classList.toggle('closed', closed); h.setAttribute('aria-expanded', String(!closed)); };
  h.addEventListener('click', () => fold(!panel.classList.contains('closed')));
  h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold(!panel.classList.contains('closed')); } });
  fold(window.innerWidth < 620);
  const setGroup = (name, on) => { const g = state.groups.get(name); if (!g) return false; g.visible = Boolean(on); const box = panel.querySelector(`input[data-group="${CSS.escape(name)}"]`); if (box) box.checked = g.visible; return true; };
  for (const [name] of state.groups) {
    const label = document.createElement('label'); const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true; box.dataset.group = name;
    box.addEventListener('change', () => setGroup(name, box.checked)); label.append(box, document.createTextNode(name)); panel.appendChild(label);
  }
  const turn = document.createElement('button'); turn.type = 'button'; turn.textContent = 'Turn slowly'; turn.setAttribute('aria-pressed', 'false');
  const setRotating = (on) => { state.rotating = Boolean(on); controls.autoRotate = state.rotating; controls.autoRotateSpeed = 1.2; turn.setAttribute('aria-pressed', String(state.rotating)); };
  turn.addEventListener('click', () => setRotating(!state.rotating)); panel.appendChild(turn);
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset view'; reset.style.marginLeft = '6px';
  reset.addEventListener('click', () => { camera.position.copy(homeState.position); controls.target.copy(homeState.target); controls.update(); }); panel.appendChild(reset);
  const hint = document.createElement('p'); hint.id = 'ps-hint'; hint.textContent = 'Drag to orbit · wheel to zoom · right-drag to move'; panel.appendChild(hint);
  document.body.appendChild(panel);

  window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    for (const fn of state.animations) { try { fn(clock.elapsedTime, dt); } catch (err) { state.animations.length = 0; showError(`animation: ${err?.message ?? err}`); post('scene', facts()); } }
    controls.update(); renderer.render(scene, camera); state.frames += 1;
  });

  const round = (v) => Math.round(v * 100) / 100;
  function facts() {
    const groups = [...state.groups.entries()].map(([name, g]) => { let n = 0; g.traverse((o) => { if (o.isMesh) n += 1; }); return { name, meshes: n, visible: g.visible }; });
    return {
      ok: !state.error, error: state.error, engine: `three.js r${THREE.REVISION}`, meshes, triangles, groups,
      size: [round(size.x), round(size.y), round(size.z)], lights: (() => { let n = 0; scene.traverse((o) => { if (o.isLight) n += 1; }); return n; })(),
      shadows: renderer.shadowMap.enabled, animated: state.animations.length > 0, frames: state.frames, rotating: state.rotating,
      camera: camera.position.toArray().map(round), target: controls.target.toArray().map(round),
    };
  }
  const VIEWS = { front: [0.15, 0.45, 2.1], back: [-0.15, 0.45, -2.1], side: [2.1, 0.45, 0.15], top: [0.01, 2.6, 0.2], iso: [1.25, 0.85, 1.7] };
  const setView = (name) => { if (name === 'reset') { camera.position.copy(homeState.position); controls.target.copy(homeState.target); controls.update(); return true; } const v = VIEWS[name]; if (!v) return false; const k = back(); camera.position.set(center.x + radius * v[0] * k, center.y + radius * v[1] * k, center.z + radius * v[2] * k); controls.target.copy(center); controls.update(); return true; };
  // A picture of the scene at a fixed 16:10 size, whatever shape the panel has, from the named side. The person's own
  // camera and the canvas on screen are put back exactly as they were.
  const shot = (width = 1024, view = null) => {
    const w = Math.max(320, Math.min(1600, Math.round(width) || 1024)); const hgt = Math.round(w * 0.625);
    const keep = { position: camera.position.clone(), target: controls.target.clone(), aspect: camera.aspect, ratio: renderer.getPixelRatio() };
    renderer.setPixelRatio(1); renderer.setSize(w, hgt, false); camera.aspect = w / hgt; camera.updateProjectionMatrix();
    if (view) setView(view);
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/jpeg', 0.88);
    renderer.setPixelRatio(keep.ratio); renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = keep.aspect; camera.updateProjectionMatrix();
    camera.position.copy(keep.position); controls.target.copy(keep.target); controls.update(); renderer.render(scene, camera);
    return { dataUrl, width: w, height: hgt };
  };
  /**
   * The scene as one binary glTF, for a renderer outside this page. Ground, sky, lights and backdrop clouds are left out
   * (the other renderer has its own), and so is every stand-in whose kind is in `replace`: those come back as a list of
   * what stood where, how large, and turned how far.
   */
  const exportModel = async (replace = []) => {
    const swap = new Set(replace.map(String)); const hidden = []; const standIns = [];
    const hide = (o) => { if (o.visible) { o.visible = false; hidden.push(o); } };
    const box = new THREE.Box3(); const v = new THREE.Vector3();
    scene.traverse((o) => {
      if (o.isLight || o.name === 'ground' || o.name === 'sky' || o.name === 'backdrop') { hide(o); return; }
      const kind = o.userData && o.userData.standIn;
      if (!kind || !(swap.has(kind) || kind === 'cloud')) return;
      for (let p = o.parent; p; p = p.parent) if (p.userData && p.userData.standIn && swap.has(p.userData.standIn)) return;
      if (kind !== 'cloud' && o.visible) {
        // Its size is measured unturned, so a hedge reports its real length and thickness.
        const turn = o.rotation.y; o.rotation.y = 0; o.updateMatrixWorld(true); box.setFromObject(o); const s = box.getSize(v).toArray();
        o.rotation.y = turn; o.updateMatrixWorld(true); const at = o.getWorldPosition(new THREE.Vector3());
        if (Number.isFinite(s[0] + s[1] + s[2])) standIns.push({ kind, name: String(o.name || '').slice(0, 40), x: round(at.x), z: round(at.z), base: round(box.min.y), w: round(s[0]), h: round(s[1]), d: round(s[2]), turn: round(turn) });
      }
      hide(o);
    });
    try {
      const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
      return { glb, standIns: standIns.slice(0, 600), ground: state.ground ?? null, center: center.toArray().map(round), radius: round(radius), size: [round(size.x), round(size.y), round(size.z)] };
    } finally { for (const o of hidden) o.visible = true; }
  };
  window.PandeshScene.api = { facts, setGroup, setRotating, setView, shot, exportModel, scene, camera, renderer };

  // Requests from the Workshop (only with this page's nonce): facts, a picture, a group toggle, a camera view.
  window.addEventListener('message', (e) => {
    const d = e.data; if (e.source !== window.parent || !d || d.pandeshPreview !== NONCE) return;
    if (d.kind === 'scene-facts') post('scene', facts());
    else if (d.kind === 'scene-shot') requestAnimationFrame(() => post('shot', { id: d.id, view: d.view ?? null, ...shot(Number(d.width) || 1024, d.view ? String(d.view) : null) }));
    else if (d.kind === 'scene-group') post('scene', { ...facts(), changed: setGroup(String(d.group), d.on !== false) });
    else if (d.kind === 'scene-view') post('scene', { ...facts(), changed: setView(String(d.view)) });
    else if (d.kind === 'scene-rotate') { setRotating(d.on !== false); post('scene', facts()); }
    else if (d.kind === 'scene-model') {
      exportModel(Array.isArray(d.replace) ? d.replace.slice(0, 20) : []).then(
        (m) => { try { window.parent.postMessage({ pandeshPreview: NONCE, kind: 'model', data: { id: d.id, ...m } }, '*', [m.glb]); } catch { post('model', { id: d.id, error: 'the model could not be handed over' }); } },
        (err) => post('model', { id: d.id, error: String(err?.message ?? err).slice(0, 300) }),
      );
    }
  });
  // First report once a few frames have really been drawn.
  const ready = () => { if (state.frames >= 3 || state.error) post('scene', facts()); else setTimeout(ready, 120); };
  ready();
}

window.PandeshScene = { run, THREE, version: 1 };
