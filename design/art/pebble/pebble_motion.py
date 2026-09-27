"""How the classic pebble moves in each state: pure functions of time, shared by the Blender generator.

Every state is a seamless loop (or a one-shot that starts and ends at rest). A pose is a plain dict:
  hop      lift off the ground, in body units (the body is 2 units tall)
  sq       squash (<1) or stretch (>1) along the vertical; the other axes keep the volume
  roll     tilt in the picture plane, degrees (positive leans right)
  yaw      turn about the vertical axis, degrees (positive turns to its left, our right)
  pitch    lean toward the viewer, degrees
  x        sideways shift, body units
  look     (x, z) where the pupils point, -1..1
  blink    0 open .. 1 shut
  widen    eye size factor
  eyes     "open", "happy" (^ ^) or "shut" (sleeping arcs)
  mouth    None (no mouth) or 0..1 how open
  fx       {object name: (x, z, scale, spin degrees)}; anything not named is hidden
"""
import math

TAU = math.pi * 2

# name: (seconds, frames per second, loops?)
STATES = {
    "idle": (4.0, 12, True), "think": (2.0, 24, True), "search": (2.5, 24, True), "read": (3.0, 24, True),
    "work": (1.0, 24, True), "wait": (2.0, 24, True), "talk": (1.5, 24, True), "yay": (2.0, 24, True),
    "oops": (2.0, 24, True), "sleep": (3.0, 12, True),
    "hover": (0.625, 24, False), "pat": (0.833, 24, False), "wake": (1.0, 24, False),
}


def rest():
    return {"hop": 0.0, "sq": 1.0, "roll": 0.0, "yaw": 0.0, "pitch": 0.0, "x": 0.0, "look": (0.0, 0.0),
            "blink": 0.0, "widen": 1.0, "eyes": "open", "mouth": None, "fx": {}}


