"""Helpers for modelling Claude Office catalog items in Blender (run headless).

Conventions: Blender is Z-up, metres. Build items standing on z=0, centred on x=y=0,
with their front facing -Y. finish(__file__) exports model.glb (Y-up glTF) and a thumbnail.

    import sys, os; sys.path.insert(0, os.getcwd()); from office_blender import *
    reset()
    seat = box(1.0, 0.8, 0.4, z=0.2, color="#a8c5b5")
    leg = cylinder(0.04, 0.2, x=0.4, y=0.3, z=0.1, color="#333333")
    finish(__file__)
"""
import bpy
import math
import os
import sys

_materials = {}
_keep_shading = [False]  # imported models keep their own smooth/flat shading


def reset():
    """Empty the scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _materials.clear()
    _keep_shading[0] = False


def material(color="#ffffff", roughness=0.7, metallic=0.0, emission=None, alpha=1.0):
    """Get/create a Principled material from a hex color like '#aabbcc'."""
    key = (color, roughness, metallic, emission, alpha)
    if key in _materials:
        return _materials[key]
    m = bpy.data.materials.new(name=f"m_{len(_materials)}")
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    r, g, b = _hex(color)
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
    if emission:
        er, eg, eb = _hex(emission)
        for name in ("Emission Color", "Emission"):
            if name in bsdf.inputs:
                bsdf.inputs[name].default_value = (er, eg, eb, 1.0)
                break
        bsdf.inputs["Emission Strength"].default_value = 2.0
    m.diffuse_color = (r, g, b, alpha)
    _materials[key] = m
    return m


def _hex(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb)


def _finish_obj(obj, color, x, y, z, rx, ry, rz, mat=None):
    obj.location = (x, y, z)
    obj.rotation_euler = (math.radians(rx), math.radians(ry), math.radians(rz))
    obj.data.materials.append(mat or material(color))
    return obj


def box(w, d, h, x=0, y=0, z=0, color="#ffffff", rx=0, ry=0, rz=0, bevel=0.0, mat=None):
    """Box of width w (x), depth d (y), height h (z), centred at (x, y, z)."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.scale = (w, d, h)
    bpy.ops.object.transform_apply(scale=True)
    if bevel > 0:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return _finish_obj(o, color, x, y, z, rx, ry, rz, mat)


def cylinder(r, h, x=0, y=0, z=0, color="#ffffff", sides=12, rx=0, ry=0, rz=0, r2=None, mat=None):
    """Cylinder (or truncated cone if r2 is given) of radius r and height h centred at (x, y, z)."""
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=r, depth=h)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=r, radius2=r2, depth=h)
    return _finish_obj(bpy.context.active_object, color, x, y, z, rx, ry, rz, mat)


def cone(r, h, x=0, y=0, z=0, color="#ffffff", sides=12, rx=0, ry=0, rz=0, mat=None):
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=r, radius2=0, depth=h)
    return _finish_obj(bpy.context.active_object, color, x, y, z, rx, ry, rz, mat)


