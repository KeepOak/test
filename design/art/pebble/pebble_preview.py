"""A quick look at rendered passes while tuning the Blender scene: composites them the way the window does (body grey
times the colour, then the light pass, then eyes and effects) onto a light and a dark background, as one PNG.

  python design/art/pebble/pebble_preview.py <render folder> <state> <out.png> [shapes] [eyes] [colours]

The window's own composite (public/app/core/pebble.js) is what ships; this only saves a round trip through a browser.
"""
import os
import sys

import numpy as np
from PIL import Image

COLOURS = ["#2F8C86", "#D8612A", "#8A5AA8", "#5E8C4A", "#4F6FA8", "#C9982E", "#B84A6B", "#56616B"]


def load(path, size=None):
    im = Image.open(path).convert("RGBA")
    if size and im.size != (size, size):
        im = im.resize((size, size), Image.BILINEAR)
    return np.asarray(im).astype(np.float32) / 255.0


def over(dst, src):
    a = src[..., 3:4]
    out = dst.copy()
    out[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
    out[..., 3:4] = a + dst[..., 3:4] * (1 - a)
    return out


def light_layer(light):
    """The light pass (glow on black) as a white-ish layer whose alpha is its brightness."""
    rgb = light[..., :3] * light[..., 3:4]
    a = np.clip(rgb.max(axis=2, keepdims=True), 0, 1)
    col = np.where(a > 1e-4, rgb / np.maximum(a, 1e-4), 1.0)
    return np.concatenate([col, a], axis=2)


def frame(folder, state, shape, eyes, colour, i, bg):
    body = load(os.path.join(folder, state, f"body-{shape}", f"{i:04d}.png"))
    size = body.shape[0]
    light = load(os.path.join(folder, state, f"light-{shape}", f"{i:04d}.png"), size)
    fx = load(os.path.join(folder, state, f"fx-{eyes}", f"{i:04d}.png"))
    c = np.array([int(colour[k:k + 2], 16) / 255 for k in (1, 3, 5)], dtype=np.float32)
    tinted = np.concatenate([body[..., :3] * c, body[..., 3:4]], axis=2)
    out = np.zeros_like(body)
    out[..., :3] = bg
    out[..., 3] = 1
    out = over(out, tinted)
    lay = light_layer(light)
    lay[..., 3:4] *= body[..., 3:4]
    out = over(out, lay)
    return over(out, fx)


def main():
    folder, state, dest = sys.argv[1:4]
    shapes = [int(s) for s in (sys.argv[4] if len(sys.argv) > 4 else "0").split(",")]
    eyes = (sys.argv[5] if len(sys.argv) > 5 else "round").split(",")
    colours = (sys.argv[6] if len(sys.argv) > 6 else ",".join(COLOURS[:4])).split(",")
    idx = sorted(int(f[:4]) for f in os.listdir(os.path.join(folder, state, f"body-{shapes[0]}")))
    rows = []
    for bg in ((0.98, 0.97, 0.95), (0.11, 0.11, 0.12)):
        for s in shapes:
            for e in eyes:
                for c in colours:
                    rows.append(np.concatenate([frame(folder, state, s, e, c, i, bg) for i in idx], axis=1))
    sheet = np.concatenate(rows, axis=0)
    Image.fromarray((np.clip(sheet, 0, 1) * 255).astype(np.uint8)).save(dest)
    print(dest, sheet.shape)


if __name__ == "__main__":
    main()