def smooth(a, b, v):
    """0 before a, 1 after b, eased between."""
    if b == a:
        return 1.0 if v >= b else 0.0
    t = min(1.0, max(0.0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)


def bump(v, centre, width):
    """A soft pulse of height 1 at centre."""
    return math.exp(-((v - centre) / width) ** 2)


def wrap_bump(u, centre, width):
    """bump() on a loop, so a pulse near the seam wraps around."""
    d = (u - centre + 0.5) % 1.0 - 0.5
    return math.exp(-(d / width) ** 2)


def blink_at(u, centre, length):
    """Eyes shut at centre of a loop; length is the share of the loop a blink takes."""
    return wrap_bump(u, centre, length * 0.5)


def spring(t, freq=3.0, decay=5.0):
    """A damped wobble that starts at 1 and settles to 0 (t in seconds after the hit)."""
    if t < 0:
        return 0.0
    return math.exp(-decay * t) * math.cos(TAU * freq * t)


def square(u, sharp=4.0):
    """A smoothed square wave from -1 to 1 (for looking one way, then the other)."""
    return math.tanh(sharp * math.sin(TAU * u)) / math.tanh(sharp)


def jump(t, t0, t1, height):
    """A ballistic arc between take-off t0 and landing t1."""
    if t <= t0 or t >= t1:
        return 0.0
    k = (t - t0) / (t1 - t0)
    return 4 * height * k * (1 - k)


def idle(t, L):
    u = t / L
    p = rest()
    p["sq"] = 1 + 0.018 * math.sin(TAU * u * 2)
    p["roll"] = 1.6 * math.sin(TAU * u)
    glance = smooth(0.52, 0.6, u) - smooth(0.78, 0.86, u)
    p["look"] = (-0.05 + 0.55 * glance, 0.12 * glance)
    p["blink"] = blink_at(u, 0.32, 0.05)
    return p


def think(t, L):
    u = t / L
    p = rest()
    p["roll"] = 4.0 * math.sin(TAU * u)
    p["yaw"] = -6.0 + 4.0 * math.sin(TAU * u + 1.2)
    p["sq"] = 1 + 0.02 * math.sin(TAU * u * 2)
    p["look"] = (0.45 + 0.12 * math.sin(TAU * u), 0.72 + 0.08 * math.cos(TAU * u))
    p["blink"] = blink_at(u, 0.8, 0.06)
    for k, size in enumerate((0.09, 0.125, 0.165)):
        v = (u + k / 3.0) % 1.0
        s = size * smooth(0.0, 0.18, v) * (1 - smooth(0.72, 1.0, v))
        p["fx"][f"dot{k}"] = (0.78 + 0.28 * v, 1.95 + 0.5 * v, s, 0.0)
    return p


def search(t, L):
    u = t / L
    p = rest()
    side = square(u, 3.5)
    ahead = square(u + 0.04, 5.0)
    p["yaw"] = 22.0 * side
    p["look"] = (0.8 * ahead, 0.05)
    turn = max(wrap_bump(u, 0.0, 0.05), wrap_bump(u, 0.5, 0.05))
    p["hop"] = 0.06 * turn
    p["sq"] = 1 + 0.05 * turn - 0.04 * max(wrap_bump(u, 0.07, 0.03), wrap_bump(u, 0.57, 0.03))
    p["roll"] = -4.0 * side
    p["blink"] = blink_at(u, 0.26, 0.04)
    return p


def read(t, L):
    u = t / L
    p = rest()
    line = int(u * 3) % 3
    v = (u * 3) % 1.0
    sweep = smooth(0.0, 0.8, v)
    steps = math.floor(sweep * 4) / 4 * 0.8 + sweep * 0.2   # little saccades along the line
    back = smooth(0.84, 0.98, v)
    lx = -0.7 + 1.4 * steps * (1 - back) + (-0.7 + 0.7) * back
    p["look"] = (lx, (0.05, -0.2, -0.45)[line])
    p["pitch"] = 7.0 + 2.0 * bump(v, 0.92, 0.05)
    p["roll"] = 1.5 * math.sin(TAU * u)
    p["sq"] = 1 + 0.012 * math.sin(TAU * u * 3)
    p["blink"] = 0.25
    return p


def work(t, L):
    u = t / L
    p = rest()
    beat = (u * 2) % 1.0
    p["hop"] = 0.07 * math.sin(math.pi * beat) ** 1.5
    contact = max(bump(beat, 0.0, 0.07), bump(beat, 1.0, 0.07))
    p["sq"] = 1 - 0.08 * contact + 0.04 * math.sin(math.pi * beat) ** 2
    p["roll"] = 2.5 * math.sin(TAU * u)
    p["look"] = (0.1 * math.sin(TAU * u), -0.35)
    p["blink"] = 0.32
    return p


def wait(t, L):
    u = t / L
    p = rest()
    s = t
    crouch = bump(s, 0.12, 0.06)
    land = bump(s, 0.62, 0.05)
    p["hop"] = jump(s, 0.2, 0.58, 0.26)
    stretch = smooth(0.16, 0.24, s) * (1 - smooth(0.3, 0.5, s)) + 0.5 * smooth(0.44, 0.56, s) * (1 - smooth(0.56, 0.6, s))
    settle = 0.05 * spring(s - 0.66, 2.6, 5.5) * smooth(0.62, 0.68, s)
    p["sq"] = 1 - 0.12 * crouch + 0.1 * stretch - 0.12 * land + settle
    tilt = smooth(0.7, 0.95, s) * (1 - smooth(1.75, 1.98, s))
    p["roll"] = 8.0 * tilt
    p["widen"] = 1 + 0.12 * smooth(0.5, 0.75, s) * (1 - smooth(1.7, 1.98, s))
    p["look"] = (0.0, 0.1 * tilt)
    p["blink"] = blink_at(u, 0.93, 0.03)
    return p


# Syllables for talking, each 1/6 s: how wide the mouth opens.
SYLLABLES = (1.0, 0.55, 0.9, 0.0, 0.8, 0.45, 1.0, 0.7, 0.0)


def talk(t, L):
    u = t / L
    p = rest()
    n = len(SYLLABLES)
    k = int(u * n) % n
    v = (u * n) % 1.0
    m = SYLLABLES[k] * math.sin(math.pi * v) ** 2
    p["mouth"] = m
    p["sq"] = 1 + 0.035 * m
    p["widen"] = 1 + 0.04 * m
    p["roll"] = 2.0 * math.sin(TAU * u)
    p["yaw"] = 3.0 * math.sin(TAU * u * 2 + 0.5)
    p["look"] = (0.0, 0.05)
    p["blink"] = blink_at(u, 0.4, 0.05)
    return p


def burst(p, t, t0, t1, count=7):
    """Stars that fly out from the top of the head and fade."""
    k = smooth(t0, t1, t)
    if k <= 0 or k >= 1:
        return
    out = 1 - (1 - k) ** 3
    grow = smooth(0.0, 0.2, k) * (1 - smooth(0.55, 1.0, k))
    for i in range(count):
        a = math.radians(90 + (i - (count - 1) / 2) * (200 / (count - 1)))
        r = 0.85 + 0.6 * out
        size = (0.16 if i % 2 == 0 else 0.11) * grow
        p["fx"][f"star{i}"] = (r * math.cos(a), 1.35 + r * math.sin(a), size, 90 * k + i * 20)


def yay(t, L):
    p = rest()
    crouch = bump(t, 0.2, 0.08)
    p["hop"] = jump(t, 0.32, 1.02, 0.3)
    up = smooth(0.26, 0.34, t) * (1 - smooth(0.4, 0.62, t))
    down = smooth(0.85, 0.98, t) * (1 - smooth(0.98, 1.02, t))
    land = bump(t, 1.06, 0.05)
    settle = 0.06 * spring(t - 1.1, 2.4, 5.0) * smooth(1.04, 1.1, t)
    p["sq"] = 1 - 0.16 * crouch + 0.14 * up + 0.08 * down - 0.16 * land + settle
    p["yaw"] = 360.0 * smooth(0.4, 0.95, t)
    p["roll"] = 3.0 * math.sin(TAU * t / L)
    happy = 0.25 <= t <= 1.7
    p["eyes"] = "happy" if happy else "open"
    p["mouth"] = 0.75 if 0.3 <= t <= 1.6 else None
    burst(p, t, 0.55, 1.45)
    return p


def oops(t, L):
    u = t / L
    p = rest()
    flinch = bump(t, 0.12, 0.07)
    p["sq"] = 0.97 - 0.1 * flinch
    p["roll"] = 9.0 * spring(t - 0.12, 2.2, 2.6) * smooth(0.08, 0.14, t) * (1 - smooth(1.7, 1.98, t))
    p["x"] = 0.04 * spring(t - 0.12, 4.0, 4.0) * smooth(0.08, 0.14, t)
    p["blink"] = max(smooth(0.04, 0.1, t) * (1 - smooth(0.26, 0.36, t)), blink_at(u, 0.85, 0.04))
    p["look"] = (-0.45, -0.5)
    p["widen"] = 0.95
    drop = smooth(0.25, 1.55, t)
    if 0.25 < t < 1.75:
        s = 0.17 * smooth(0.25, 0.4, t) * (1 - smooth(1.5, 1.75, t))
        a = math.radians(38 - 32 * drop)       # slides down the side of the head
        p["fx"]["drop"] = (0.98 * math.cos(a) + 0.08, 1.0 + 0.98 * math.sin(a), s, 0.0)
    return p


def zees(p, u):
    for k in range(2):
        v = (u + k * 0.5) % 1.0
        s = 0.46 * smooth(0.0, 0.2, v) * (1 - smooth(0.7, 1.0, v)) * (0.8 + 0.2 * k)
        p["fx"][f"z{k}"] = (0.72 + 0.42 * v + 0.05 * math.sin(TAU * v * 1.5), 1.9 + 0.62 * v, s, -12 + 18 * v)


def sleep(t, L):
    u = t / L
    p = rest()
    p["eyes"] = "shut"
    p["sq"] = 1 + 0.035 * math.sin(TAU * u)
    p["roll"] = -5.0 + 1.2 * math.sin(TAU * u)
    p["pitch"] = 5.0
    zees(p, u)
    return p


def hover(t, L):
    p = rest()
    perk = smooth(0.0, 0.12, t) * (1 - smooth(0.3, 0.6, t))
    p["sq"] = 1 + 0.07 * perk + 0.02 * spring(t - 0.3, 3.5, 7.0) * smooth(0.25, 0.32, t)
    p["hop"] = 0.03 * perk
    p["widen"] = 1 + 0.14 * perk
    p["look"] = (0.0, 0.08 * perk)
    return p


def pat(t, L):
    p = rest()
    press = smooth(0.0, 0.12, t) * (1 - smooth(0.2, 0.34, t))
    rebound = 0.08 * spring(t - 0.3, 2.8, 5.5) * smooth(0.24, 0.32, t)
    p["sq"] = 1 - 0.17 * press + rebound
    p["eyes"] = "happy" if 0.06 <= t <= 0.66 else "open"
    p["roll"] = 3.0 * math.sin(TAU * t / L)
    if 0.2 < t < 0.8:
        k = smooth(0.2, 0.8, t)
        p["fx"]["star0"] = (0.15, 2.2 + 0.2 * k, 0.13 * math.sin(math.pi * k), 120 * k)
    return p


def wake(t, L):
    p = rest()
    opened = smooth(0.16, 0.22, t)
    p["eyes"] = "shut" if t < 0.18 else "open"
    p["widen"] = 1 + 0.22 * opened * (1 - smooth(0.4, 0.8, t))
    p["roll"] = -5.0 * (1 - smooth(0.12, 0.35, t))
    p["pitch"] = 5.0 * (1 - smooth(0.12, 0.35, t))
    p["hop"] = jump(t, 0.2, 0.48, 0.14)
    p["sq"] = 1 + 0.1 * bump(t, 0.24, 0.05) - 0.1 * bump(t, 0.5, 0.04) + 0.04 * spring(t - 0.55, 3.0, 6.0) * smooth(0.5, 0.56, t)
    p["yaw"] = 9.0 * math.sin(TAU * 3 * smooth(0.55, 0.95, t)) * (1 - smooth(0.85, 1.0, t))
    return p


POSES = {"idle": idle, "think": think, "search": search, "read": read, "work": work, "wait": wait, "talk": talk,
         "yay": yay, "oops": oops, "sleep": sleep, "hover": hover, "pat": pat, "wake": wake}


def frames(state):
    """(frame count, fps, loops?) for a state."""
    seconds, fps, loops = STATES[state]
    return round(seconds * fps), fps, loops


def pose(state, i):
    """The pose at frame i of a state (i may run past the ends; loops wrap, one-shots hold)."""
    n, fps, loops = frames(state)
    seconds = STATES[state][0]
    if loops:
        t = (i % n) / fps
    else:
        t = min(max(i, 0), n - 1) / fps
    return POSES[state](t, seconds)