def sphere(r, x=0, y=0, z=0, color="#ffffff", detail=2, sx=1, sy=1, sz=1, mat=None):
    """Low-poly icosphere; sx/sy/sz squash it."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=detail, radius=r)
    o = bpy.context.active_object
    o.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    return _finish_obj(o, color, x, y, z, 0, 0, 0, mat)


def torus(r, thickness, x=0, y=0, z=0, color="#ffffff", rx=0, ry=0, rz=0, mat=None):
    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=thickness, major_segments=16, minor_segments=6)
    return _finish_obj(bpy.context.active_object, color, x, y, z, rx, ry, rz, mat)


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def sprite_voxels(image_path, crop=None, frames=None, frame=0, grid=None, cell=(0, 0), height=1.4, depth=None, max_px=64,
                  alpha_cut=0.5, x=0, y=0, z=0):
    """Turn a 2D sprite (e.g. game art) into a chunky voxel model: every opaque pixel becomes a coloured block.

    image_path: PNG path. Pick one sprite with crop=(x, y, w, h) in pixels from the TOP-left, frames=N (+ frame=i)
    for a horizontal strip of N equal frames, or grid=(cols, rows) + cell=(col, row) for a sprite-sheet grid
    (Godot: hframes/vframes; row 0 is usually the front-facing direction). The sprite is downsampled so its longest side is at most max_px
    blocks, scaled to `height` metres tall, and is `depth` thick (default: 2 blocks). Front faces -Y.
    Returns the object. Call finish(__file__) afterwards as usual.
    """
    img = bpy.data.images.load(image_path)
    W, H = img.size
    px = list(img.pixels)  # RGBA floats, rows bottom-up
    if grid:
        fw, fh = W // int(grid[0]), H // int(grid[1])
        crop = (fw * int(cell[0]), fh * int(cell[1]), fw, fh)
    elif frames:
        fw = W // int(frames)
        crop = (fw * int(frame), 0, fw, H)
    cx, cy, cw, ch = crop or (0, 0, W, H)
    # trim fully transparent margins so the model sits on the floor and is centred
    def alpha(ix, iy_top):
        iy = H - 1 - iy_top
        return px[(iy * W + ix) * 4 + 3]
    xs = [ix for ix in range(cx, cx + cw) for iy in range(cy, cy + ch, max(1, ch // 64)) if alpha(ix, iy) > alpha_cut]
    ys = [iy for iy in range(cy, cy + ch) for ix in range(cx, cx + cw, max(1, cw // 64)) if alpha(ix, iy) > alpha_cut]
    if not xs or not ys:
        raise SystemExit("sprite has no opaque pixels in that area")
    x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1
    tw, th = x1 - x0, y1 - y0
    step = max(1, math.ceil(max(tw, th) / max_px))
    gw, gh = math.ceil(tw / step), math.ceil(th / step)
    # sample each block: majority alpha, and its most common colour (averaging would smear dark outlines in)
    grid = {}
    for gx in range(gw):
        for gy in range(gh):  # gy from the top
            counts = {}
            n = tot = 0
            for ix in range(x0 + gx * step, min(x1, x0 + (gx + 1) * step)):
                for iy_top in range(y0 + gy * step, min(y1, y0 + (gy + 1) * step)):
                    tot += 1
                    i = ((H - 1 - iy_top) * W + ix) * 4
                    if px[i + 3] > alpha_cut:
                        key = (round(px[i] * 31), round(px[i + 1] * 31), round(px[i + 2] * 31))
                        counts[key] = counts.get(key, 0) + 1
                        n += 1
            if n and n * 2 >= tot:
                k = max(counts, key=counts.get)
                grid[(gx, gh - 1 - gy)] = (k[0] / 31, k[1] / 31, k[2] / 31)  # key: (column, row from the bottom)
    s = height / gh
    d = depth if depth else s * 2
    verts, faces, cols = [], [], []

    def quad(p, col):
        base = len(verts)
        verts.extend(p)
        faces.append((base, base + 1, base + 2, base + 3))
        cols.append(col)

    for (gx, gz), col in grid.items():
        X0, X1 = (gx - gw / 2) * s, (gx + 1 - gw / 2) * s
        Z0, Z1 = gz * s, (gz + 1) * s
        Y0, Y1 = -d / 2, d / 2
        lin = tuple(_srgb_to_linear(c) for c in col)
        side = tuple(c * 0.8 for c in lin)  # slightly darker sides read as depth
        quad([(X0, Y0, Z0), (X1, Y0, Z0), (X1, Y0, Z1), (X0, Y0, Z1)], lin)          # front (-Y)
        quad([(X1, Y1, Z0), (X0, Y1, Z0), (X0, Y1, Z1), (X1, Y1, Z1)], lin)          # back
        if (gx - 1, gz) not in grid: quad([(X0, Y1, Z0), (X0, Y0, Z0), (X0, Y0, Z1), (X0, Y1, Z1)], side)
        if (gx + 1, gz) not in grid: quad([(X1, Y0, Z0), (X1, Y1, Z0), (X1, Y1, Z1), (X1, Y0, Z1)], side)
        if (gx, gz - 1) not in grid: quad([(X0, Y1, Z0), (X1, Y1, Z0), (X1, Y0, Z0), (X0, Y0, Z0)], side)
        if (gx, gz + 1) not in grid: quad([(X0, Y0, Z1), (X1, Y0, Z1), (X1, Y1, Z1), (X0, Y1, Z1)], tuple(min(1, c * 1.1) for c in lin))
    mesh = bpy.data.meshes.new("sprite")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    attr = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    for fi, poly in enumerate(mesh.polygons):
        r, g, b = cols[fi]
        for li in range(poly.loop_start, poly.loop_start + poly.loop_total):
            attr.data[li].color = (r, g, b, 1.0)
    mesh.color_attributes.active_color = attr
    m = bpy.data.materials.new("sprite_mat")
    m.use_nodes = True
    nodes = m.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.85
    cnode = nodes.new("ShaderNodeVertexColor")
    cnode.layer_name = "Col"
    m.node_tree.links.new(cnode.outputs["Color"], bsdf.inputs["Base Color"])
    mesh.materials.append(m)
    obj = bpy.data.objects.new("sprite", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (x, y, z)
    print(f"sprite_voxels: {gw}x{gh} blocks, {len(grid)} filled, {len(faces) * 2} triangles")
    return obj


def _socket_color(sock, depth=0):
    """Best-effort flat colour for a (possibly procedural) colour input: averages mixes and ramps."""
    if depth > 8:
        return None
    if not sock.is_linked:
        v = sock.default_value
        try:
            return (v[0], v[1], v[2])
        except TypeError:
            return (v, v, v)
    n = sock.links[0].from_node
    if n.type == "TEX_IMAGE":
        return None  # real image textures export fine; leave them alone
    if n.type == "VALTORGB":  # colour ramp
        els = n.color_ramp.elements
        return tuple(sum(e.color[i] for e in els) / len(els) for i in range(3))
    if n.type in ("RGB",):
        v = n.outputs[0].default_value
        return (v[0], v[1], v[2])
    cols = []
    for inp in n.inputs:
        if inp.type in ("RGBA", "VECTOR") and inp.name not in ("Vector", "Normal"):
            c = _socket_color(inp, depth + 1)
            if c:
                cols.append(c)
    if not cols:
        return None
    return tuple(sum(c[i] for c in cols) / len(cols) for i in range(3))


def _flatten_materials(objs):
    """glTF can't carry procedural node textures: bake each to its average colour (images are kept)."""
    seen = set()
    for o in objs:
        for m in getattr(o.data, "materials", []):
            if not m or m.name in seen:
                continue
            seen.add(m.name)
            if not m.use_nodes:
                continue
            bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if not bsdf:
                continue
            inp = bsdf.inputs["Base Color"]
            if inp.is_linked and inp.links[0].from_node.type == "TEX_IMAGE":
                continue
            c = _socket_color(inp)
            if c:
                for l in list(inp.links):
                    m.node_tree.links.remove(l)
                inp.default_value = (c[0], c[1], c[2], 1.0)
            v = inp.default_value
            m.diffuse_color = (v[0], v[1], v[2], 1.0)  # viewport colour, used for the thumbnail


