"""Packs the rendered passes (pebble_blender.py) into the sprite sheets the window draws from:

  python design/art/pebble/pebble_pack.py <render folder> public/art/pebble

For every state, one sheet per pass, frames left to right then down:
  <state>-body-<shape>.webp   white body, grey = shading (the window multiplies it by the Trunk's colour)
  <state>-light-<shape>.webp  gloss and warm rim as light with alpha (drawn on top), half size
  <state>-fx-<eyes>.webp      eyes, mouth, effects and contact shadow (drawn on top of that)
plus a still per pass (the first idle frame) for small faces, reduced motion and the moment before a sheet loads, and
pebble.json saying how every sheet is laid out.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pebble_motion as M  # noqa: E402

SHAPES = 5
EYES = ("round", "wide", "sleepy")
MAX_COLS = 12
QUALITY = {"body": 82, "light": 80, "fx": 86}


def frames(folder):
    names = sorted(f for f in os.listdir(folder) if f.endswith(".png"))
    return [Image.open(os.path.join(folder, n)).convert("RGBA") for n in names]


def as_light(im):
    """Glow rendered on black, as a colour whose alpha is its brightness (so drawing it adds the glow)."""
    a = np.asarray(im).astype(np.float32) / 255
    rgb = a[..., :3] * a[..., 3:4]
    alpha = np.clip(rgb.max(axis=2, keepdims=True), 0, 1)
    col = np.where(alpha > 1e-3, rgb / np.maximum(alpha, 1e-3), 1.0)
    out = np.concatenate([np.clip(col, 0, 1), alpha], axis=2)
    return Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA")


def sheet(ims, cols):
    w, h = ims[0].size
    rows = math.ceil(len(ims) / cols)
    out = Image.new("RGBA", (w * cols, h * rows), (0, 0, 0, 0))
    for i, im in enumerate(ims):
        out.paste(im, ((i % cols) * w, (i // cols) * h))
    return out


def save(im, path, kind):
    # exact keeps the colour under see-through pixels, so a multiply never picks up a dark fringe.
    im.save(path, "WEBP", quality=QUALITY[kind], alpha_quality=90, method=6, exact=True)
    return os.path.getsize(path)


def pack_state(src, dest, state, total):
    n, fps, loops = M.frames(state)
    cols = min(n, MAX_COLS)
    jobs = [(f"body-{k}", "body") for k in range(SHAPES)] + [(f"light-{k}", "light") for k in range(SHAPES)]
    jobs += [(f"fx-{e}", "fx") for e in EYES]
    for name, kind in jobs:
        ims = frames(os.path.join(src, state, name))
        if len(ims) != n:
            raise SystemExit(f"{state}/{name}: {len(ims)} frames, expected {n}")
        if kind == "light":
            ims = [as_light(im) for im in ims]
        total[0] += save(sheet(ims, cols), os.path.join(dest, f"{state}-{name}.webp"), kind)
        if state == "idle":
            total[0] += save(ims[0], os.path.join(dest, f"still-{name}.webp"), kind)
    return {"frames": n, "fps": fps, "loop": loops, "cols": cols}


def main():
    src, dest = sys.argv[1], sys.argv[2]
    os.makedirs(dest, exist_ok=True)
    total = [0]
    states = {s: pack_state(src, dest, s, total) for s in M.STATES}
    size = Image.open(os.path.join(src, "idle", "body-0", "0000.png")).size[0]
    meta = {"size": size, "lightSize": size // 2, "share": 0.70, "bottom": 0.08, "shapes": SHAPES,
            "eyes": list(EYES), "states": states}
    with open(os.path.join(dest, "pebble.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    print(f"packed {len(states)} states, {total[0] / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
