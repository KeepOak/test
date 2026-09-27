"""Builds the classic pebble in Blender and renders its animation passes, headless:

  blender -b --factory-startup -P design/art/pebble/pebble_blender.py -- --out <folder> [options]

Options (all optional):
  --states idle,think,...   which states (default: all in pebble_motion.STATES)
  --shapes 0,1,2,3,4        which body shapes, by index (default: all)
  --eyes round,wide,sleepy  which eye styles (default: all)
  --passes body,light,fx    which passes (default: all)
  --samples 64              render samples
  --save-blend <file>       save the built scene (with the first state's animation) and stop
  --no-render               build only

Three passes, so the window can tint the body in any colour without a render per colour:
  body  <out>/<state>/body-<shape>/####.png   the body alone in white: its grey is pure shading (multiply by colour)
  light <out>/<state>/light-<shape>/####.png  the same body's gloss and warm rim on black, half size (added on top)
  fx    <out>/<state>/fx-<eyes>/####.png      eyes, mouth, effects and the contact shadow, the body held out
The motion of the body is the same for every shape, so one eyes-and-effects pass serves all five.
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pebble_motion as M  # noqa: E402

# The window's five shapes (public/app/core/ui.js SHAPES): CSS border-radius on a square box.
SHAPES = ["50%", "58% 42% 54% 46% / 52% 56% 44% 48%", "46% 54% 42% 58% / 60% 44% 56% 40%",
          "62% 38% 50% 50% / 45% 55% 45% 55%", "42% 58% 58% 42% / 50% 42% 58% 50%"]
# The window's three eye styles (prototype.html .av .eye, .av.wide .eye, .av.sleepy .eye), as % of the box:
# left of each eye, top, width, height.
EYES = {"round": ((32, 55), 34, 15, 24), "wide": ((28, 54), 30, 19, 28), "sleepy": ((32, 55), 44, 15, 9)}
EYE_TILT = -8.0            # rotate(-8deg)
DEPTH = 0.84               # front-to-back thickness of the body against its width
BODY_SHARE = 0.70          # the body's box is 70% of the frame; the rest is room for hops and effects
BOTTOM = 0.08              # share of the frame under the body
SIZE = 144                 # frame size in pixels
ORTHO = 2.0 / BODY_SHARE
# Light, calibrated so the white body's lit side reads just under 1.0 and its shadow side stays near 0.45: the window
# multiplies this grey by the chosen colour, so no colour goes muddy or blows out.
KEY, FILL, RIMLIGHT, AMBIENT = 330.0, 90.0, 260.0, 0.16
RIM = 0.1                  # warm rim glow in the light pass


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"out": None, "states": list(M.STATES), "shapes": list(range(5)), "eyes": list(EYES),
           "passes": ["body", "light", "fx"], "samples": 64, "save_blend": None, "render": True, "every": 1}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k == "--no-render":
            out["render"] = False
            i += 1
            continue
        v = argv[i + 1]
        if k == "--out": out["out"] = v
        elif k == "--states": out["states"] = v.split(",")
        elif k == "--shapes": out["shapes"] = [int(s) for s in v.split(",")]
        elif k == "--eyes": out["eyes"] = v.split(",")
        elif k == "--passes": out["passes"] = v.split(",")
        elif k == "--samples": out["samples"] = int(v)
        elif k == "--save-blend": out["save_blend"] = v
        elif k == "--every": out["every"] = int(v)
        i += 2
    return out


# ---------- the outline of a CSS border-radius shape ----------

def radii(css):
    """Horizontal and vertical radius of each corner (TL, TR, BR, BL) as fractions of the box."""
    h, _, v = css.partition("/")
    hs = [float(x.strip("%")) / 100 for x in h.split()]
    vs = [float(x.strip("%")) / 100 for x in (v or h).split()]
    full = lambda xs: (xs * 4)[:4] if len(xs) == 1 else xs
    hs, vs = full(hs), full(vs)
    # CSS scales every radius down when two on one side add up to more than the side.
    f = min(1.0, 1 / max(hs[0] + hs[1], hs[3] + hs[2], vs[0] + vs[3], vs[1] + vs[2]))
    return [x * f for x in hs], [x * f for x in vs]


def outline(css, n=720):
    """Points on the shape's edge, box from -1..1 with z up."""
    hs, vs = radii(css)
    # Anticlockwise from the right: top-right, top-left, bottom-left, bottom-right, so straight sides join them.
    corners = [((1 - 2 * hs[1], 1 - 2 * vs[1]), (2 * hs[1], 2 * vs[1]), 0, math.pi / 2),
               ((-1 + 2 * hs[0], 1 - 2 * vs[0]), (2 * hs[0], 2 * vs[0]), math.pi / 2, math.pi),
               ((-1 + 2 * hs[3], -1 + 2 * vs[3]), (2 * hs[3], 2 * vs[3]), math.pi, 3 * math.pi / 2),
               ((1 - 2 * hs[2], -1 + 2 * vs[2]), (2 * hs[2], 2 * vs[2]), 3 * math.pi / 2, 2 * math.pi)]
    pts = []
    for (cx, cz), (rx, rz), a0, a1 in corners:
        for k in range(n // 4):
            a = a0 + (a1 - a0) * k / (n // 4)
            pts.append((cx + rx * math.cos(a), cz + rz * math.sin(a)))
    return pts


def edge_radius(pts, angle):
    """How far the outline is from the box centre in a direction (the outlines are star-shaped from it)."""
    dx, dz = math.cos(angle), math.sin(angle)
    best = None
    for i in range(len(pts)):
        (x1, z1), (x2, z2) = pts[i], pts[(i + 1) % len(pts)]
        ex, ez = x2 - x1, z2 - z1
        den = dx * ez - dz * ex
        if abs(den) < 1e-12:
            continue
        t = (x1 * ez - z1 * ex) / den
        s = (x1 * dz - z1 * dx) / den
        if t > 0 and -1e-9 <= s <= 1 + 1e-9 and (best is None or t < best):
            best = t
    return best


# ---------- materials ----------

def node_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m, m.node_tree.nodes, m.node_tree.links


def principled(name, colour, rough=0.4, spec=0.5, emit=None, strength=0.0):
    m, nodes, _ = node_mat(name)
    p = nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*colour, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = spec
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    return m


def shade_material():
    """White and matte: rendered alone, its grey is how much light each point gets (the colour multiplies it)."""
    m, nodes, links = node_mat("PebbleShade")
    nodes.remove(nodes["Principled BSDF"])
    d = nodes.new("ShaderNodeBsdfDiffuse")
    d.inputs["Color"].default_value = (1, 1, 1, 1)
    d.inputs["Roughness"].default_value = 0.6
    links.new(d.outputs[0], nodes["Material Output"].inputs[0])
    return m


def gloss_material():
    """Black with a soft gloss and a warm rim: rendered alone, only the light the surface throws back."""
    m, nodes, links = node_mat("PebbleGloss")
    p = nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0, 0, 0, 1)
    p.inputs["Roughness"].default_value = 0.3
    p.inputs["Specular IOR Level"].default_value = 0.45
    lw = nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.3
    pw = nodes.new("ShaderNodeMath")
    pw.operation = "POWER"
    pw.inputs[1].default_value = 2.2
    mu = nodes.new("ShaderNodeMath")
    mu.operation = "MULTIPLY"
    mu.inputs[1].default_value = RIM
    links.new(lw.outputs["Facing"], pw.inputs[0])
    links.new(pw.outputs[0], mu.inputs[0])
    p.inputs["Emission Color"].default_value = (1.0, 0.7, 0.4, 1)
    links.new(mu.outputs[0], p.inputs["Emission Strength"])
    return m


def shadow_material():
    """A soft black ellipse that fades out from its middle."""
    m, nodes, links = node_mat("PebbleShadow")
    nodes.remove(nodes["Principled BSDF"])
    tc = nodes.new("ShaderNodeTexCoord")
    ln = nodes.new("ShaderNodeVectorMath")
    ln.operation = "LENGTH"
    mr = nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHERSTEP"
    mr.inputs["From Min"].default_value = 0.0
    mr.inputs["From Max"].default_value = 1.0
    mr.inputs["To Min"].default_value = 0.34
    mr.inputs["To Max"].default_value = 0.0
    tr = nodes.new("ShaderNodeBsdfTransparent")
    em = nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (0, 0, 0, 1)
    mix = nodes.new("ShaderNodeMixShader")
    links.new(tc.outputs["Object"], ln.inputs[0])
    links.new(ln.outputs["Value"], mr.inputs["Value"])
    links.new(mr.outputs["Result"], mix.inputs["Fac"])
    links.new(tr.outputs[0], mix.inputs[1])
    links.new(em.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], nodes["Material Output"].inputs[0])
    return m


