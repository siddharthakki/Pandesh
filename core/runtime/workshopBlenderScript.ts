/**
 * The Blender side of render_scene (workshopBlender.ts): one fixed Python script. Core writes it next to a job file and
 * runs `blender -b --factory-startup --python render_scene.py -- job.json`.
 *
 * Nothing in it is written by a model. It reads the scene's own export (binary glTF + a list of stand-ins) and the asset
 * library, as data: it places real assets where the stand-ins stood, covers a grass ground with real grass, lights the
 * scene with the library's sky, renders the views with Cycles and saves an editable .blend. What it did goes to
 * result.json, which is all Core reads back.
 *
 * Kept as a string so it ships inside the Core bundle. No backticks and no dollar-brace inside.
 */
export const RENDER_SCENE_PY = String.raw`
import bpy, json, math, os, random, sys, time, traceback
from mathutils import Vector

job_path = sys.argv[sys.argv.index('--') + 1]
job = json.load(open(job_path, encoding='utf-8'))
OUT = job['out']
result = {'ok': False, 'pictures': [], 'used': {}, 'warnings': [], 'blend': None}
started = time.time()
rnd = random.Random(7)

def P(x, z, up=0.0):   # three.js ground position (x right, z towards the viewer) to Blender (x, -z, up)
    return Vector((x, -z, up))

def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c); lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi

def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    info = job.get('scene') or {}
    roles = job.get('roles') or {}

    # ---- the scene as the Workshop drew it
    bpy.ops.import_scene.gltf(filepath=job['glb'])
    built = bpy.data.collections.new('Scene (from the Workshop)'); scene.collection.children.link(built)
    for o in list(scene.collection.objects):
        scene.collection.objects.unlink(o); built.objects.link(o)
    bpy.context.view_layer.update()
    built_meshes = [o for o in built.objects if o.type == 'MESH']
    if not built_meshes: raise RuntimeError('the exported scene holds no geometry')
    for o in built_meshes:   # tuned for a live view: here surfaces go matt, glass clear, water dark and mirror-like
        for slot in o.material_slots:
            m = slot.material; b = m.node_tree.nodes.get('Principled BSDF') if m and m.node_tree else None
            if not b: continue
            if o.name.split('.')[0] == 'water':
                b.inputs['Base Color'].default_value = (0.012, 0.045, 0.05, 1); b.inputs['Roughness'].default_value = 0.02; b.inputs['Alpha'].default_value = 1.0
            elif b.inputs['Alpha'].default_value < 0.9: b.inputs['Roughness'].default_value = 0.03
            elif not b.inputs['Roughness'].is_linked and not b.inputs['Metallic'].default_value > 0.5:
                b.inputs['Roughness'].default_value = max(b.inputs['Roughness'].default_value, 0.72)
    lo, hi = bounds(built_meshes)
    cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2; width, depth, height = hi.x - lo.x, hi.y - lo.y, hi.z
    radius = max(2.0, 0.5 * math.hypot(width, depth)); c3 = (cx, -cy)   # centre in three.js x/z

    # ---- the asset library: only what the roles name, each thing standing at the origin
    library = bpy.data.collections.new('Asset library (hidden)'); scene.collection.children.link(library); library.hide_render = True
    lib_root = job['library']; manifest = json.load(open(os.path.join(lib_root, 'manifest.json'), encoding='utf-8'))
    by_id = {a['id']: a for a in manifest.get('assets', [])}
    sets = set(roles.get('sets') or []); things = {}
    def load(asset_id):
        if asset_id in things: return things[asset_id]
        a = by_id.get(asset_id)
        if not a or a.get('kind') != 'model': things[asset_id] = []; return []
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(lib_root, a['folder'], a['file']))
        new = [o for o in bpy.data.objects if o not in before]
        for o in new:
            for c in list(o.users_collection): c.objects.unlink(o)
            library.objects.link(o)
        bpy.context.view_layer.update()
        meshes = [o for o in new if o.type == 'MESH']; out = []
        for group in ([[m] for m in meshes] if asset_id in sets else [meshes]):
            for o in group:
                world = o.matrix_world.copy(); o.parent = None; o.matrix_world = world
            bpy.context.view_layer.update()
            glo, ghi = bounds(group)
            shift = Vector((-(glo.x + ghi.x) / 2, -(glo.y + ghi.y) / 2, -glo.z))
            for o in group: o.location = o.location + shift
            out.append({'objects': group, 'size': ghi - glo})
        for o in new:
            if o.type != 'MESH': bpy.data.objects.remove(o)
        bpy.context.view_layer.update()
        things[asset_id] = out; return out
    def role(name):
        for asset_id in roles.get(name) or []:
            if load(asset_id): return asset_id
        return None

    placed = {}
    def put(asset_id, x, z, scale=1.0, turn=None, up=0.0, squash=1.0, group='Planting'):
        options = things.get(asset_id) or []
        if not options: return None
        col = placed.get(group)
        if col is None:
            col = bpy.data.collections.new(group); scene.collection.children.link(col); placed[group] = col
        thing = rnd.choice(options)
        root = bpy.data.objects.new(asset_id, None); root.empty_display_size = 0.2; col.objects.link(root)
        root.location = P(x, z, up); root.rotation_euler = (0, 0, rnd.uniform(0, math.tau) if turn is None else turn); root.scale = (scale, scale, scale * squash)
        for src in thing['objects']:
            o = bpy.data.objects.new(src.name, src.data); col.objects.link(o); o.matrix_basis = src.matrix_basis.copy(); o.parent = root
        result['used'][asset_id] = result['used'].get(asset_id, 0) + 1
        return root
    def size_of(asset_id):
        s = things[asset_id][0]['size']; return max(s.x, s.y), s.z

    # ---- real assets where the scene's stand-ins stood
    tree = role('tree'); bush = role('bush'); rock = role('rock'); lamp = role('lamp'); tableset = role('tableset')
    sink = float((roles.get('bushSink') or 0.37))
    def put_bush(x, z, across, up=0.0):
        w, h = size_of(bush); s = max(0.2, across / w * 1.15); put(bush, x, z, s, up=up - sink * h * s, group='Bushes')
    for s in (info.get('standIns') or []):
        kind = s.get('kind'); x = float(s.get('x', 0)); z = float(s.get('z', 0)); w = float(s.get('w', 1)); d = float(s.get('d', 1)); h = float(s.get('h', 1)); base = float(s.get('base', 0)); turn = float(s.get('turn', 0))
        if kind == 'tree' and tree:
            put(tree, x, z, min(4.0, max(0.5, h / size_of(tree)[1])), up=base, group='Trees')
        elif kind == 'shrub' and bush: put_bush(x, z, max(w, d), base)
        elif kind == 'hedge' and bush:
            step = max(0.5, h * 0.75); n = max(1, int(round(w / step)))
            for i in range(n + 1):
                t = -w / 2 + w * i / n if n else 0.0
                put_bush(x + math.cos(turn) * t + rnd.uniform(-0.08, 0.08), z - math.sin(turn) * t + rnd.uniform(-0.08, 0.08), max(d, h) * 1.25, base)
        elif kind == 'rock' and rock:
            options = things[rock]; biggest = max(max(o['size'].x, o['size'].y) for o in options)
            put(rock, x, z, max(0.05, max(w, d) / biggest * 1.3), up=base - 0.03, group='Rocks')
        elif kind == 'lamp' and lamp: put(lamp, x, z, max(0.3, h / size_of(lamp)[1]), turn=turn, up=base, group='Lamps')
        elif kind == 'tableset' and tableset: put(tableset, x, z, 1.0, turn=turn, up=base, group='Furniture')

    # ---- ground: a grass ground becomes a lawn with real blades and trees beyond; any other keeps its colour
    def material(name, build):
        m = bpy.data.materials.new(name); m.use_nodes = True; build(m.node_tree, m.node_tree.nodes['Principled BSDF']); return m
    def lawn(nt, b):
        co = nt.nodes.new('ShaderNodeTexCoord')
        big = nt.nodes.new('ShaderNodeTexNoise'); big.inputs['Scale'].default_value = 0.25; big.inputs['Detail'].default_value = 3
        fine = nt.nodes.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value = 40; fine.inputs['Detail'].default_value = 6
        ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].position = 0.3; ramp.color_ramp.elements[1].position = 0.75
        ramp.color_ramp.elements[0].color = (0.045, 0.085, 0.02, 1); ramp.color_ramp.elements[1].color = (0.085, 0.135, 0.032, 1)
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs['Factor'].default_value = 0.5
        bump = nt.nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.4; bump.inputs['Distance'].default_value = 0.03
        nt.links.new(co.outputs['Object'], big.inputs['Vector']); nt.links.new(co.outputs['Object'], fine.inputs['Vector'])
        nt.links.new(big.outputs['Fac'], ramp.inputs['Fac']); nt.links.new(ramp.outputs['Color'], mix.inputs['A']); nt.links.new(fine.outputs['Color'], mix.inputs['B'])
        nt.links.new(mix.outputs['Result'], b.inputs['Base Color']); nt.links.new(fine.outputs['Fac'], bump.inputs['Height']); nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
        b.inputs['Roughness'].default_value = 0.95
    ground = info.get('ground'); grassy = bool(ground) and ground.get('surface') == 'grass'
    if ground:
        def plain(nt, b):
            hexc = str(ground.get('color') or '#808080').lstrip('#')
            try: rgb = [pow(int(hexc[i:i + 2], 16) / 255, 2.2) for i in (0, 2, 4)]
            except Exception: rgb = [0.2, 0.2, 0.2]
            b.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1); b.inputs['Roughness'].default_value = 0.08 if ground.get('surface') == 'water' else 0.9
        mesh = bpy.data.meshes.new('Ground'); e = 900
        mesh.from_pydata([P(-e, -e), P(e, -e), P(e, e), P(-e, e)], [], [(0, 3, 2, 1)]); mesh.materials.append(material('Ground', lawn if grassy else plain))
        gcol = bpy.data.collections.new('Ground'); scene.collection.children.link(gcol); gcol.objects.link(bpy.data.objects.new('Ground', mesh))
    grass = role('grass') if grassy else None
    if grass:
        margin = 3.0; x0, x1 = lo.x - margin, hi.x + margin; y0, y1 = lo.y - margin, hi.y + margin
        cell = 0.25; nx = max(1, int((x1 - x0) / cell)); ny = max(1, int((y1 - y0) / cell))
        if nx * ny > 400000: cell = math.sqrt((x1 - x0) * (y1 - y0) / 400000); nx = max(1, int((x1 - x0) / cell)); ny = max(1, int((y1 - y0) / cell))
        taken = bytearray(nx * ny); area = (x1 - x0) * (y1 - y0)
        for o in built_meshes:   # nothing grows where something stands or is paved; a mesh as wide as the scene is its ground
            olo, ohi = bounds([o])
            if (ohi.x - olo.x) * (ohi.y - olo.y) > 0.45 * area and ohi.z - olo.z < 0.4: continue
            if olo.z > 2.2: continue
            for ix in range(max(0, int((olo.x - 0.06 - x0) / cell)), min(nx, int((ohi.x + 0.06 - x0) / cell) + 1)):
                for iy in range(max(0, int((olo.y - 0.06 - y0) / cell)), min(ny, int((ohi.y + 0.06 - y0) / cell) + 1)): taken[iy * nx + ix] = 1
        free = [i for i in range(nx * ny) if not taken[i]]
        want = min(int(job.get('maxGrass', 24000)), int(len(free) * cell * cell * 30))
        for _ in range(want):
            i = rnd.choice(free); x = x0 + (i % nx + rnd.random()) * cell; y = y0 + (i // nx + rnd.random()) * cell
            put(grass, x, -y, rnd.uniform(0.9, 1.45), squash=0.42, group='Grass')
        flowers = [f for f in (roles.get('flowers') or []) if load(f)]
        if flowers and free:
            for _ in range(8):
                i = rnd.choice(free); fx = x0 + (i % nx) * cell; fy = y0 + (i // nx) * cell
                for _ in range(22):
                    x = fx + rnd.gauss(0, 0.9); y = fy + rnd.gauss(0, 0.9); ix = int((x - x0) / cell); iy = int((y - y0) / cell)
                    if 0 <= ix < nx and 0 <= iy < ny and not taken[iy * nx + ix]: put(rnd.choice(flowers), x, -y, rnd.uniform(0.9, 1.5), group='Flowers')
    if grassy and tree:
        made = 0; tries = 0
        while made < int(job.get('treesBeyond', 60)) and tries < 2000:   # so the horizon is not a bare line; none between the cameras and the scene
            tries += 1; a = rnd.uniform(0, math.tau); r = rnd.uniform(radius * 1.35, radius * 6); x = c3[0] + math.cos(a) * r; z = c3[1] + math.sin(a) * r
            if z - c3[1] > radius * 0.55: continue
            if lo.x - 2 < x < hi.x + 2 and lo.y - 2 < -z < hi.y + 2: continue
            put(tree, x, z, rnd.uniform(1.8, 3.4), group='Trees beyond'); made += 1

    # ---- light: the library's sky, sun towards the front of the scene
    world = bpy.data.worlds.new('Sky'); scene.world = world; world.use_nodes = True; wn = world.node_tree
    sky = next((by_id[s] for s in (roles.get('sky') or []) if s in by_id), None)
    if sky:
        env = wn.nodes.new('ShaderNodeTexEnvironment'); env.image = bpy.data.images.load(os.path.join(lib_root, sky['folder'], sky['file']))
        mapping = wn.nodes.new('ShaderNodeMapping'); coord = wn.nodes.new('ShaderNodeTexCoord'); mapping.inputs['Rotation'].default_value = (0, 0, math.radians(float(roles.get('skyTurn', 35))))
        wn.links.new(coord.outputs['Generated'], mapping.inputs['Vector']); wn.links.new(mapping.outputs['Vector'], env.inputs['Vector']); wn.links.new(env.outputs['Color'], wn.nodes['Background'].inputs['Color'])
        result['used'][sky['id']] = 1
    else:
        wn.nodes['Background'].inputs['Color'].default_value = (0.5, 0.7, 1.0, 1); result['warnings'].append('the library has no sky: plain sky light, no sun shadows')
        sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), 0, math.radians(-35)); scene.collection.objects.link(sun)

    # ---- cameras, framed from the size of what was built
    cams = bpy.data.collections.new('Cameras'); scene.collection.children.link(cams)
    look = min(height * 0.36, radius * 0.5)
    VIEWS = {'hero': ((-0.70, 1.22, 0.135), 32), 'aerial': ((-1.25, 1.35, 1.0), 35), 'front': ((0.05, 1.42, 0.17), 35)}
    def camera(name):
        (kx, kz, ky), lens = VIEWS[name]
        data = bpy.data.cameras.new(name); data.lens = lens; data.clip_end = 4000; o = bpy.data.objects.new(name, data); cams.objects.link(o)
        o.location = P(c3[0] + radius * kx, c3[1] + radius * kz, max(1.5, radius * ky)); d = P(c3[0], c3[1], look) - o.location; o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler(); return o

    # ---- render
    scene.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('OPTIX', 'CUDA', 'HIP', 'ONEAPI', 'METAL'):
            try: prefs.compute_device_type = kind
            except Exception: continue
            prefs.get_devices(); gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices: d.use = d.type == kind
                scene.cycles.device = 'GPU'; result['device'] = kind + ': ' + ', '.join(d.name for d in gpus); break
        else: result['device'] = 'CPU'
    except Exception as e: result['device'] = 'CPU'; result['warnings'].append('graphics card not used: ' + str(e)[:120])
    scene.cycles.samples = int(job.get('samples', 128)); scene.cycles.use_denoising = True; scene.cycles.transparent_max_bounces = 24; scene.cycles.max_bounces = 8
    w = int(job.get('width', 1600)); scene.render.resolution_x = w; scene.render.resolution_y = int(w * 10 / 16)
    scene.render.image_settings.file_format = 'JPEG'; scene.render.image_settings.quality = 92
    try: scene.view_settings.look = 'AgX - Medium High Contrast'
    except Exception: pass
    first = None
    for view in (job.get('views') or ['hero', 'aerial', 'front']):
        if view not in VIEWS: continue
        cam = camera(view); first = first or cam; scene.camera = cam
        path = os.path.join(OUT, view + '.jpg'); scene.render.filepath = path; bpy.ops.render.render(write_still=True)
        if os.path.exists(path) and os.path.getsize(path) > 2000: result['pictures'].append({'view': view, 'path': path})
    result['objects'] = len(bpy.data.objects); result['size'] = [round(width, 2), round(height, 2), round(depth, 2)]
    if job.get('saveBlend', True) and first:
        scene.camera = first
        try:
            bpy.ops.file.pack_all(); blend = os.path.join(OUT, 'scene.blend'); bpy.ops.wm.save_as_mainfile(filepath=blend); result['blend'] = blend
        except Exception as e: result['warnings'].append('the Blender project was not saved: ' + str(e)[:160])
    result['ok'] = len(result['pictures']) > 0

try:
    main()
except Exception as e:
    result['ok'] = False; result['error'] = (str(e) or e.__class__.__name__)[:400]; result['trace'] = traceback.format_exc()[-1500:]
result['seconds'] = round(time.time() - started, 1)
json.dump(result, open(os.path.join(OUT, 'result.json'), 'w', encoding='utf-8'), indent=1)
`;
