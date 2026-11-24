/**
 * Reusable assets for scene pages: a parametric house with real architecture, and what stands around a house.
 *
 * A model that writes a scene composes these instead of inventing a window out of boxes each time. Every asset is plain
 * three.js geometry with painted (canvas) surfaces: no files are loaded. Units are metres, Y is up, an asset stands on
 * y = 0 around its own origin and faces +Z, and the caller positions and turns the returned THREE.Group.
 */
import * as THREE from 'three';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));

export function installAssets(kit, { SURFACES, canvasTexture, shade, seeded, state }) {
  // ------------------------------------------------------------------ surfaces only assets needed so far
  SURFACES.plaster = (base = '#f1e9da') => canvasTexture(256, (g, n) => {
    const rnd = seeded(11); g.fillStyle = base; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 2600; i++) { g.fillStyle = shade(base, 0.93 + rnd() * 0.12); g.globalAlpha = 0.5; g.fillRect(rnd() * n, rnd() * n, 2 + rnd() * 3, 2 + rnd() * 3); }
    g.globalAlpha = 1;
  });
  SURFACES.cladding = (base = '#c8b89a') => canvasTexture(256, (g, n) => {
    const rnd = seeded(13); g.fillStyle = base; g.fillRect(0, 0, n, n);
    const boards = 6; const bh = n / boards;
    for (let b = 0; b < boards; b++) { g.fillStyle = shade(base, 0.9 + rnd() * 0.18); g.fillRect(0, b * bh, n, bh - 3); g.fillStyle = 'rgba(0,0,0,.32)'; g.fillRect(0, b * bh + bh - 3, n, 3); }
  });
  SURFACES.stonework = (base = '#a39a8b') => canvasTexture(512, (g, n) => {
    const rnd = seeded(17); g.fillStyle = shade(base, 0.55); g.fillRect(0, 0, n, n);
    const rows = 6; const rh = n / rows;
    for (let r = 0; r < rows; r++) { let x = -rnd() * 60; while (x < n) { const w = 50 + rnd() * 80; g.fillStyle = shade(base, 0.8 + rnd() * 0.35); g.beginPath(); g.roundRect(x + 3, r * rh + 3, w - 6, rh - 6, 7); g.fill(); x += w; } }
  });
  SURFACES.hedge = (base = '#3f8a3a') => canvasTexture(256, (g, n) => {
    const rnd = seeded(19); g.fillStyle = shade(base, 0.85); g.fillRect(0, 0, n, n);
    for (let i = 0; i < 2400; i++) { g.fillStyle = shade(base, 0.85 + rnd() * 0.5); g.beginPath(); g.ellipse(rnd() * n, rnd() * n, 3 + rnd() * 4, 2 + rnd() * 2, rnd() * 3, 0, 7); g.fill(); }
  });

  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...extra });
  const place = (m, x, y, z) => { m.position.set(x, y, z); return m; };
  const box = (w, h, d, material, x = 0, y = 0, z = 0) => place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material), x, y, z);
  const cyl = (rt, rb, h, material, x = 0, y = 0, z = 0, seg = 16) => place(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material), x, y, z);
  const ball = (r, material, x = 0, y = 0, z = 0, seg = 16) => place(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 4)), material), x, y, z);
  const blob = (r, material, x = 0, y = 0, z = 0) => place(new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), material), x, y, z);
  const glass = () => new THREE.MeshPhysicalMaterial({ color: '#a9cde0', roughness: 0.05, metalness: 0.15, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false });
  const leaf = (color) => std(color, { roughness: 0.9, flatShading: true });

  // One painted picture per surface and colour, shared by every piece that uses it.
  const pictures = new Map();
  const tex = (surface, base, rx = 1, ry = 1, ox = 0, oy = 0) => {
    const key = `${surface}|${base}`;
    if (!pictures.has(key)) pictures.set(key, SURFACES[surface](base));
    const t = pictures.get(key).clone(); t.needsUpdate = true; t.repeat.set(rx, ry); t.offset.set(ox, oy); return t;
  };
  const surfaced = (surface, base, rx, ry, extra = {}) => std('#ffffff', { map: tex(surface, base, rx, ry), ...extra });

  const SKINS = {
    render: { surface: 'plaster', tile: [2, 2], color: '#f1e9da' }, plaster: { surface: 'plaster', tile: [2, 2], color: '#f1e9da' },
    brick: { surface: 'brick', tile: [1, 0.6], color: '#a84e3a' }, wood: { surface: 'cladding', tile: [2, 1.1], color: '#c8b89a' },
    stone: { surface: 'stonework', tile: [2.2, 1.5], color: '#a39a8b' },
  };
  /** A function (w, h, x0, y0) -> material for one piece of wall, so that courses run through from piece to piece. */
  const skinOf = (kind, color) => {
    const s = SKINS[kind] ?? SKINS.render; const base = color ?? s.color;
    return (w, h, x0 = 0, y0 = 0) => std('#ffffff', { map: tex(s.surface, base, w / s.tile[0], h / s.tile[1], x0 / s.tile[0], y0 / s.tile[1]) });
  };

  // ------------------------------------------------------------------ windows, doors, walls

  function windowUnit(o, T, style) {
    const g = new THREE.Group(); g.name = 'window';
    const frame = std(style.trim, { roughness: 0.5 }); const bar = 0.09; const depth = T + 0.08; const cy = o.y + o.h / 2;
    g.add(box(o.w, bar, depth, frame, o.x, o.y + bar / 2, 0), box(o.w, bar, depth, frame, o.x, o.y + o.h - bar / 2, 0));
    g.add(box(bar, o.h, depth, frame, o.x - o.w / 2 + bar / 2, cy, 0), box(bar, o.h, depth, frame, o.x + o.w / 2 - bar / 2, cy, 0));
    g.add(box(0.05, o.h - bar * 2, 0.06, frame, o.x, cy, 0), box(o.w - bar * 2, 0.05, 0.06, frame, o.x, cy + o.h * 0.14, 0));
    const pane = place(new THREE.Mesh(new THREE.PlaneGeometry(o.w - bar * 2, o.h - bar * 2), glass()), o.x, cy, 0); pane.name = 'glass'; g.add(pane);
    if (style.lit) { const glow = place(new THREE.Mesh(new THREE.PlaneGeometry(o.w - bar * 2, o.h - bar * 2), std('#ffd9a0', { emissive: '#ffb34d', emissiveIntensity: 1.3 })), o.x, cy, -T / 2 - 0.02); glow.userData.noCast = true; g.add(glow); }
    else { const drape = std('#f4efe4', { roughness: 0.95 }); for (const s of [-1, 1]) g.add(box(o.w * 0.2, o.h - bar * 2, 0.03, drape, o.x + s * (o.w / 2 - bar - o.w * 0.1), cy, -T / 2 + 0.03)); }
    g.add(box(o.w + 0.26, 0.07, T + 0.3, std('#e9e4da', { roughness: 0.6 }), o.x, o.y - 0.035, 0.06));                 // sill
    g.add(box(o.w + 0.2, 0.14, 0.06, std(style.trim, { roughness: 0.6 }), o.x, o.y + o.h + 0.07, T / 2 + 0.02));        // head
    if (style.shutters) {
      const sm = std(style.shutters, { roughness: 0.7 }); const sw = Math.min(0.55, o.w * 0.42);
      for (const s of [-1, 1]) {
        const sx = o.x + s * (o.w / 2 + sw / 2 + 0.03);
        g.add(box(sw, o.h, 0.05, sm, sx, cy, T / 2 + 0.03));
        for (let i = 1; i < 6; i++) g.add(box(sw - 0.1, 0.03, 0.02, std(shade(style.shutters, 0.75)), sx, o.y + (o.h * i) / 6, T / 2 + 0.065));
      }
    }
    if (style.boxes && o.box) {
      const rnd = seeded(Math.round((o.x + 50) * 97)); const colors = ['#e63946', '#ff8fab', '#ffd166', '#ffffff', '#c77dff'];
      g.add(box(o.w + 0.1, 0.2, 0.26, std('#6b4a32'), o.x, o.y - 0.2, T / 2 + 0.2));
      for (let i = 0; i < 7; i++) { const fx = o.x - o.w / 2 + 0.1 + (o.w - 0.1) * (i / 6); g.add(blob(0.09, leaf('#3f7f3a'), fx, o.y - 0.07, T / 2 + 0.2)); g.add(ball(0.06, std(colors[Math.floor(rnd() * colors.length)]), fx + (rnd() - 0.5) * 0.06, o.y + 0.02, T / 2 + 0.22 + (rnd() - 0.5) * 0.08, 8)); }
    }
    return g;
  }

  function doorUnit(o, T, style) {
    const g = new THREE.Group(); g.name = o.kind;
    const frame = std(style.trim, { roughness: 0.5 }); const bar = 0.1; const depth = T + 0.08;
    g.add(box(o.w, bar, depth, frame, o.x, o.y + o.h - bar / 2, 0));
    for (const s of [-1, 1]) g.add(box(bar, o.h, depth, frame, o.x + s * (o.w / 2 - bar / 2), o.y + o.h / 2, 0));
    if (o.kind === 'glassdoor') {
      g.add(box(0.07, o.h - bar, 0.07, frame, o.x, o.y + (o.h - bar) / 2, 0));
      const pane = place(new THREE.Mesh(new THREE.PlaneGeometry(o.w - bar * 2, o.h - bar), glass()), o.x, o.y + (o.h - bar) / 2, 0); pane.name = 'glass'; g.add(pane);
    } else if (o.kind === 'garage') {
      const leafM = std(style.garageDoor ?? '#e8e6e0', { roughness: 0.6 }); const lh = o.h - bar;
      g.add(box(o.w - bar * 2, lh, 0.06, leafM, o.x, o.y + lh / 2, 0.04));
      for (let i = 1; i < 5; i++) g.add(box(o.w - bar * 2, 0.025, 0.02, std(shade(style.garageDoor ?? '#e8e6e0', 0.7)), o.x, o.y + (lh * i) / 5, 0.08));
      g.add(box(0.3, 0.05, 0.05, std('#444444', { metalness: 0.7, roughness: 0.4 }), o.x, o.y + 0.45, 0.1));
    } else {
      const leafW = o.w - bar * 2; const leafH = o.h - bar; const paint = style.door;
      g.add(box(leafW, leafH, 0.07, std(paint, { roughness: 0.5 }), o.x, o.y + leafH / 2, 0.02));
      const panel = std(shade(paint, 1.25), { roughness: 0.5 });
      for (const sx of [-0.24, 0.24]) for (const py of [0.24, 0.6]) g.add(box(leafW * 0.34, leafH * 0.28, 0.02, panel, o.x + leafW * sx, o.y + leafH * py, 0.07));
      g.add(box(leafW * 0.72, leafH * 0.13, 0.03, glass(), o.x, o.y + leafH * 0.89, 0.06));
      const brass = std('#c9a54a', { metalness: 0.9, roughness: 0.3 });
      g.add(ball(0.05, brass, o.x + leafW / 2 - 0.12, o.y + leafH * 0.47, 0.1), box(0.22, 0.04, 0.02, brass, o.x, o.y + leafH * 0.45, 0.07));
    }
    return g;
  }

  /** A wall along local X from -length/2 to +length/2, standing on y = 0, outside towards +Z, with real openings. */
  function wall({ length, height, thickness: T, skin, openings = [], style }) {
    const g = new THREE.Group();
    const piece = (x0, x1, y0, y1) => { const w = x1 - x0; const h = y1 - y0; if (w > 0.001 && h > 0.001) g.add(box(w, h, T, skin(w, h, x0 + length / 2, y0), (x0 + x1) / 2, (y0 + y1) / 2, 0)); };
    let cursor = -length / 2;
    for (const o of [...openings].sort((a, b) => a.x - b.x)) {
      const x0 = o.x - o.w / 2; const x1 = o.x + o.w / 2;
      piece(cursor, x0, 0, height); piece(x0, x1, 0, o.y); piece(x0, x1, o.y + o.h, height); cursor = x1;
      g.add(o.kind === 'window' ? windowUnit(o, T, style) : doorUnit(o, T, style));
    }
    piece(cursor, length / 2, 0, height);
    return g;
  }

  // ------------------------------------------------------------------ furniture

  function chair(frame, seat) {
    const g = new THREE.Group();
    g.add(box(0.44, 0.05, 0.44, seat, 0, 0.46, 0), box(0.44, 0.5, 0.05, frame, 0, 0.74, -0.2));
    for (const [x, z] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) g.add(box(0.045, 0.46, 0.045, frame, x, 0.23, z));
    return g;
  }
  function tableWithChairs(wood, seat, count = 4) {
    const g = new THREE.Group();
    g.add(box(1.7, 0.07, 0.95, wood, 0, 0.76, 0));
    for (const [x, z] of [[-0.75, -0.38], [0.75, -0.38], [-0.75, 0.38], [0.75, 0.38]]) g.add(box(0.07, 0.74, 0.07, wood, x, 0.37, z));
    for (const [x, z, r] of [[-0.45, -0.8, 0], [0.45, -0.8, 0], [-0.45, 0.8, Math.PI], [0.45, 0.8, Math.PI]].slice(0, count)) { const c = chair(wood, seat); c.position.set(x, 0, z); c.rotation.y = r; g.add(c); }
    return g;
  }
  function sofa(m) {
    const g = new THREE.Group();
    g.add(box(2.2, 0.4, 0.9, m, 0, 0.3, 0), box(2.2, 0.55, 0.22, m, 0, 0.72, -0.34), box(0.22, 0.5, 0.9, m, -1.0, 0.55, 0), box(0.22, 0.5, 0.9, m, 1.0, 0.55, 0));
    g.add(box(0.5, 0.3, 0.14, std('#e9c46a'), -0.55, 0.66, -0.16), box(0.5, 0.3, 0.14, std('#e76f51'), 0.55, 0.66, -0.16));
    return g;
  }
  function bed(wood, cover = '#4f7cac') {
    const g = new THREE.Group();
    g.add(box(1.7, 0.3, 2.1, wood, 0, 0.2, 0), box(1.6, 0.22, 2.0, std('#f4f1ea'), 0, 0.46, 0), box(1.62, 0.1, 1.25, std(cover), 0, 0.6, 0.36));
    g.add(box(0.62, 0.12, 0.38, std('#ffffff'), -0.42, 0.62, -0.72), box(0.62, 0.12, 0.38, std('#ffffff'), 0.42, 0.62, -0.72), box(1.7, 0.9, 0.08, wood, 0, 0.65, -1.04));
    return g;
  }

  function furnish(g, floor, W, D, T, H, storeys) {
    const hw = W / 2 - T; const hd = D / 2 - T; const wood = std('#8a5a33', { roughness: 0.6 });
    if (floor === 0) {
      const s = sofa(std('#6d7f8f')); s.position.set(hw * 0.55, 0.05, hd * 0.1); s.rotation.y = Math.PI; g.add(s);
      g.add(box(2.6, 0.02, 1.8, std('#b5544b'), hw * 0.55, 0.065, hd * 0.5), box(1.0, 0.4, 0.55, wood, hw * 0.55, 0.26, hd * 0.5));
      g.add(box(1.5, 0.5, 0.4, wood, hw * 0.55, 0.3, hd - 0.3), box(1.2, 0.7, 0.06, std('#15181c', { roughness: 0.3 }), hw * 0.55, 0.95, hd - 0.25));
      const dining = tableWithChairs(wood, std('#d9c9a8')); dining.position.set(hw * 0.5, 0.05, -hd * 0.55); dining.rotation.y = Math.PI / 2; g.add(dining);
      const counter = std('#f2f2ee', { roughness: 0.4 }); const top = std('#3a3f45', { roughness: 0.35 }); const run = Math.min(3.2, hw * 0.8);
      g.add(box(run, 0.9, 0.6, counter, -hw + run / 2 + 0.6, 0.5, -hd + 0.3), box(run + 0.1, 0.05, 0.65, top, -hw + run / 2 + 0.6, 0.975, -hd + 0.3));
      g.add(box(0.7, 1.9, 0.65, std('#d7dbe0', { metalness: 0.5, roughness: 0.35 }), -hw + run + 1.1, 1.0, -hd + 0.33));
      if (storeys > 1) { const steps = 14; const rise = (H + 0.25) / steps; for (let i = 0; i < steps; i++) g.add(box(0.95, rise * (i + 1), 0.26, wood, -hw + 0.5, 0.05 + (rise * (i + 1)) / 2, hd - 0.3 - i * 0.26)); }
      g.add(box(0.12, H - 0.06, hd * 0.6, std('#f4efe6'), -hw * 0.1, H / 2 + 0.03, hd * 0.68));
    } else {
      const b1 = bed(wood); b1.position.set(hw * 0.58, 0.05, hd * 0.55); g.add(b1);
      g.add(box(1.8, 2.0, 0.55, std('#e8e0d2'), hw * 0.7, 1.05, -hd * 0.12));
      const b2 = bed(std('#7b5b3a'), '#c9705b'); b2.scale.set(0.7, 1, 0.95); b2.position.set(-hw * 0.7, 0.05, -hd * 0.6); b2.rotation.y = Math.PI; g.add(b2);
      g.add(box(1.3, 0.05, 0.6, wood, -hw * 0.25, 0.76, -hd + 0.35)); for (const dx of [-0.6, 0.6]) g.add(box(0.05, 0.74, 0.5, wood, -hw * 0.25 + dx, 0.38, -hd + 0.35));
      g.add(box(0.1, H - 0.04, hd * 0.85, std('#f4efe6'), hw * 0.15, H / 2 + 0.02, -hd * 0.55));
      g.add(box(1.7, 0.55, 0.75, std('#ffffff', { roughness: 0.25 }), hw * 0.72, 0.3, -hd + 0.45));
    }
  }

  function railing(g, x0, x1, z0, z1, y, color, sides = ['front', 'left', 'right']) {
    const m = std(color, { roughness: 0.5 }); const h = 1.0;
    const run = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az); const n = Math.max(2, Math.round(len / 0.14));
      const top = box(len, 0.06, 0.07, m, (ax + bx) / 2, y + h, (az + bz) / 2); top.rotation.y = -Math.atan2(bz - az, bx - ax); g.add(top);
      const low = box(len, 0.04, 0.05, m, (ax + bx) / 2, y + 0.1, (az + bz) / 2); low.rotation.y = top.rotation.y; g.add(low);
      for (let i = 0; i <= n; i++) g.add(box(0.035, h - 0.1, 0.035, m, ax + ((bx - ax) * i) / n, y + h / 2 + 0.03, az + ((bz - az) * i) / n));
    };
    if (sides.includes('front')) run(x0, z1, x1, z1);
    if (sides.includes('left')) run(x0, z0, x0, z1);
    if (sides.includes('right')) run(x1, z0, x1, z1);
    for (const [px, pz] of [[x0, z1], [x1, z1]]) g.add(box(0.09, h + 0.06, 0.09, m, px, y + h / 2 + 0.03, pz));
  }

  // ------------------------------------------------------------------ the house

  /**
   * house({ width, depth, storeys, walls, groundWalls, wallColor, groundWallColor, roofColor, trimColor, doorColor,
   *         shutters, chimney, porch, balcony, garage, dormers, flowerBoxes, furnished, lit, name })
   * Front (door, porch, balcony) faces +Z. The roof and each floor get their own Show toggle.
   */
  kit.house = (o = {}) => {
    const W = clamp(o.width ?? 10, 5, 24); const D = clamp(o.depth ?? 8, 4.5, 18); const T = 0.25; const SLAB = 0.25; const BASE = 0.3;
    const storeys = Math.round(clamp(o.storeys ?? 2, 1, 3)); const HEIGHTS = [2.9, 2.7, 2.6];
    const name = String(o.name ?? '').trim(); const label = (s) => (name ? `${name}: ${s}` : s);
    const style = {
      trim: o.trimColor ?? '#ffffff', door: o.doorColor ?? '#2f5d50', shutters: o.shutters === false ? null : (typeof o.shutters === 'string' ? o.shutters : '#3d6b5c'),
      boxes: o.flowerBoxes !== false, lit: o.lit === true, garageDoor: o.garageDoorColor ?? '#e8e6e0',
    };
    const upperSkin = skinOf(o.walls ?? 'render', o.wallColor);
    const groundSkin = skinOf(o.groundWalls ?? o.walls ?? 'render', o.groundWallColor ?? (o.groundWalls ? undefined : o.wallColor));
    const garageSide = o.garage === 'left' ? -1 : o.garage === 'right' || o.garage === true ? 1 : 0;
    const house = new THREE.Group(); house.name = name || 'House';
    house.add(box(W + 0.2, BASE, D + 0.2, surfaced('stonework', '#8f897e', (W + D) / 2.2, 0.4), 0, BASE / 2, 0));

    const nFront = Math.max(2, Math.round(W / 2.8)); const nSide = Math.max(1, Math.round((D - 2 * T) / 3.6));
    const slots = (L, n) => Array.from({ length: n }, (_, i) => -L / 2 + (L * (i + 0.5)) / n);
    const doorSlot = nFront % 2 ? (nFront - 1) / 2 : Math.max(0, nFront / 2 - 1);
    const frontX = slots(W, nFront); const doorX = frontX[doorSlot];
    const winW = (L, n) => Math.min(1.5, (L / n) * 0.46);
    const windows = (L, n, y, h, boxes = false) => slots(L, n).map((x) => ({ kind: 'window', x, w: winW(L, n), y, h, box: boxes }));

    let base = BASE; let eaves = BASE; const floorGroups = [];
    for (let s = 0; s < storeys; s++) {
      const H = HEIGHTS[s]; const skin = s === 0 ? groundSkin : upperSkin;
      const fg = new THREE.Group(); fg.position.y = base;
      const title = storeys === 1 ? 'Walls' : s === 0 ? 'Ground floor' : storeys === 2 ? 'Upper floor' : s === storeys - 1 ? 'Top floor' : 'Middle floor';
      fg.name = label(title); state.groups.set(fg.name, fg); floorGroups.push(fg);
      const y = s === 0 ? 0.9 : 0.85; const h = s === 0 ? 1.4 : 1.3;
      const front = windows(W, nFront, y, h, s === 0);
      if (s === 0) front[doorSlot] = { kind: 'door', x: doorX, w: 1.1, y: 0, h: 2.2 };
      if (s === 1 && o.balcony !== false && o.balcony !== undefined) front[doorSlot] = { kind: 'glassdoor', x: doorX, w: 1.5, y: 0, h: 2.15 };
      const back = windows(W, nFront, y, h);
      if (s === 0) back[0] = { kind: 'glassdoor', x: back[0].x, w: Math.min(2.4, (W / nFront) * 0.8), y: 0, h: 2.2 };
      const side = (sign) => (s === 0 && garageSide === sign ? [] : windows(D - 2 * T, nSide, y, h));
      const add = (wallGroup, x, z, turn) => { wallGroup.position.set(x, 0, z); wallGroup.rotation.y = turn; fg.add(wallGroup); };
      add(wall({ length: W, height: H, thickness: T, skin, openings: front, style }), 0, D / 2 - T / 2, 0);
      add(wall({ length: W, height: H, thickness: T, skin, openings: back, style: { ...style, boxes: false } }), 0, -D / 2 + T / 2, Math.PI);
      add(wall({ length: D - 2 * T, height: H, thickness: T, skin, openings: side(-1), style: { ...style, boxes: false } }), -W / 2 + T / 2, 0, -Math.PI / 2);
      add(wall({ length: D - 2 * T, height: H, thickness: T, skin, openings: side(1), style: { ...style, boxes: false } }), W / 2 - T / 2, 0, Math.PI / 2);
      // The floor of this storey; above the ground it is a slab whose edge shows as a band on the facade.
      if (s > 0) fg.add(box(W + 0.12, SLAB, D + 0.12, std('#f7f4ee', { roughness: 0.7 }), 0, -SLAB / 2, 0));
      fg.add(box(W - 2 * T, 0.05, D - 2 * T, surfaced('wood', s === 0 ? '#c49a66' : '#d2b48a', W / 3, D / 3, { roughness: 0.6 }), 0, 0.025, 0));
      if (o.furnished !== false) furnish(fg, s, W, D, T, H, storeys);
      if (style.lit) { const lamp = new THREE.PointLight('#ffd9a0', 10, 12, 2); lamp.position.set(0, H - 0.4, 0); fg.add(lamp); }
      house.add(fg);
      base += H + SLAB; eaves = base - SLAB;
    }
    const ground = floorGroups[0];

    // Porch at the front door: steps, a deck, posts, and a roof (the balcony when there is one, else a small gable).
    const balcony = storeys > 1 && o.balcony !== false && o.balcony !== undefined;
    const porch = o.porch !== false; const PW = 2.6; const PD = 1.5; const zf = D / 2;
    if (porch) {
      const stone = surfaced('stonework', '#b9b2a5', 1.2, 0.3);
      ground.add(box(PW, BASE, PD, stone, doorX, -BASE / 2, zf + PD / 2));
      ground.add(box(PW - 0.5, BASE / 2, 0.36, stone, doorX, -BASE * 0.75, zf + PD + 0.18));
      const postH = balcony ? HEIGHTS[0] : 2.45; const white = std(style.trim, { roughness: 0.5 });
      for (const s of [-1, 1]) { ground.add(box(0.14, postH, 0.14, white, doorX + s * (PW / 2 - 0.1), postH / 2, zf + PD - 0.1)); ground.add(box(0.22, 0.12, 0.22, white, doorX + s * (PW / 2 - 0.1), 0.06, zf + PD - 0.1)); }
      if (!balcony) {
        const roofM = surfaced('roof', o.roofColor ?? '#8c4334', 1.3, 0.6); const rise = 0.55; const half = PW / 2 + 0.2; const slope = Math.hypot(half, rise); const ang = Math.atan2(rise, half);
        for (const s of [-1, 1]) { const slab = box(slope, 0.08, PD + 0.35, roofM, doorX + (s * half) / 2, postH + rise / 2 + 0.06, zf + PD / 2 + 0.05); slab.rotation.z = -s * ang; ground.add(slab); }
        const tri = new THREE.Shape(); tri.moveTo(-half + 0.1, 0); tri.lineTo(half - 0.1, 0); tri.lineTo(0, rise - 0.05); tri.closePath();
        ground.add(place(new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 0.08, bevelEnabled: false }), white), doorX, postH + 0.02, zf + PD - 0.14));
        ground.add(box(PW, 0.12, 0.12, white, doorX, postH - 0.02, zf + PD - 0.1));
      }
      const lantern = box(0.14, 0.22, 0.12, std('#ffe9b8', { emissive: '#ffcf70', emissiveIntensity: style.lit ? 2.2 : 0.5 }), doorX + 0.85, 1.85, zf + 0.09); ground.add(lantern);
      ground.add(box(0.18, 0.04, 0.16, std('#2b2b2b'), doorX + 0.85, 1.98, zf + 0.09));
    }
    if (balcony) {
      const upper = floorGroups[1]; const depth = porch ? PD : 1.1; const white = std(style.trim, { roughness: 0.5 });
      upper.add(box(PW + 0.2, 0.18, depth + 0.1, std('#f1ede4', { roughness: 0.7 }), doorX, -0.09, zf + depth / 2));
      if (!porch) for (const s of [-1, 1]) { const br = box(0.1, 0.5, depth * 0.8, white, doorX + s * (PW / 2 - 0.2), -0.4, zf + depth * 0.4); ground.add(br); br.position.y = HEIGHTS[0] - 0.15; }
      railing(upper, doorX - PW / 2, doorX + PW / 2, zf, zf + depth, 0, style.trim);
    }

    // Garage at one side: walls of the ground-floor material, a sectional door and a lean-to roof.
    if (garageSide) {
      const GW = 3.6; const GD = Math.min(D - 0.6, 6); const GH = 2.6; const gx = garageSide * (W / 2 + GW / 2); const gz = D / 2 - GD / 2 - 0.5;
      const add = (wg, x, z, turn) => { wg.position.set(x, 0, z); wg.rotation.y = turn; ground.add(wg); };
      add(wall({ length: GW, height: GH, thickness: T, skin: groundSkin, openings: [{ kind: 'garage', x: 0, w: 2.7, y: 0, h: 2.15 }], style }), gx, gz + GD / 2 - T / 2, 0);
      add(wall({ length: GW, height: GH, thickness: T, skin: groundSkin, openings: [], style }), gx, gz - GD / 2 + T / 2, Math.PI);
      add(wall({ length: GD - 2 * T, height: GH, thickness: T, skin: groundSkin, openings: [{ kind: 'window', x: 0, w: 1.0, y: 1.1, h: 0.9 }], style: { ...style, boxes: false, shutters: null } }), gx + garageSide * (GW / 2 - T / 2), gz, garageSide * Math.PI / 2);
      ground.add(box(GW, BASE, GD, surfaced('stonework', '#8f897e', 2, 0.4), gx, -BASE / 2, gz));
      const lean = box(GW + 0.5, 0.14, GD + 0.7, surfaced('roof', o.roofColor ?? '#8c4334', (GW + 0.5) / 2, (GD + 0.7) / 2), gx + garageSide * 0.1, GH + 0.32, gz); lean.rotation.z = -garageSide * 0.17; ground.add(lean);
      house.userData.garageDoor = { x: gx, z: gz + GD / 2 };
    }

    // The roof: two tiled slopes with eaves, gutters, gable ends with a round window, a chimney and dormers.
    const roof = new THREE.Group(); roof.position.y = eaves; roof.name = label('Roof'); state.groups.set(roof.name, roof);
    const OV = 0.6; const RISE = clamp(o.roofRise ?? D * 0.36, 1.2, 6); const run = D / 2 + OV; const angle = Math.atan2(RISE, run); const slope = Math.hypot(run, RISE);
    const roofColor = o.roofColor ?? '#8c4334';
    for (const s of [1, -1]) {
      const slab = box(W + 2 * OV, 0.16, slope, surfaced('roof', roofColor, (W + 2 * OV) / 2, slope / 2, { roughness: 0.75 }), 0, RISE / 2, (s * run) / 2); slab.rotation.x = s * angle; roof.add(slab);
      const soffit = box(W + 2 * OV, 0.03, slope, std('#efe9de'), 0, RISE / 2 - 0.1, (s * run) / 2); soffit.rotation.x = s * angle; soffit.userData.noCast = true; roof.add(soffit);
      roof.add(box(W + 2 * OV + 0.04, 0.16, 0.05, std(style.trim), 0, -0.02, s * (run + 0.02)));
      roof.add(box(W + 2 * OV + 0.1, 0.1, 0.14, std('#4a4f55', { metalness: 0.6, roughness: 0.4 }), 0, -0.1, s * (run + 0.1)));
    }
    roof.add(box(W + 2 * OV + 0.06, 0.14, 0.34, std(shade(roofColor, 0.75)), 0, RISE + 0.03, 0));
    const gableRise = (RISE * (D / 2)) / run; const tri = new THREE.Shape(); tri.moveTo(-D / 2, 0); tri.lineTo(D / 2, 0); tri.lineTo(0, gableRise); tri.closePath();
    for (const s of [1, -1]) {
      const gable = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: T, bevelEnabled: false }), upperSkin(D, gableRise)); gable.material.map.repeat.set(0.5, 0.5);
      gable.rotation.y = Math.PI / 2; gable.position.set(s * (W / 2) - (s > 0 ? T : 0), 0, 0); roof.add(gable);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 12, 32), std(style.trim)); ring.rotation.y = Math.PI / 2; ring.position.set(s * (W / 2 + 0.02), gableRise * 0.42, 0); roof.add(ring);
      const pane = new THREE.Mesh(new THREE.CircleGeometry(0.4, 32), glass()); pane.rotation.y = (s * Math.PI) / 2; pane.position.set(s * (W / 2 + 0.03), gableRise * 0.42, 0); roof.add(pane);
      // Barge boards along the gable edge.
      for (const k of [1, -1]) { const bb = box(0.06, 0.18, slope, std(style.trim), s * (W / 2 + OV), RISE / 2 - 0.02, (k * run) / 2); bb.rotation.x = k * angle; roof.add(bb); }
    }
    if (o.chimney !== false) {
      const cx = W * 0.24; const cz = -D * 0.2; const top = RISE * (1 - Math.abs(cz) / run); const ch = RISE - top + 1.1;
      roof.add(box(0.9, ch + 0.8, 0.7, surfaced('brick', '#a84e3a', 0.9, (ch + 0.8) / 0.6), cx, top + (ch + 0.8) / 2 - 0.8, cz));
      roof.add(box(1.06, 0.12, 0.86, std('#d8d2c6'), cx, top + ch + 0.06, cz));
      for (const dx of [-0.2, 0.2]) roof.add(cyl(0.11, 0.14, 0.4, std('#b5553c'), cx + dx, top + ch + 0.32, cz));
    }
    const dormers = Math.round(clamp(o.dormers ?? 0, 0, 3));
    for (const dx of slots(W * 0.7, dormers)) {
      const zFace = run * 0.62; const yBase = RISE * (1 - zFace / run); const dh = 1.15; const dd = Math.min(run * 0.5, (dh * run) / RISE); const dw = 1.3;
      const d = new THREE.Group(); d.position.set(dx, yBase, zFace);
      d.add(box(dw, dh, dd, upperSkin(dw, dh), 0, dh / 2, -dd / 2));
      const unit = windowUnit({ x: 0, w: 0.8, y: 0.2, h: 0.8 }, 0.1, { ...style, shutters: null, boxes: false }); unit.position.z = -0.02; d.add(unit);
      const half = dw / 2 + 0.15; const rr = 0.45; const sl = Math.hypot(half, rr); const an = Math.atan2(rr, half);
      for (const s of [-1, 1]) { const slab = box(sl, 0.07, dd + 0.25, surfaced('roof', roofColor, 0.6, 0.8), (s * half) / 2, dh + rr / 2, -dd / 2 + 0.1); slab.rotation.z = -s * an; d.add(slab); }
      const t2 = new THREE.Shape(); t2.moveTo(-dw / 2, 0); t2.lineTo(dw / 2, 0); t2.lineTo(0, rr * (dw / 2) / half); t2.closePath();
      d.add(place(new THREE.Mesh(new THREE.ExtrudeGeometry(t2, { depth: 0.08, bevelEnabled: false }), std(style.trim)), 0, dh, -0.08));
      roof.add(d);
    }
    house.add(roof);
    // Downpipes at the front corners.
    for (const s of [-1, 1]) house.add(cyl(0.05, 0.05, eaves - 0.1, std('#4a4f55', { metalness: 0.6, roughness: 0.4 }), s * (W / 2 + 0.08), eaves / 2, D / 2 + 0.1, 10));

    house.userData.width = W; house.userData.depth = D; house.userData.height = eaves + RISE;
    house.userData.door = { x: doorX, z: D / 2 + (porch ? PD + 0.5 : 0.2) };
    house.userData.backDoor = { x: -slots(W, nFront)[0], z: -D / 2 };
    return house;
  };

  // ------------------------------------------------------------------ around the house

  /** A paved strip along points on the ground: path([[x, z], ...], width, surface, color). */
  kit.path = (points, width = 1.2, surface = 'paving', color = '#c9c2b4') => {
    const g = new THREE.Group();
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, az] = points[i]; const [bx, bz] = points[i + 1]; const len = Math.hypot(bx - ax, bz - az); if (len < 0.01) continue;
      const strip = box(len + width, 0.06, width, surfaced(SURFACES[surface] ? surface : 'paving', color, (len + width) / 1.2, width / 1.2), (ax + bx) / 2, 0.03, (az + bz) / 2);
      strip.rotation.y = -Math.atan2(bz - az, bx - ax); strip.userData.noCast = true; g.add(strip);
      for (const s of [-1, 1]) { const edge = box(len + width, 0.09, 0.07, std('#8f897e'), (ax + bx) / 2, 0.045, (az + bz) / 2); edge.rotation.y = strip.rotation.y; edge.translateZ(s * (width / 2 + 0.035)); g.add(edge); }
    }
    return g;
  };

  /** A paved area: patio(width, depth, surface, color). */
  kit.patio = (width = 4, depth = 3, surface = 'paving', color = '#cfc6b4') => {
    const g = new THREE.Group(); const slab = box(width, 0.08, depth, surfaced(SURFACES[surface] ? surface : 'paving', color, width / 1.2, depth / 1.2), 0, 0.04, 0); slab.userData.noCast = true; g.add(slab); return g;
  };

  /** A garden table with chairs and a parasol: patioSet({ chairs, parasol, color }). */
  kit.patioSet = (o = {}) => {
    const g = new THREE.Group(); const frame = std('#f4f4f1', { roughness: 0.5 }); const seat = std(o.color ?? '#3d7fa6');
    g.add(cyl(0.6, 0.6, 0.05, std('#e9e4d8', { roughness: 0.4 }), 0, 0.74, 0, 28), cyl(0.05, 0.05, 0.72, frame, 0, 0.36, 0), cyl(0.3, 0.34, 0.04, frame, 0, 0.02, 0));
    const n = Math.round(clamp(o.chairs ?? 4, 0, 6));
    for (let i = 0; i < n; i++) { const c = chair(frame, seat); const a = (i / n) * Math.PI * 2 + Math.PI / 4; c.position.set(Math.cos(a) * 1.05, 0, Math.sin(a) * 1.05); c.rotation.y = -a - Math.PI / 2; g.add(c); }
    if (o.parasol !== false) {
      g.add(cyl(0.025, 0.025, 2.4, std('#8a8f96', { metalness: 0.7, roughness: 0.4 }), 0, 1.2, 0, 10));
      const canopy = place(new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.5, 8, 1, true), std(o.parasolColor ?? '#e9c46a', { side: THREE.DoubleSide, roughness: 0.9, flatShading: true })), 0, 2.3, 0); g.add(canopy);
    }
    return g;
  };

  /** A wooden garden bench: bench(color). */
  kit.bench = (color = '#7a5230') => {
    const g = new THREE.Group(); const wood = std(color, { roughness: 0.7 }); const iron = std('#2b2d30', { metalness: 0.6, roughness: 0.5 });
    for (let i = 0; i < 4; i++) g.add(box(1.6, 0.04, 0.1, wood, 0, 0.45, -0.18 + i * 0.12));
    for (let i = 0; i < 3; i++) { const slat = box(1.6, 0.1, 0.035, wood, 0, 0.62 + i * 0.14, -0.27 - i * 0.02); slat.rotation.x = -0.12; g.add(slat); }
    for (const s of [-1, 1]) { g.add(box(0.06, 0.45, 0.5, iron, s * 0.74, 0.225, -0.02), box(0.06, 0.5, 0.06, iron, s * 0.74, 0.7, -0.27), box(0.06, 0.05, 0.5, iron, s * 0.74, 0.62, -0.02)); }
    return g;
  };

  /** A clipped hedge between two ground points: hedge([x0, z0], [x1, z1], height, thickness, color). */
  kit.hedge = (from = [-4, 0], to = [4, 0], height = 1.1, thickness = 0.7, color = '#3f8a3a') => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]); const g = new THREE.Group();
    const body = box(len, height, thickness, surfaced('hedge', color, len / 1.2, height / 1.2, { roughness: 1 }), 0, height / 2, 0); g.add(body);
    const rnd = seeded(Math.round(len * 31) + 5); const n = Math.max(2, Math.round(len / 0.5));
    for (let i = 0; i <= n; i++) g.add(blob(thickness * 0.42, leaf(shade(color, 0.9 + rnd() * 0.3)), -len / 2 + (len * i) / n, height - 0.05 + rnd() * 0.08, (rnd() - 0.5) * 0.12));
    g.position.set((from[0] + to[0]) / 2, 0, (from[1] + to[1]) / 2); g.rotation.y = -Math.atan2(to[1] - from[1], to[0] - from[0]); return g;
  };

  /** A rounded bush, with flowers when a flower colour is given: shrub(radius, color, flowerColor). */
  kit.shrub = (radius = 0.6, color = '#3b7a34', flowerColor = null) => {
    const g = new THREE.Group(); const rnd = seeded(Math.round(radius * 1000) + (flowerColor ? 7 : 3));
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const r = radius * (0.55 + rnd() * 0.25); g.add(blob(r, leaf(shade(color, 0.85 + rnd() * 0.35)), Math.cos(a) * radius * 0.45, r * 0.9 + rnd() * radius * 0.2, Math.sin(a) * radius * 0.45)); }
    g.add(blob(radius * 0.75, leaf(color), 0, radius * 1.05, 0));
    if (flowerColor) for (let i = 0; i < 16; i++) { const a = rnd() * Math.PI * 2; const e = rnd() * 1.2; g.add(ball(radius * 0.09, std(flowerColor), Math.cos(a) * Math.cos(e) * radius * 1.0, radius * 0.95 + Math.sin(e) * radius * 0.85, Math.sin(a) * Math.cos(e) * radius * 1.0, 8)); }
    return g;
  };

  /** A picket fence round a plot centred on the origin, with a gate: fenceAround(width, depth, { color, height, gate: 'front' | 'back' | 'left' | 'right' | false, gateWidth, gateAt }). */
  kit.fenceAround = (width = 24, depth = 20, o = {}) => {
    const g = new THREE.Group(); const color = o.color ?? '#f6f3ec'; const h = clamp(o.height ?? 1.0, 0.5, 2); const m = std(color, { roughness: 0.7 });
    const gate = o.gate === undefined ? 'front' : o.gate; const gw = clamp(o.gateWidth ?? 1.4, 0.9, 4); const gateAt = Number(o.gateAt) || 0;
    const run = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az); if (len < 0.05) return; const dirX = (bx - ax) / len; const dirZ = (bz - az) / len; const turn = -Math.atan2(bz - az, bx - ax);
      const posts = Math.max(1, Math.round(len / 2.2));
      for (let i = 0; i <= posts; i++) { g.add(box(0.11, h + 0.15, 0.11, m, ax + (dirX * len * i) / posts, (h + 0.15) / 2, az + (dirZ * len * i) / posts)); g.add(place(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.1, 4), m), ax + (dirX * len * i) / posts, h + 0.2, az + (dirZ * len * i) / posts)); }
      for (const y of [h * 0.3, h * 0.78]) { const rail = box(len, 0.07, 0.04, m, (ax + bx) / 2, y, (az + bz) / 2); rail.rotation.y = turn; g.add(rail); }
      const n = Math.max(2, Math.round(len / 0.17));
      for (let i = 0; i <= n; i++) { const p = box(0.08, h, 0.025, m, ax + (dirX * len * i) / n, h / 2 + 0.04, az + (dirZ * len * i) / n); p.rotation.y = turn; p.translateZ(0.035); g.add(p); }
    };
    const hw = width / 2; const hd = depth / 2;
    const sides = { front: [-hw, hd, hw, hd], back: [hw, -hd, -hw, -hd], left: [-hw, -hd, -hw, hd], right: [hw, hd, hw, -hd] };
    for (const [name, [ax, az, bx, bz]] of Object.entries(sides)) {
      if (name !== gate) { run(ax, az, bx, bz); continue; }
      const len = Math.hypot(bx - ax, bz - az); const dx = (bx - ax) / len; const dz = (bz - az) / len; const mid = len / 2 + clamp(gateAt, -len / 2 + gw, len / 2 - gw) * (name === 'front' || name === 'left' ? 1 : -1);
      const a = mid - gw / 2; const b = mid + gw / 2;
      run(ax, az, ax + dx * a, az + dz * a); run(ax + dx * b, az + dz * b, bx, bz);
      for (const t of [a, b]) { g.add(box(0.16, h + 0.45, 0.16, m, ax + dx * t, (h + 0.45) / 2, az + dz * t)); g.add(ball(0.1, m, ax + dx * t, h + 0.52, az + dz * t, 10)); }
      // The gate leaf, standing a little open.
      const leafG = new THREE.Group(); leafG.position.set(ax + dx * a, 0, az + dz * a); leafG.rotation.y = -Math.atan2(dz, dx) - 0.5;
      const lw = gw - 0.12; for (const y of [h * 0.3, h * 0.78]) leafG.add(box(lw, 0.07, 0.04, m, lw / 2 + 0.06, y, 0));
      for (let i = 0; i <= Math.round(lw / 0.17); i++) leafG.add(box(0.08, h, 0.025, m, 0.1 + (lw - 0.08) * (i / Math.round(lw / 0.17)), h / 2 + 0.04, 0.035));
      const brace = box(Math.hypot(lw, h * 0.48), 0.06, 0.03, m, lw / 2 + 0.06, h * 0.54, 0.01); brace.rotation.z = Math.atan2(h * 0.48, lw); leafG.add(brace);
      g.add(leafG);
      g.userData.gate = { x: ax + dx * mid, z: az + dz * mid };
    }
    return g;
  };

  /** A garden or street lamp with its light: lamp(height, lit). */
  kit.lamp = (height = 3, lit = true) => {
    const g = new THREE.Group(); const iron = std('#26282b', { metalness: 0.6, roughness: 0.5 });
    g.add(cyl(0.12, 0.16, 0.3, iron, 0, 0.15, 0), cyl(0.05, 0.07, height, iron, 0, height / 2, 0, 12), cyl(0.2, 0.1, 0.08, iron, 0, height + 0.42, 0, 6));
    g.add(place(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.11, 0.36, 6), std('#fff1c9', { emissive: '#ffd27a', emissiveIntensity: lit ? 2.4 : 0.3, transparent: true, opacity: 0.92 })), 0, height + 0.2, 0));
    if (lit) { const light = new THREE.PointLight('#ffd9a0', 6, 12, 2); light.position.set(0, height + 0.2, 0); g.add(light); }
    return g;
  };

  /** A garden pond with a stone rim, lily pads and reeds: pond(radius). */
  kit.pond = (radius = 2.5) => {
    const g = new THREE.Group(); const rnd = seeded(Math.round(radius * 100) + 1);
    const water = place(new THREE.Mesh(new THREE.CircleGeometry(radius, 40), new THREE.MeshPhysicalMaterial({ color: '#2f7fa8', roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.88 })), 0, 0.05, 0); water.rotation.x = -Math.PI / 2; water.userData.noCast = true; water.name = 'water'; g.add(water);
    const n = Math.round(radius * 9);
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const s = 0.22 + rnd() * 0.16; const rock = place(new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), std(shade('#9a948a', 0.8 + rnd() * 0.4), { flatShading: true })), Math.cos(a) * (radius + 0.08), s * 0.35, Math.sin(a) * (radius + 0.08)); rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3); rock.scale.y = 0.6; rock.userData.standIn = 'rock'; g.add(rock); }
    for (let i = 0; i < 5; i++) { const a = rnd() * Math.PI * 2; const r = rnd() * radius * 0.7; const pad = place(new THREE.Mesh(new THREE.CircleGeometry(0.22 + rnd() * 0.1, 14, 0, Math.PI * 1.8), std('#3f8f45', { side: THREE.DoubleSide })), Math.cos(a) * r, 0.07, Math.sin(a) * r); pad.rotation.x = -Math.PI / 2; pad.rotation.z = rnd() * 6; pad.userData.noCast = true; g.add(pad); if (i % 2 === 0) g.add(ball(0.07, std('#ffd1e8'), Math.cos(a) * r, 0.12, Math.sin(a) * r, 8)); }
    for (let i = 0; i < 7; i++) { const a = 0.4 + rnd() * 0.9; g.add(cyl(0.012, 0.02, 0.9 + rnd() * 0.5, std('#5f8f3a'), Math.cos(a) * (radius - 0.25) + (rnd() - 0.5) * 0.3, 0.5, Math.sin(a) * (radius - 0.25) + (rnd() - 0.5) * 0.3, 5)); }
    return g;
  };

  /** A boulder: rock(size, color). */
  kit.rock = (size = 0.6, color = '#8f8a80') => {
    const rnd = seeded(Math.round(size * 977)); const m = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 1), std(color, { flatShading: true, roughness: 0.95 }));
    m.scale.set(1 + rnd() * 0.5, 0.6 + rnd() * 0.3, 0.8 + rnd() * 0.4); m.rotation.y = rnd() * 6; m.position.y = size * 0.3; const g = new THREE.Group(); g.add(m); return g;
  };

  /** A soft white cloud: cloud(scale). Put it high up. */
  kit.cloud = (scale = 1) => {
    const g = new THREE.Group(); const rnd = seeded(Math.round(scale * 313) + state.clouds++); const m = std('#ffffff', { roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.25 });
    for (let i = 0; i < 6; i++) { const b = ball((1.6 + rnd() * 1.6) * scale, m, (i - 2.5) * 1.9 * scale, rnd() * 0.9 * scale, (rnd() - 0.5) * 2.2 * scale, 14); b.scale.y = 0.62; b.userData.noCast = true; g.add(b); }
    return g;
  };

  /** A family car, 4.4 m long along X: car(color). */
  kit.car = (color = '#b8312f') => {
    const g = new THREE.Group(); const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0.5, clearcoat: 0.8 }); const dark = std('#1c1d1f', { roughness: 0.6 });
    g.add(box(4.4, 0.62, 1.8, paint, 0, 0.62, 0));
    const cabin = box(2.3, 0.6, 1.62, new THREE.MeshPhysicalMaterial({ color: '#27323a', roughness: 0.08, metalness: 0.3 }), -0.2, 1.2, 0); g.add(cabin);
    g.add(box(2.4, 0.07, 1.7, paint, -0.2, 1.52, 0));
    for (const sx of [-1.4, 1.4]) for (const sz of [-0.86, 0.86]) { const w = cyl(0.34, 0.34, 0.24, dark, sx, 0.34, sz, 20); w.rotation.x = Math.PI / 2; g.add(w); const hub = cyl(0.17, 0.17, 0.26, std('#c9ccd1', { metalness: 0.8, roughness: 0.3 }), sx, 0.34, sz, 12); hub.rotation.x = Math.PI / 2; g.add(hub); }
    for (const sz of [-0.62, 0.62]) { g.add(box(0.06, 0.16, 0.34, std('#fff6d0', { emissive: '#fff0b0', emissiveIntensity: 0.6 }), 2.2, 0.72, sz)); g.add(box(0.06, 0.14, 0.34, std('#c21f1f', { emissive: '#7a0d0d', emissiveIntensity: 0.6 }), -2.2, 0.74, sz)); }
    g.add(box(0.1, 0.16, 1.5, dark, 2.2, 0.42, 0), box(0.1, 0.16, 1.5, dark, -2.2, 0.42, 0));
    return g;
  };

  /** A standing person: person(shirtColor, height). */
  kit.person = (shirt = '#3d6fb6', height = 1.7) => {
    const g = new THREE.Group(); const k = height / 1.7; const skin = std('#e0b592'); const trousers = std('#394150');
    for (const s of [-1, 1]) { g.add(box(0.15, 0.82, 0.17, trousers, s * 0.1, 0.41, 0)); g.add(box(0.1, 0.6, 0.12, std(shirt), s * 0.27, 1.1, 0)); g.add(ball(0.055, skin, s * 0.27, 0.78, 0, 8)); g.add(box(0.16, 0.07, 0.26, std('#2a2a2a'), s * 0.1, 0.035, 0.04)); }
    g.add(box(0.42, 0.62, 0.24, std(shirt), 0, 1.12, 0), cyl(0.05, 0.05, 0.08, skin, 0, 1.47, 0, 8), ball(0.13, skin, 0, 1.6, 0, 14));
    const hair = ball(0.135, std('#4a3424'), 0, 1.63, -0.02, 14); hair.scale.set(1, 0.8, 1); g.add(hair);
    g.scale.setScalar(k); return g;
  };

  /** A child's swing on an A-frame: swing(color). */
  kit.swing = (color = '#c94f3d') => {
    const g = new THREE.Group(); const m = std(color, { roughness: 0.6 }); const rope = std('#d8cfb8');
    for (const sx of [-1.1, 1.1]) for (const sz of [-1, 1]) { const leg = cyl(0.045, 0.045, 2.3, m, sx, 1.1, sz * 0.5, 8); leg.rotation.x = -sz * 0.42; g.add(leg); }
    const beam = cyl(0.05, 0.05, 2.4, m, 0, 2.12, 0, 8); beam.rotation.z = Math.PI / 2; g.add(beam);
    for (const sx of [-0.24, 0.24]) g.add(cyl(0.012, 0.012, 1.6, rope, sx, 1.32, 0, 5));
    g.add(box(0.56, 0.04, 0.2, std('#f2c14e'), 0, 0.52, 0)); return g;
  };

  /** A vegetable bed with rows of plants in a timber frame: vegetablePatch(width, depth). */
  kit.vegetablePatch = (width = 3, depth = 2) => {
    const g = new THREE.Group(); const timber = std('#7a5230'); const rnd = seeded(Math.round(width * 53 + depth * 17));
    g.add(box(width, 0.22, depth, surfaced('soil', '#4a3323', width, depth), 0, 0.11, 0));
    for (const s of [-1, 1]) g.add(box(width + 0.12, 0.3, 0.07, timber, 0, 0.15, s * (depth / 2 + 0.03)), box(0.07, 0.3, depth, timber, s * (width / 2 + 0.03), 0.15, 0));
    const rows = Math.max(2, Math.round(depth / 0.5));
    for (let r = 0; r < rows; r++) for (let i = 0; i < Math.round(width / 0.35); i++) g.add(blob(0.1 + rnd() * 0.06, leaf(r % 2 ? '#5fa83f' : '#2f7d3a'), -width / 2 + 0.25 + i * 0.35, 0.3, -depth / 2 + 0.3 + (r * (depth - 0.6)) / Math.max(1, rows - 1)));
    return g;
  };

  /** A post-mounted letterbox: mailbox(color). */
  kit.mailbox = (color = '#c0392b') => {
    const g = new THREE.Group(); g.add(box(0.09, 1.05, 0.09, std('#6b4a32'), 0, 0.525, 0), box(0.24, 0.22, 0.44, std(color, { metalness: 0.3, roughness: 0.5 }), 0, 1.16, 0), box(0.02, 0.16, 0.1, std('#f2c14e'), 0.13, 1.2, 0.1)); return g;
  };
}