def materials():
    return {
        "shade": shade_material(), "gloss": gloss_material(), "shadow": shadow_material(),
        "white": principled("EyeWhite", (0.9, 0.9, 0.9), rough=0.22, spec=0.6),
        "pupil": principled("Pupil", (0.03, 0.03, 0.035), rough=0.12, spec=0.7),
        "arc": principled("EyeArc", (0.04, 0.04, 0.045), rough=0.35),
        "mouth": principled("Mouth", (0.1, 0.025, 0.03), rough=0.3),
        "star": principled("Star", (1.0, 0.5, 0.06), rough=0.3, emit=(1.0, 0.6, 0.12), strength=0.45),
        "dot": principled("ThoughtDot", (0.74, 0.77, 0.84), rough=0.3, spec=0.6),
        "drop": principled("Sweat", (0.42, 0.72, 1.0), rough=0.08, spec=0.8, emit=(0.3, 0.55, 0.9), strength=0.25),
        "zee": principled("Zee", (0.22, 0.3, 0.62), rough=0.35, emit=(0.3, 0.4, 0.75), strength=0.25),
    }


# ---------- objects ----------

def collection(name):
    c = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(c)
    return c


def link(obj, coll):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)
    return obj


def smooth_shade(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True


def sphere(name, segments=48, rings=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1)
    o = bpy.context.active_object
    o.name = name
    smooth_shade(o)
    return o


def body(mats, coll, rig):
    """One mesh; each of the five shapes is a shape key that pulls the sphere out to that outline."""
    o = sphere("Body", 96, 48)
    o.data.materials.append(mats["shade"])
    o.shape_key_add(name="Basis", from_mix=False)
    for k, css in enumerate(SHAPES):
        pts = outline(css)
        key = o.shape_key_add(name=f"s{k}", from_mix=False)
        for v, kv in zip(o.data.vertices, key.data):
            x, y, z = v.co
            f = edge_radius(pts, math.atan2(z, x)) if math.hypot(x, z) > 1e-6 else 1.0
            kv.co = Vector((x * f, y * DEPTH, z * f))
        key.value = 0.0
    o.parent = rig
    o.location = (0, 0, 1)
    return link(o, coll)


def front(x, zc):
    """Where the round body's front surface is at (x, zc), and its outward normal."""
    y = -DEPTH * math.sqrt(max(0.0, 1 - x * x - zc * zc))
    n = Vector((x, y / (DEPTH * DEPTH), zc)).normalized()
    return y, n


def pivot(name, x, zc, rig, coll, tilt=EYE_TILT):
    """An empty on the body's front, facing out, turned by the design's tilt; eye parts hang from it."""
    y, n = front(x, zc)
    e = bpy.data.objects.new(name, None)
    coll.objects.link(e)
    e.parent = rig
    e.location = (x, y, zc + 1)
    e.rotation_mode = "QUATERNION"
    e.rotation_quaternion = (-n).to_track_quat("Y", "Z") @ Quaternion((0, 1, 0), math.radians(tilt))
    return e


def ellipsoid(name, r, mat, coll, parent, loc=(0, 0, 0), half=False):
    """A squashed sphere (x, depth, z radii); half keeps only the lower half (the sleepy eye's lid line)."""
    o = sphere(name, 40, 20)
    if half:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        cut = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, 0), plane_no=(0, 0, 1), clear_outer=True)
        edges = [e for e in cut["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        bmesh.ops.edgeloop_fill(bm, edges=edges)
        bm.to_mesh(o.data)
        bm.free()
        smooth_shade(o)
    o.scale = r
    o.location = loc
    o.parent = parent
    o.data.materials.append(mat)
    return link(o, coll)


def arc(name, rx, rz, a0, a1, lift, thick, mat, coll, parent, y):
    """A thick curved stroke: ^ for happy eyes, a smile of a closed lid for sleep."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = thick
    cu.bevel_resolution = 4
    cu.use_fill_caps = True
    sp = cu.splines.new("POLY")
    n = 16
    sp.points.add(n - 1)
    for i in range(n):
        a = math.radians(a0 + (a1 - a0) * i / (n - 1))
        sp.points[i].co = (rx * math.cos(a), y, rz * math.sin(a) + lift, 1)
    o = bpy.data.objects.new(name, cu)
    coll.objects.link(o)
    o.parent = parent
    o.data.materials.append(mat)
    return o


def eye_set(style, mats, rig):
    """Both eyes of one style: white, pupil, happy arcs and shut arcs, each on a pivot that blinks and widens."""
    lefts, top, w, h = EYES[style]
    coll = collection(f"eyes_{style}")
    parts = []
    for side, left in zip("lr", lefts):
        rx, rz = w / 100, h / 100
        x = -1 + 2 * (left + w / 2) / 100
        zc = 1 - 2 * (top + h / 2) / 100
        if style == "sleepy":
            rz, zc = 2 * h / 100, 1 - 2 * top / 100      # the lid line: flat top, round bottom
        piv = pivot(f"piv_{style}_{side}", x, zc, rig, coll)
        rd = 0.5 * min(rx, max(rz, 0.12))
        sink = 0.35 * rd
        white = ellipsoid(f"white_{style}_{side}", (rx, rd, rz), mats["white"], coll, piv, (0, sink, 0), style == "sleepy")
        pupil = None
        if style != "sleepy":
            pr = (0.44 * rx, 0.3 * 0.44 * rx, 0.44 * rz)
            pupil = ellipsoid(f"pupil_{style}_{side}", pr, mats["pupil"], coll, piv, (0, -rd + sink - 0.004, 0.12 * rz))
        aw = max(rx, 0.15)
        happy = arc(f"happy_{style}_{side}", aw * 0.9, 0.16, 25, 155, -0.07, 0.03, mats["arc"], coll, piv, -rd * 0.6)
        shut = arc(f"shut_{style}_{side}", aw * 0.9, 0.1, 200, 340, 0.02, 0.028, mats["arc"], coll, piv, -rd * 0.6)
        parts.append({"piv": piv, "white": white, "pupil": pupil, "happy": happy, "shut": shut, "rx": rx, "rz": rz,
                      "rd": rd, "sink": sink})
    return coll, parts


def mouth(mats, rig):
    coll = collection("mouth")
    piv = pivot("piv_mouth", 0.03, -0.33, rig, coll, tilt=0)
    o = ellipsoid("Mouth", (0.12, 0.04, 0.08), mats["mouth"], coll, piv, (0, 0.01, 0.02), half=True)
    return coll, o


def star_mesh(name):
    """A four-pointed sparkle, thin and bevelled."""
    me = bpy.data.meshes.new(name)
    verts = [(0, 0, 0)]
    for i in range(8):
        a = math.radians(90 + i * 45)
        r = 1.0 if i % 2 == 0 else 0.3
        verts.append((r * math.cos(a), 0, r * math.sin(a)))
    faces = [(0, 1 + i, 1 + (i + 1) % 8) for i in range(8)]
    me.from_pydata(verts, [], faces)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    s = o.modifiers.new("thick", "SOLIDIFY")
    s.thickness = 0.18
    s.offset = 0
    b = o.modifiers.new("soft", "BEVEL")
    b.width = 0.05
    b.segments = 2
    return o


def drop_mesh(name):
    """A sweat drop: a sphere drawn up to a point."""
    o = sphere(name, 32, 16)
    for v in o.data.vertices:
        x, y, z = v.co
        if z > 0:
            k = z
            v.co = (x * (1 - 0.75 * k), y * (1 - 0.75 * k), z * (1 + 0.9 * k))
    return o


def zee(name):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = "z"
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = 0.08
    cu.bevel_depth = 0.02
    o = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(o)
    return o


def effects(mats):
    coll = collection("fx")
    out = {}
    for k in range(3):
        out[f"dot{k}"] = sphere(f"dot{k}", 24, 12)
        out[f"dot{k}"].data.materials.append(mats["dot"])
    for k in range(7):
        out[f"star{k}"] = star_mesh(f"star{k}")
        out[f"star{k}"].data.materials.append(mats["star"])
    out["drop"] = drop_mesh("drop")
    out["drop"].data.materials.append(mats["drop"])
    for k in range(2):
        out[f"z{k}"] = zee(f"z{k}")
        out[f"z{k}"].data.materials.append(mats["zee"])
    for o in out.values():
        link(o, coll)
    return coll, out


def shadow(mats):
    coll = collection("shadow")
    bpy.ops.mesh.primitive_plane_add(size=2)
    o = bpy.context.active_object
    o.name = "Shadow"
    o.rotation_euler = (math.radians(90), 0, 0)
    o.data.materials.append(mats["shadow"])
    return coll, link(o, coll)


# ---------- light, camera, world ----------

def area(name, loc, target, size, energy):
    li = bpy.data.lights.new(name, "AREA")
    li.shape = "DISK"
    li.size = size
    li.energy = energy
    o = bpy.data.objects.new(name, li)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y")
    return o


def stage():
    sc = bpy.context.scene
    area("Key", (-3.4, -4.6, 5.4), (0, 0, 1), 3.6, KEY)
    area("Fill", (4.6, -3.6, 1.0), (0, 0, 1), 4.0, FILL)
    area("Rim", (2.6, 3.8, 4.2), (0, 0, 1.3), 2.2, RIMLIGHT)
    cam = bpy.data.cameras.new("Cam")
    cam.type = "ORTHO"
    cam.ortho_scale = ORTHO
    cam.clip_end = 40
    o = bpy.data.objects.new("Cam", cam)
    sc.collection.objects.link(o)
    o.location = (0, -14, -BOTTOM * ORTHO + ORTHO / 2)
    o.rotation_euler = (math.radians(90), 0, 0)
    sc.camera = o
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    sc.world = world
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (1, 1, 1, 1)
    bg.inputs["Strength"].default_value = AMBIENT


def settings(samples):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
        except TypeError:
            continue
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == kind
            sc.cycles.device = "GPU"
            break
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.cycles.use_adaptive_sampling = True
    sc.render.film_transparent = True
    sc.render.filter_size = 1.2
    sc.render.resolution_x = sc.render.resolution_y = SIZE
    sc.render.use_persistent_data = True
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 0.5
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0
    sc.view_settings.gamma = 1


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = materials()
    rig = bpy.data.objects.new("Rig", None)
    bpy.context.scene.collection.objects.link(rig)
    body_coll = collection("body")
    parts = {"rig": rig, "mats": mats, "body": body(mats, body_coll, rig), "colls": {"body": body_coll}, "eyes": {}}
    for style in EYES:
        coll, eyes = eye_set(style, mats, rig)
        parts["colls"][f"eyes_{style}"] = coll
        parts["eyes"][style] = eyes
    parts["colls"]["mouth"], parts["mouth"] = mouth(mats, rig)
    parts["colls"]["fx"], parts["fx"] = effects(mats)
    parts["colls"]["shadow"], parts["shadow"] = shadow(mats)
    stage()
    return parts


# ---------- posing ----------

def key(obj, path):
    obj.keyframe_insert(data_path=path)


def pose_rig(parts, p):
    rig = parts["rig"]
    rig.location = (p["x"], 0, p["hop"])
    rig.rotation_euler = (math.radians(p["pitch"]), math.radians(p["roll"]), math.radians(p["yaw"]))
    side = 1 / math.sqrt(p["sq"])
    rig.scale = (side, side, p["sq"])
    for path in ("location", "rotation_euler", "scale"):
        key(rig, path)


def pose_eyes(parts, p):
    lx, lz = p["look"]
    for eyes in parts["eyes"].values():
        for e in eyes:
            e["piv"].scale = (p["widen"], 1, p["widen"] * (1 - 0.9 * p["blink"]))
            key(e["piv"], "scale")
            show = {"white": p["eyes"] == "open", "pupil": p["eyes"] == "open", "happy": p["eyes"] == "happy",
                    "shut": p["eyes"] == "shut"}
            for part, on in show.items():
                if e[part] is not None:
                    e[part].hide_render = not on
                    key(e[part], "hide_render")
            if e["pupil"] is not None:
                px, pz = 0.42 * e["rx"] * lx, 0.12 * e["rz"] + 0.34 * e["rz"] * lz
                inside = max(0.0, 1 - (px / e["rx"]) ** 2 - (pz / e["rz"]) ** 2)
                e["pupil"].location = (px, -e["rd"] * math.sqrt(inside) + e["sink"] - 0.004, pz)
                key(e["pupil"], "location")


def pose_mouth(parts, p):
    m = parts["mouth"]
    m.hide_render = p["mouth"] is None
    open_ = p["mouth"] or 0.0
    m.scale = (0.11 * (1 + 0.2 * open_), 0.04, 0.085 * (0.25 + 1.1 * open_))
    key(m, "hide_render")
    key(m, "scale")


def pose_fx(parts, p):
    for name, o in parts["fx"].items():
        got = p["fx"].get(name)
        o.hide_render = got is None or got[2] <= 0.002
        key(o, "hide_render")
        if got is None:
            continue
        x, z, s, spin = got
        o.location = (x, -1.4, z)
        o.scale = (s, s, s)
        base = math.radians(90) if name.startswith("z") else 0.0
        o.rotation_euler = (base, math.radians(spin), 0)
        for path in ("location", "scale", "rotation_euler"):
            key(o, path)
    sh = parts["shadow"]
    lift = min(1.0, p["hop"] / 0.3)
    sh.location = (p["x"], 0.0, 0.02)
    sh.scale = (0.92 * (1 - 0.45 * lift) / math.sqrt(p["sq"]), 0.13 * (1 - 0.45 * lift), 1)
    key(sh, "location")
    key(sh, "scale")


def animate(parts, state):
    """Keys every frame of a state (one extra either side, so motion blur is right at the seam)."""
    sc = bpy.context.scene
    for o in bpy.data.objects:
        o.animation_data_clear()
    n, fps, _ = M.frames(state)
    sc.render.fps = fps
    sc.frame_start, sc.frame_end = 0, n - 1
    prev = M.pose(state, 0)["yaw"]
    for i in range(-1, n + 1):
        sc.frame_set(i)
        p = M.pose(state, i)
        # A full turn ends where it began: keep the angle running on, so blur never spins back through the seam.
        while p["yaw"] - prev > 180:
            p["yaw"] -= 360
        while p["yaw"] - prev < -180:
            p["yaw"] += 360
        prev = p["yaw"]
        pose_rig(parts, p)
        pose_eyes(parts, p)
        pose_mouth(parts, p)
        pose_fx(parts, p)
    for o in bpy.data.objects:
        if o.animation_data and o.animation_data.action:
            for fc in fcurves(o.animation_data):
                for kp in fc.keyframe_points:
                    kp.interpolation = "CONSTANT" if fc.data_path == "hide_render" else "LINEAR"


def fcurves(anim):
    """An action's curves (Blender 5 keeps them in layered channelbags)."""
    act = anim.action
    if hasattr(act, "fcurves") and act.fcurves:
        return list(act.fcurves)
    out = []
    for layer in getattr(act, "layers", []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                out.extend(bag.fcurves)
    return out


# ---------- passes ----------

def only(parts, visible):
    for name, coll in parts["colls"].items():
        coll.hide_render = name not in visible


def set_shape(parts, k):
    for block in parts["body"].data.shape_keys.key_blocks[1:]:
        block.value = 1.0 if block.name == f"s{k}" else 0.0


def render_pass(out, state, name):
    sc = bpy.context.scene
    sc.render.filepath = os.path.join(out, state, name, "####")
    bpy.ops.render.render(animation=True)


def render_state(parts, state, opt):
    sc = bpy.context.scene
    world_bg = sc.world.node_tree.nodes["Background"].inputs["Strength"]
    b = parts["body"]
    if "body" in opt["passes"] or "light" in opt["passes"]:
        only(parts, {"body"})
        b.is_holdout = False
        for k in opt["shapes"]:
            set_shape(parts, k)
            if "body" in opt["passes"]:
                b.data.materials[0] = parts["mats"]["shade"]
                world_bg.default_value = AMBIENT
                sc.render.resolution_percentage = 100
                render_pass(opt["out"], state, f"body-{k}")
            if "light" in opt["passes"]:
                b.data.materials[0] = parts["mats"]["gloss"]
                world_bg.default_value = 0.0
                sc.render.resolution_percentage = 50
                render_pass(opt["out"], state, f"light-{k}")
    if "fx" in opt["passes"]:
        b.data.materials[0] = parts["mats"]["shade"]
        world_bg.default_value = AMBIENT
        sc.render.resolution_percentage = 100
        set_shape(parts, 0)
        b.is_holdout = True
        for style in opt["eyes"]:
            only(parts, {"body", f"eyes_{style}", "mouth", "fx", "shadow"})
            render_pass(opt["out"], state, f"fx-{style}")
        b.is_holdout = False


def main():
    opt = args()
    parts = build()
    settings(opt["samples"])
    animate(parts, opt["states"][0])
    if opt["save_blend"]:
        set_shape(parts, 0)
        only(parts, {"body", "eyes_round", "mouth", "fx", "shadow"})
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(opt["save_blend"]), compress=True)
    if not opt["render"] or not opt["out"]:
        return
    for state in opt["states"]:
        animate(parts, state)
        bpy.context.scene.frame_step = opt["every"]   # a quick look renders every Nth frame only
        render_state(parts, state, opt)
        print("PEBBLE rendered", state, flush=True)


main()