def import_model(model_path, height=None, rot_z=0, keep_materials=True):
    """Import an existing 3D model (.glb/.gltf/.obj/.fbx/.blend) as a catalog item, unchanged in shape.

    It's scaled so its height is `height` metres (if given), centred on x=y=0 and stood on z=0.
    rot_z (degrees) turns it so its front faces -Y if it was authored facing another way.
    Returns the list of imported mesh objects. Call finish(__file__) afterwards.
    """
    import mathutils
    ext = os.path.splitext(model_path)[1].lower()
    before = set(bpy.context.scene.objects)
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=model_path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=model_path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=model_path)
    elif ext == ".blend":
        with bpy.data.libraries.load(model_path, link=False) as (src, dst):
            dst.objects = [n for n in src.objects]
        for o in dst.objects:
            if o is not None and o.type in ("MESH", "EMPTY", "CURVE", "SURFACE", "META", "FONT"):
                bpy.context.scene.collection.objects.link(o)
    else:
        raise SystemExit(f"unsupported model type {ext}")
    new = [o for o in bpy.context.scene.objects if o not in before]
    # drop cameras/lights/armature helpers that came along; keep meshes (and their parents)
    for o in new:
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)
    # curves, text and surfaces (e.g. a bent handle) become meshes too
    others = [o for o in bpy.context.scene.objects if o in new and o.type in ("CURVE", "SURFACE", "META", "FONT")]
    if others:
        bpy.ops.object.select_all(action="DESELECT")
        for o in others:
            o.select_set(True)
        bpy.context.view_layer.objects.active = others[0]
        bpy.ops.object.convert(target="MESH")
    new = set(bpy.context.scene.objects) - before
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and o in new]
    if not meshes:
        raise SystemExit("the model contained no meshes")
    # bake transforms (also flattens parent hierarchies) so sizing is reliable
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for o in [o for o in bpy.context.scene.objects if o.type == "EMPTY"]:
        bpy.data.objects.remove(o, do_unlink=True)
    _flatten_materials(meshes)
    if not keep_materials:
        for o in meshes:
            o.data.materials.clear()
            o.data.materials.append(material("#d9d4cc"))
    pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
    lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    s = (height / max(hi.z - lo.z, 1e-6)) if height else 1.0
    centre = mathutils.Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    rot = mathutils.Matrix.Rotation(math.radians(rot_z), 4, "Z")
    for o in meshes:
        o.data.transform(mathutils.Matrix.Translation(-centre))
        o.data.transform(mathutils.Matrix.Scale(s, 4))
        o.data.transform(rot)
        o.data.update()
    _keep_shading[0] = True
    size = (hi - lo) * s
    print(f"import_model: {len(meshes)} meshes, now {size.x:.2f} x {size.y:.2f} x {size.z:.2f} m")
    return meshes


def shade_flat():
    if _keep_shading[0]:
        return
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            for p in o.data.polygons:
                p.use_smooth = False


def finish(script_path):
    """Export model.glb and render thumb.png next to the given make.py."""
    out = os.path.dirname(os.path.abspath(script_path))
    shade_flat()
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh objects were created")
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, "model.glb"), export_format="GLB",
                              use_selection=True, export_apply=True, export_yup=True)
    _thumbnail(os.path.join(out, "thumb.png"), meshes)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    print(f"OFFICE_ITEM_OK triangles={tris}")


def _thumbnail(path, meshes):
    import mathutils
    pts = [o.matrix_world @ mathutils.Vector(c) for o in meshes for c in o.bound_box]
    lo = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    size = max((hi - lo).length, 0.3)
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size * 1.15
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    # front-right isometric view, matching the office camera
    direction = mathutils.Vector((1, -1, 0.95)).normalized()
    cam.location = center + direction * size * 3
    cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(30))
    scene.collection.objects.link(sun)
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "VERTEX" if any(len(o.data.color_attributes) for o in meshes) else "MATERIAL"
    shading.show_shadows = True
    shading.show_cavity = True
    scene.render.film_transparent = True
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
