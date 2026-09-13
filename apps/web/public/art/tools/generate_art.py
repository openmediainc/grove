#!/usr/bin/env python3
"""
Grove original art generator
============================

Draws every building, prop, tile and animal under apps/web/public/art/ from
scratch with Pillow. Nothing here is downloaded, traced or adapted -- every
shape is a polygon computed from the isometric projection below.

Run:  python3 apps/web/public/art/tools/generate_art.py
It writes into ../buildings, ../civic, ../scaffold, ../tiles, ../props,
../animals, ../items and rewrites ../manifest.json.

GEOMETRY
--------
The world is a 64x32 diamond grid (TW=64, TH=32). `iso(tx,ty)` in the renderer
returns the diamond's NORTH VERTEX. Ground tiles are drawn at (x - 32, y).

This script works in tile space: x runs tile-east (tx+1, screen down-right),
y runs tile-south (ty+1, screen down-left), z runs up in pixels.

    proj(x, y, z) -> ((x - y) * 32, (x + y) * 16 - z)

ANCHOR CONVENTION
-----------------
Every sprite declares an anchor pixel. The renderer puts that pixel exactly on
`iso(tx, ty)` of the sprite's NORTH-MOST footprint tile:

    ctx.drawImage(img, ox + p.x - anchor[0], oy + p.y - anchor[1], w, h)

For a footprint of fw x fh tiles with structure height Hz and padding PAD:
    width  = (fw + fh) * 32 + 2*PAD
    height = (fw + fh) * 16 + Hz + 2*PAD
    anchor = (fh * 32 + PAD, Hz + PAD)

Ground tiles are the degenerate case: fw=fh=1, Hz=0, PAD=0 -> 64x32, anchor
(32, 0), i.e. identical to the existing tiles/*.png draw call.
"""

import json
import math
import os
import random
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.abspath(os.path.join(HERE, ".."))

TW, TH = 64, 32
HW, HH = TW // 2, TH // 2

# --------------------------------------------------------------------------
# Palette. Sampled from the existing tiles/ and chars/ so new art sits in the
# same dusk. Access accents match PRESET_TINT in WorldMap.tsx exactly, so a
# building and the ground tint under it say the same thing in the same hue.
# --------------------------------------------------------------------------
PAL = {
    "void":        (7, 8, 20),
    "ink":         (10, 10, 24),         # outline
    "ink_soft":    (18, 19, 38),
    "ground":      (11, 13, 24),         # #0b0d18 from the brief
    "night":       (3, 2, 42),           # #03022a sampled from plaza.png

    "stone_dk":    (36, 34, 58),
    "stone":       (62, 58, 92),
    "stone_lt":    (94, 86, 128),
    "stone_hi":    (126, 94, 117),       # #7e5e75 sampled from plaza.png

    "wood_dk":     (44, 29, 24),
    "wood":        (98, 62, 50),         # #623e32 sampled from stage.png
    "wood_lt":     (138, 90, 69),
    "wood_hi":     (176, 122, 88),

    "leaf_dk":     (15, 46, 43),
    "leaf":        (24, 69, 66),         # #184542 sampled from garden.png
    "leaf_lt":     (42, 107, 96),
    "leaf_hi":     (77, 156, 122),

    "amber_dk":    (138, 90, 34),
    "amber":       (232, 184, 109),      # #e8b86d
    "amber_lt":    (244, 209, 154),      # #f4d19a
    "amber_glow":  (255, 238, 196),

    "violet_dk":   (60, 46, 112),
    "violet":      (124, 92, 214),
    "violet_lt":   (167, 139, 250),      # #a78bfa

    # Access accents -- same hues the map already tints the ground with.
    "private":     (244, 114, 182),
    "private_dk":  (150, 58, 106),
    "view":        (56, 189, 248),
    "view_dk":     (26, 104, 145),
    "write":       (251, 191, 36),
    "write_dk":    (152, 110, 18),

    "cloth":       (74, 66, 104),
    "cloth_lt":    (108, 98, 148),
    "rope":        (150, 128, 96),
    "wool":        (222, 220, 228),
    "wool_dk":     (156, 154, 172),
    "wool_sh":     (110, 110, 132),
    "paper":       (226, 222, 206),
    "paper_dk":    (168, 164, 150),
    "metal_dk":    (52, 56, 74),
    "metal":       (108, 116, 140),
    "metal_lt":    (162, 170, 192),
    "water":       (32, 62, 96),
    "water_lt":    (70, 120, 160),

    # Road: deliberately a touch warmer and lighter than both the green wild
    # ground and the mauve plaza paving, so a path reads as a path at 0.4x.
    "road_dk":     (38, 35, 54),
    "road":        (86, 78, 100),
    "road_lt":     (124, 112, 136),
    "road_warm":   (132, 110, 112),
}


def rgb(name):
    return PAL[name]


def mix(a, b, t):
    a, b = rgb(a) if isinstance(a, str) else a, rgb(b) if isinstance(b, str) else b
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def shade(c, f):
    """Multiply toward black (f<1) or toward white (f>1)."""
    c = rgb(c) if isinstance(c, str) else c
    if f <= 1:
        return tuple(max(0, min(255, int(round(v * f)))) for v in c)
    t = min(1.0, f - 1.0)
    return tuple(max(0, min(255, int(round(v + (255 - v) * t)))) for v in c)


def rgba(c, a=255):
    c = rgb(c) if isinstance(c, str) else c
    return (c[0], c[1], c[2], a)


# --------------------------------------------------------------------------
# Canvas
# --------------------------------------------------------------------------
class Sprite:
    """An isometric drawing surface with a declared footprint and anchor."""

    def __init__(self, fw, fh, hz, pad=8, extra_w=0, extra_top=0):
        self.fw, self.fh, self.hz, self.pad = fw, fh, hz, pad
        self.w = (fw + fh) * HW + 2 * pad + extra_w * 2
        self.h = (fw + fh) * HH + hz + 2 * pad + extra_top
        self.ax = fh * HW + pad + extra_w
        self.ay = hz + pad + extra_top
        self.img = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    # -- projection ---------------------------------------------------------
    def p(self, x, y, z=0.0):
        return (self.ax + (x - y) * HW, self.ay + (x + y) * HH - z)

    def pi(self, x, y, z=0.0):
        px, py = self.p(x, y, z)
        return (int(round(px)), int(round(py)))

    # -- primitives ---------------------------------------------------------
    def poly(self, pts, fill, outline=None, ow=1):
        pts = [self.pi(*q) for q in pts]
        self.d.polygon(pts, fill=rgba(fill) if fill is not None else None,
                       outline=rgba(outline) if outline else None, width=ow)

    def poly2d(self, pts, fill, outline=None):
        self.d.polygon([(int(round(a)), int(round(b))) for a, b in pts],
                       fill=rgba(fill) if fill is not None else None,
                       outline=rgba(outline) if outline else None)

    def line(self, a, b, colour, w=1):
        self.d.line([self.pi(*a), self.pi(*b)], fill=rgba(colour), width=w)

    def rect2d(self, x0, y0, x1, y1, fill, outline=None):
        self.d.rectangle([int(x0), int(y0), int(x1), int(y1)],
                         fill=rgba(fill) if fill is not None else None,
                         outline=rgba(outline) if outline else None)

    # -- isometric solids ---------------------------------------------------
    def diamond(self, x0, y0, x1, y1, z, fill, outline=None):
        self.poly([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], fill, outline)

    def box(self, x0, y0, x1, y1, z0, z1, top, right=None, left=None,
            outline="ink", lit_top=True):
        """A cuboid. `right` is the +x (screen down-right) face, `left` the +y face."""
        top_c = rgb(top) if isinstance(top, str) else top
        right = right if right is not None else shade(top_c, 0.72)
        left = left if left is not None else shade(top_c, 0.48)
        # +y face (screen lower-left)
        self.poly([(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], left, outline)
        # +x face (screen lower-right)
        self.poly([(x1, y0, z1), (x1, y1, z1), (x1, y1, z0), (x1, y0, z0)], right, outline)
        # top
        self.poly([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
                  top_c if lit_top else shade(top_c, 0.9), outline)

    def hip_roof(self, x0, y0, x1, y1, z, rise, eave=0.0, colour="wood",
                 outline="ink", ridge=None):
        """Four-sided hipped roof. Only the two viewer-facing slopes are drawn."""
        ax0, ay0, ax1, ay1 = x0 - eave, y0 - eave, x1 + eave, y1 + eave
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        # ridge runs along the longer axis
        if (x1 - x0) >= (y1 - y0):
            r0 = (x0 + (x1 - x0) * 0.28, cy, z + rise)
            r1 = (x1 - (x1 - x0) * 0.28, cy, z + rise)
        else:
            r0 = (cx, y0 + (y1 - y0) * 0.28, z + rise)
            r1 = (cx, y1 - (y1 - y0) * 0.28, z + rise)
        c = rgb(colour) if isinstance(colour, str) else colour
        # far slopes first (barely visible, but they close the silhouette)
        self.poly([(ax0, ay0, z), (ax1, ay0, z), r1, r0], shade(c, 0.55), outline)
        self.poly([(ax0, ay0, z), (ax0, ay1, z), r0], shade(c, 0.42), outline)
        # near slopes
        self.poly([(ax1, ay0, z), (ax1, ay1, z), r1], shade(c, 0.82), outline)
        self.poly([(ax0, ay1, z), (ax1, ay1, z), r1, r0], shade(c, 0.62), outline)
        if ridge:
            self.line((r0[0], r0[1], r0[2]), (r1[0], r1[1], r1[2]), ridge, 3)
        return r0, r1

    def gable_roof(self, x0, y0, x1, y1, z, rise, eave=0.0, colour="wood", outline="ink"):
        """Ridge along x. Gable ends at y0/y1."""
        ax0, ax1 = x0 - eave, x1 + eave
        cy = (y0 + y1) / 2.0
        c = rgb(colour) if isinstance(colour, str) else colour
        self.poly([(ax0, y0 - eave, z), (ax1, y0 - eave, z),
                   (ax1, cy, z + rise), (ax0, cy, z + rise)], shade(c, 0.58), outline)
        self.poly([(ax0, y1 + eave, z), (ax1, y1 + eave, z),
                   (ax1, cy, z + rise), (ax0, cy, z + rise)], shade(c, 0.88), outline)

    def post(self, x, y, z0, z1, r=0.09, colour="wood", outline="ink"):
        self.box(x - r, y - r, x + r, y + r, z0, z1, colour, outline=outline)

    # -- texture ------------------------------------------------------------
    def dither(self, pts, colour, density=0.10, seed=1):
        """Sparse 1px speckle inside a polygon -- the 16-bit texture cue."""
        rnd = random.Random(seed)
        ipts = [self.pi(*q) for q in pts]
        mask = Image.new("L", (self.w, self.h), 0)
        ImageDraw.Draw(mask).polygon(ipts, fill=255)
        xs = [p[0] for p in ipts]
        ys = [p[1] for p in ipts]
        px = self.img.load()
        mp = mask.load()
        for yy in range(max(0, min(ys)), min(self.h, max(ys) + 1)):
            for xx in range(max(0, min(xs)), min(self.w, max(xs) + 1)):
                if mp[xx, yy] and rnd.random() < density:
                    px[xx, yy] = rgba(colour)

    def glow(self, x, y, z, radius, colour="amber", strength=110, steps=7):
        """Soft lantern bloom, composited so it lights neighbours without a hard edge."""
        cx, cy = self.p(x, y, z)
        layer = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        dl = ImageDraw.Draw(layer)
        for i in range(steps, 0, -1):
            t = i / steps
            r = radius * t
            # steeper falloff than a plain linear ramp: a wide soft halo reads
            # as fog lying on top of the geometry instead of light coming off a
            # lamp, and every overlapping halo compounds it.
            a = int(strength * 0.72 * (1.0 - t) ** 2.6)
            if a <= 0:
                continue
            dl.ellipse([cx - r, cy - r * 0.62, cx + r, cy + r * 0.62], fill=rgba(colour, a))
        self.img.alpha_composite(layer)

    def shadow(self, x0, y0, x1, y1, alpha=90, inset=0.06):
        """Contact shadow on the ground under a footprint."""
        layer = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        pts = [self.pi(x0 + inset, y0 + inset, 0), self.pi(x1 - inset, y0 + inset, 0),
               self.pi(x1 - inset, y1 - inset, 0), self.pi(x0 + inset, y1 - inset, 0)]
        ImageDraw.Draw(layer).polygon(pts, fill=(3, 4, 12, alpha))
        self.img.alpha_composite(layer)

    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.img.save(path, "PNG", optimize=True)
        return {"w": self.w, "h": self.h, "anchor": [self.ax, self.ay],
                "footprint": [self.fw, self.fh]}


# --------------------------------------------------------------------------
# Shared motifs
# --------------------------------------------------------------------------
def lantern_post(s, x, y, h=33, colour="amber", glow_r=19, strength=78):
    """A standing lantern: dark post, glass head, bloom.

    `h` is the post height in PIXELS (z), not tiles -- everything vertical in
    this file is pixels and everything horizontal is tiles."""
    s.box(x - 0.085, y - 0.085, x + 0.085, y + 0.085, 0, 5, "metal_dk")
    s.post(x, y, 5, h, 0.055, "metal_dk")
    s.box(x - 0.10, y - 0.10, x + 0.10, y + 0.10, h, h + 11, colour,
          right=shade(colour, 0.82), left=shade(colour, 0.60))
    s.box(x - 0.135, y - 0.135, x + 0.135, y + 0.135, h + 11, h + 15, "metal_dk")
    s.box(x - 0.05, y - 0.05, x + 0.05, y + 0.05, h + 15, h + 18, shade(colour, 0.7))
    s.glow(x, y, h + 6, glow_r, colour, strength)
    s.glow(x, y, 3, int(glow_r * 0.9), colour, int(strength * 0.30))


def banner(s, x, y, z, w, hgt, colour, outline="ink"):
    """A hanging cloth panel facing the viewer -- the access badge."""
    s.poly([(x - w, y, z), (x + w, y, z), (x + w, y, z - hgt), (x - w, y, z - hgt)],
           colour, outline)


def step_run(s, x0, x1, y, steps, z, colour="stone"):
    """Steps descending in +y toward the viewer's lower-left."""
    for i in range(steps):
        zz = z * (steps - i) / steps
        s.box(x0, y + i * 0.22, x1, y + (i + 1) * 0.22, 0, zz, colour)


def paved_base(s, fw, fh, z=0.10, colour="stone_dk", inset=0.0, seed=3):
    s.box(inset, inset, fw - inset, fh - inset, 0, z, colour)
    s.dither([(inset, inset, z), (fw - inset, inset, z),
              (fw - inset, fh - inset, z), (inset, fh - inset, z)],
             shade(colour, 1.22), 0.07, seed)


# ==========================================================================
# 1. ACCESS-LEVEL BUILDINGS  (3x3 footprint)
# ==========================================================================
ACCESS_FW = ACCESS_FH = 3
ACCESS_HZ = 118


def build_private(path):
    """PRIVATE -- a closed compound. Unbroken wall, shut gate, no way in.

    Silhouette: one SOLID slab. Nothing shows through. Pink."""
    s = Sprite(ACCESS_FW, ACCESS_FH, ACCESS_HZ, pad=10)
    s.shadow(0, 0, 3, 3, 100)
    paved_base(s, 3, 3, 8, "stone_dk", 0.02, seed=11)

    WALL_H = 74
    # Perimeter wall, four runs, fully closed.
    s.box(0.05, 0.05, 2.95, 0.45, 8, 8 + WALL_H, "stone")        # north
    s.box(0.05, 0.05, 0.45, 2.95, 8, 8 + WALL_H, "stone")        # west
    s.box(2.55, 0.05, 2.95, 2.95, 8, 8 + WALL_H, shade("stone", 1.1))   # east (lit)
    s.box(0.05, 2.55, 2.95, 2.95, 8, 8 + WALL_H, shade("stone", 0.92))  # south (viewer)

    # Solid keep behind the wall -- fills the silhouette so no gap reads as a way in.
    s.box(0.55, 0.5, 2.45, 2.3, 8, 8 + 96, "stone_dk")
    s.dither([(0.55, 2.3, 8 + 96), (2.45, 2.3, 8 + 96), (2.45, 2.3, 8), (0.55, 2.3, 8)],
             shade("stone_dk", 1.3), 0.05, 21)
    # Roof: a dark plum, not a bright pink field. Pink is the ACCENT that says
    # "private" -- on the ridge, the gate bar and the lamps. A whole pink roof
    # read as a circus tent at 0.4x and drowned the wall, which is the message.
    s.hip_roof(0.42, 0.38, 2.58, 2.42, 8 + 96, 26, eave=0.14,
               colour=mix("private_dk", "void", 0.42), ridge=PAL["private"])

    # Crenellations: a hard, defensive top edge, read even as 8 grey pixels.
    for i in range(6):
        x = 0.12 + i * 0.47
        s.box(x, 2.55, x + 0.28, 2.95, 8 + WALL_H, 8 + WALL_H + 9, shade("stone", 1.16))
    for i in range(6):
        y = 0.12 + i * 0.47
        s.box(2.55, y, 2.95, y + 0.28, 8 + WALL_H, 8 + WALL_H + 9, shade("stone", 1.22))

    # The gate: shut. Two leaves, a heavy pink bar straight across, no gap.
    gx0, gx1 = 1.05, 1.95
    s.box(gx0, 2.5, gx1, 2.98, 8, 8 + 56, "wood_dk", right=shade("wood_dk", 0.8),
          left=shade("wood_dk", 1.05))
    # door leaves + centre seam
    s.poly([(gx0 + 0.04, 2.99, 8 + 2), (1.5, 2.99, 8 + 2),
            (1.5, 2.99, 8 + 52), (gx0 + 0.04, 2.99, 8 + 52)], "wood", "ink")
    s.poly([(1.5, 2.99, 8 + 2), (gx1 - 0.04, 2.99, 8 + 2),
            (gx1 - 0.04, 2.99, 8 + 52), (1.5, 2.99, 8 + 52)], shade("wood", 0.86), "ink")
    # the bar -- the whole point of the building, in the access colour
    s.poly([(gx0 - 0.02, 3.0, 8 + 30), (gx1 + 0.02, 3.0, 8 + 30),
            (gx1 + 0.02, 3.0, 8 + 20), (gx0 - 0.02, 3.0, 8 + 20)], "private", "ink")
    s.poly([(1.36, 3.02, 8 + 36), (1.64, 3.02, 8 + 36),
            (1.64, 3.02, 8 + 14), (1.36, 3.02, 8 + 14)], "private_dk", "ink")

    # Shuttered windows, dark: somebody is in there, you just cannot see in.
    for wx in (0.45, 2.15):
        s.poly([(wx, 3.0, 8 + 56), (wx + 0.40, 3.0, 8 + 56),
                (wx + 0.40, 3.0, 8 + 34), (wx, 3.0, 8 + 34)], "night", "ink")
        s.line((wx + 0.20, 3.01, 8 + 56), (wx + 0.20, 3.01, 8 + 34), "wood_dk", 1)
    for wy in (0.45, 2.15):
        s.poly([(3.0, wy, 8 + 56), (3.0, wy + 0.40, 8 + 56),
                (3.0, wy + 0.40, 8 + 34), (3.0, wy, 8 + 34)], "night", "ink")

    # Pink lamps flanking the gate: lit, but they light the outside only.
    lantern_post(s, 0.85, 2.78, 36, "private", 24, 88)
    lantern_post(s, 2.15, 2.78, 36, "private", 24, 88)
    return s.save(path)


def build_public_view(path):
    """PUBLIC_VIEW -- a colonnade. You can see the whole interior and not enter.

    Silhouette: a COMB. Bright gaps between columns. Sky blue."""
    s = Sprite(ACCESS_FW, ACCESS_FH, ACCESS_HZ, pad=10)
    s.shadow(0, 0, 3, 3, 100)
    paved_base(s, 3, 3, 10, "stone_dk", 0.02, seed=12)
    # stylobate -- the raised platform a colonnade always stands on
    s.box(0.14, 0.14, 2.86, 2.86, 10, 22, "stone_lt",
          right=shade("stone_lt", 0.74), left=shade("stone_lt", 0.5))

    # Lit interior floor + back wall, so the gaps between columns glow.
    s.box(0.5, 0.5, 2.5, 2.5, 22, 24, shade("amber_dk", 0.85))
    s.box(0.42, 0.42, 2.58, 0.66, 22, 22 + 62, "stone_dk")
    s.box(0.42, 0.42, 0.66, 2.58, 22, 22 + 62, shade("stone_dk", 0.9))
    s.glow(1.5, 1.4, 30, 60, "amber", 70)
    # Interior furniture, visible through the gaps -- proof there is something to see.
    s.box(1.0, 0.85, 2.1, 1.15, 24, 24 + 16, "wood")
    s.box(1.15, 1.75, 1.85, 2.05, 24, 24 + 12, "wood_dk")

    COL_H = 66
    cols_x = [0.30, 1.05, 1.80, 2.55]
    # Colonnade on the two viewer-facing sides only; gaps are the message.
    for cx in cols_x:
        s.box(cx - 0.11, 2.64, cx + 0.11, 2.86, 22, 22 + COL_H, "stone_lt")
        s.box(cx - 0.15, 2.60, cx + 0.15, 2.90, 22 + COL_H, 22 + COL_H + 7, "stone_hi")
        s.box(cx - 0.15, 2.60, cx + 0.15, 2.90, 22, 22 + 5, "stone_hi")
    for cy in cols_x:
        s.box(2.64, cy - 0.11, 2.86, cy + 0.11, 22, 22 + COL_H, shade("stone_lt", 1.08))
        s.box(2.60, cy - 0.15, 2.90, cy + 0.15, 22 + COL_H, 22 + COL_H + 7, "stone_hi")
        s.box(2.60, cy - 0.15, 2.90, cy + 0.15, 22, 22 + 5, "stone_hi")

    # Architrave + a SHALLOW HIPPED roof. A flat plate was a solid blue slab
    # from this camera and hid the colonnade completely -- and the colonnade is
    # the whole statement. A pitched roof keeps the columns and their gaps.
    z = 22 + COL_H + 7
    s.box(0.16, 0.16, 2.90, 2.90, z, z + 9, "stone_lt",
          right=shade("stone_lt", 0.78), left=shade("stone_lt", 0.56))
    # blue frieze band along both viewer faces -- the access colour, held high
    s.poly([(0.16, 2.90, z + 8), (2.90, 2.90, z + 8),
            (2.90, 2.90, z + 1), (0.16, 2.90, z + 1)], "view", "ink")
    s.poly([(2.90, 0.16, z + 8), (2.90, 2.90, z + 8),
            (2.90, 2.90, z + 1), (2.90, 0.16, z + 1)], shade("view", 0.82), "ink")
    s.hip_roof(0.30, 0.30, 2.76, 2.76, z + 9, 20, eave=0.12,
               colour=mix("view_dk", "void", 0.30), ridge=PAL["view"])

    # The rail: waist-high, unbroken across the front. Look, do not walk in.
    for zz, col in [(22 + 30, "view"), (22 + 18, shade("view", 0.6))]:
        s.poly([(0.30, 2.99, zz), (2.55, 2.99, zz),
                (2.55, 2.99, zz - 4), (0.30, 2.99, zz - 4)], col, "ink")
        s.poly([(2.99, 0.30, zz), (2.99, 2.55, zz),
                (2.99, 2.55, zz - 4), (2.99, 0.30, zz - 4)], shade(col, 0.8), "ink")

    lantern_post(s, 0.30, 2.99, 40, "view", 24, 80)
    lantern_post(s, 2.99, 0.30, 40, "view", 24, 80)
    return s.save(path)


def build_public_write(path):
    """PUBLIC_WRITE -- open ground. A canopy on four posts, no walls, wide steps.

    Silhouette: a LOW WIDE CANOPY with daylight under it. Amber."""
    s = Sprite(ACCESS_FW, ACCESS_FH, ACCESS_HZ, pad=10)
    s.shadow(0, 0, 3, 3, 80)
    paved_base(s, 3, 3, 6, "stone_dk", 0.02, seed=13)
    # A low deck you step straight onto -- two broad flights, no threshold.
    s.box(0.35, 0.35, 2.65, 2.65, 6, 16, "wood_lt",
          right=shade("wood_lt", 0.76), left=shade("wood_lt", 0.55))
    s.dither([(0.35, 0.35, 16), (2.65, 0.35, 16), (2.65, 2.65, 16), (0.35, 2.65, 16)],
             shade("wood_lt", 1.2), 0.08, 31)
    for i in range(3):
        zz = 16 * (3 - i) / 3
        s.box(0.55, 2.65 + i * 0.14, 2.45, 2.65 + (i + 1) * 0.14, 0, zz, "wood")
        s.box(2.65 + i * 0.14, 0.55, 2.65 + (i + 1) * 0.14, 2.45, 0, zz, shade("wood", 1.08))

    # Four corner posts. That is the entire structure -- nothing encloses anything.
    POST_H = 62
    corners = [(0.5, 0.5), (2.5, 0.5), (0.5, 2.5), (2.5, 2.5)]
    for (px, py) in corners:
        s.post(px, py, 16, 16 + POST_H, 0.10, "wood")
    z = 16 + POST_H

    # A table and two benches under it: the place is furnished for use.
    s.box(1.10, 1.10, 1.90, 1.90, 16, 16 + 20, "wood_hi",
          right=shade("wood_hi", 0.78), left=shade("wood_hi", 0.56))
    s.box(0.78, 1.20, 1.00, 1.80, 16, 16 + 12, "wood")
    s.box(2.00, 1.20, 2.22, 1.80, 16, 16 + 12, "wood")
    s.box(1.20, 2.00, 1.80, 2.22, 16, 16 + 12, "wood")
    # A lit lantern standing ON the table, and its pool of light on the deck.
    # Drawn BEFORE the canopy, or the bloom lands on top of the roof.
    s.box(1.42, 1.42, 1.58, 1.58, 16 + 20, 16 + 32, "amber_lt",
          right="amber", left="amber_dk")
    s.glow(1.5, 1.5, 16 + 26, 56, "amber", 110)
    s.glow(1.5, 1.7, 18, 64, "amber", 58)

    # Canopy: a modest overhang. A wide one hid the deck, and an open building
    # that shows no floor does not read as open.
    s.box(0.36, 0.36, 2.64, 2.64, z, z + 6, shade("amber_dk", 0.7))
    s.hip_roof(0.24, 0.24, 2.76, 2.76, z + 6, 20, eave=0.16, colour="write_dk",
               ridge=PAL["write"])
    # amber valance hanging off the two viewer eaves -- reads as an awning at any size
    s.poly([(0.08, 2.92, z + 6), (2.92, 2.92, z + 6),
            (2.92, 2.92, z - 3), (0.08, 2.92, z - 3)], "write", "ink")
    s.poly([(2.92, 0.08, z + 6), (2.92, 2.92, z + 6),
            (2.92, 2.92, z - 3), (2.92, 0.08, z - 3)], shade("write", 0.82), "ink")
    # scallops, so the valance is cloth not a wall
    for i in range(7):
        xx = 0.08 + i * 0.405
        s.poly([(xx, 2.92, z - 3), (xx + 0.2, 2.92, z - 3), (xx + 0.1, 2.92, z - 9)],
               "write", "ink")
        s.poly([(2.92, xx, z - 3), (2.92, xx + 0.2, z - 3), (2.92, xx + 0.1, z - 9)],
               shade("write", 0.82), "ink")
    return s.save(path)


# ==========================================================================
# 2. CIVIC STRUCTURES  (4x4 footprint)
# ==========================================================================
CIVIC_FW = CIVIC_FH = 4
CIVIC_HZ = 150


def civic(hz=CIVIC_HZ, pad=10):
    return Sprite(CIVIC_FW, CIVIC_FH, hz, pad=pad)


def build_plaza(path):
    """PLAZA -- the meeting ground: a fountain, a ring of paving, four lanterns."""
    s = civic(136)
    s.shadow(0, 0, 4, 4, 70)
    paved_base(s, 4, 4, 8, "stone_dk", 0.02, seed=41)
    # concentric paving rings, so it reads as a designed square not a floor
    s.box(0.35, 0.35, 3.65, 3.65, 8, 12, "stone")
    s.box(0.9, 0.9, 3.1, 3.1, 12, 16, "stone_lt")
    s.dither([(0.9, 0.9, 16), (3.1, 0.9, 16), (3.1, 3.1, 16), (0.9, 3.1, 16)],
             "stone_hi", 0.10, 42)

    # Fountain: a big lit basin. It is the centre of the world, so it has to
    # hold the eye at 0.4x against a whole square of paving.
    s.box(1.05, 1.05, 2.95, 2.95, 16, 24, "stone_lt",
          right=shade("stone_lt", 0.78), left=shade("stone_lt", 0.56))
    s.box(1.15, 1.15, 2.85, 2.85, 24, 34, "stone_hi",
          right=shade("stone_hi", 0.76), left=shade("stone_hi", 0.54))
    s.diamond(1.28, 1.28, 2.72, 2.72, 33, "water")
    s.diamond(1.42, 1.42, 2.58, 2.58, 33, "water_lt")
    s.glow(2.0, 2.0, 34, 64, "water_lt", 52)
    # tiers
    s.box(1.62, 1.62, 2.38, 2.38, 33, 54, "stone_lt")
    s.diamond(1.5, 1.5, 2.5, 2.5, 54, "water_lt")
    s.diamond(1.62, 1.62, 2.38, 2.38, 55, "water")
    s.box(1.82, 1.82, 2.18, 2.18, 54, 76, "stone_hi")
    s.diamond(1.72, 1.72, 2.28, 2.28, 76, "water_lt")
    # falling water, drawn before the finial so the light sits on top
    for dx, dy in [(-0.12, 0.12), (0.12, -0.12), (0.14, 0.14), (-0.14, -0.14)]:
        s.line((2.0 + dx, 2.0 + dy, 74), (2.0 + dx * 3.0, 2.0 + dy * 3.0, 56), "water_lt", 2)
        s.line((2.0 + dx * 3.4, 2.0 + dy * 3.4, 52), (2.0 + dx * 5.6, 2.0 + dy * 5.6, 36),
               "water_lt", 2)
    # lit finial: the brightest point on the campus
    s.box(1.9, 1.9, 2.1, 2.1, 76, 92, "stone_hi")
    s.box(1.82, 1.82, 2.18, 2.18, 92, 100, "amber_lt", right="amber", left="amber_dk")
    s.box(1.9, 1.9, 2.1, 2.1, 100, 106, "amber_glow")
    s.glow(2.0, 2.0, 98, 84, "amber_lt", 120)

    # Four lantern posts marking the corners of the square.
    for (px, py) in [(0.6, 0.6), (3.4, 0.6), (0.6, 3.4), (3.4, 3.4)]:
        lantern_post(s, px, py, 46, "amber", 30, 96)
    # Benches on two sides.
    for (bx, by, ax) in [(1.2, 3.45, True), (2.8, 3.45, True)]:
        s.box(bx - 0.35, by - 0.1, bx + 0.35, by + 0.1, 12, 12 + 9, "wood")
        s.box(bx - 0.35, by + 0.08, bx + 0.35, by + 0.14, 12 + 9, 12 + 20, "wood_dk")
    return s.save(path)


def build_library(path):
    """LIBRARY -- tall, quiet, warm windows, a great arched door, books inside."""
    s = civic(180)
    s.shadow(0, 0, 4, 4, 100)
    paved_base(s, 4, 4, 8, "stone_dk", 0.02, seed=43)
    s.box(0.2, 0.2, 3.8, 3.8, 8, 18, "stone_lt", right=shade("stone_lt", 0.76),
          left=shade("stone_lt", 0.54))
    BODY = 104
    s.box(0.45, 0.45, 3.55, 3.55, 18, 18 + BODY, "stone",
          right=shade("stone", 1.12), left=shade("stone", 0.86))
    s.dither([(0.45, 3.55, 18 + BODY), (3.55, 3.55, 18 + BODY),
              (3.55, 3.55, 18), (0.45, 3.55, 18)], "stone_hi", 0.05, 44)
    z = 18 + BODY

    # Tall warm windows -- a library is read from outside by its lit windows.
    for i, x in enumerate([0.75, 1.45, 2.15, 2.85]):
        for (zz, hh) in [(28, 40), (76, 34)]:
            s.poly([(x, 3.56, 18 + zz), (x + 0.42, 3.56, 18 + zz),
                    (x + 0.42, 3.56, 18 + zz + hh), (x, 3.56, 18 + zz + hh)],
                   "stone_dk", "ink")
            s.poly([(x + 0.05, 3.57, 18 + zz + 3), (x + 0.37, 3.57, 18 + zz + 3),
                    (x + 0.37, 3.57, 18 + zz + hh - 5), (x + 0.05, 3.57, 18 + zz + hh - 5)],
                   "amber_lt" if i % 2 == 0 else "amber", "ink")
            s.glow(x + 0.21, 3.56, 18 + zz + hh / 2, 26, "amber", 55)
    for y in [0.75, 1.45, 2.15, 2.85]:
        s.poly([(3.56, y, 18 + 28), (3.56, y + 0.42, 18 + 28),
                (3.56, y + 0.42, 18 + 78), (3.56, y, 18 + 78)], "stone_dk", "ink")
        s.poly([(3.57, y + 0.05, 18 + 31), (3.57, y + 0.37, 18 + 31),
                (3.57, y + 0.37, 18 + 73), (3.57, y + 0.05, 18 + 73)], "amber", "ink")

    # Arched doorway with a stack of books visible in the light.
    s.poly([(1.5, 3.58, 18), (2.5, 3.58, 18), (2.5, 3.58, 18 + 46),
            (2.3, 3.58, 18 + 58), (1.7, 3.58, 18 + 58), (1.5, 3.58, 18 + 46)],
           "night", "ink")
    s.poly([(1.62, 3.59, 18 + 2), (2.38, 3.59, 18 + 2), (2.38, 3.59, 18 + 44),
            (2.22, 3.59, 18 + 54), (1.78, 3.59, 18 + 54), (1.62, 3.59, 18 + 44)],
           "amber_dk", "ink")
    for i, (bx, bw, bh, bc) in enumerate([(1.72, 0.10, 22, "violet_lt"),
                                          (1.86, 0.10, 28, "amber"),
                                          (2.00, 0.10, 18, "leaf_hi"),
                                          (2.14, 0.10, 25, "private")]):
        s.poly([(bx, 3.60, 18 + 4), (bx + bw, 3.60, 18 + 4),
                (bx + bw, 3.60, 18 + 4 + bh), (bx, 3.60, 18 + 4 + bh)], bc, "ink")
    s.glow(2.0, 3.58, 18 + 26, 44, "amber", 80)

    # Steep gable roof + a lit cupola: the tallest thing on the campus.
    s.gable_roof(0.3, 0.3, 3.7, 3.7, z, 46, eave=0.22, colour="violet_dk")
    s.box(1.7, 1.7, 2.3, 2.3, z + 40, z + 60, "stone_lt")
    s.box(1.78, 1.78, 2.22, 2.22, z + 60, z + 66, "amber")
    s.glow(2.0, 2.0, z + 62, 46, "amber_lt", 100)
    lantern_post(s, 1.35, 3.75, 38, "amber", 24, 88)
    lantern_post(s, 2.65, 3.75, 38, "amber", 24, 88)
    return s.save(path)


def build_workshop(path):
    """WORKSHOP -- a lean-to shed over a working yard: forge, anvil, tool rack.

    The roof covers only the BACK half. From this camera a full roof hides
    everything under it, and a workshop that shows no work is just a house."""
    s = civic(160)
    s.shadow(0, 0, 4, 4, 95)
    paved_base(s, 4, 4, 8, "stone_dk", 0.02, seed=45)
    s.box(0.25, 0.25, 3.75, 3.75, 8, 14, "wood_dk")
    YARD = 2.05   # everything at y > YARD is open sky
    BODY = 70

    # Back and side walls, only as far forward as the roof goes.
    s.box(0.35, 0.35, 3.65, 0.72, 14, 14 + BODY, "wood")
    s.box(0.35, 0.35, 0.72, YARD, 14, 14 + BODY, shade("wood", 0.86))
    s.box(3.28, 0.35, 3.65, YARD, 14, 14 + BODY, shade("wood", 1.12))
    # plank seams instead of speckle: a wall, not dirt
    for i in range(8):
        s.line((0.4 + i * 0.41, 0.73, 14), (0.4 + i * 0.41, 0.73, 14 + BODY),
               shade("wood", 0.7), 1)

    # Tool rack on the back wall -- visible because nothing covers it.
    for i, c in enumerate(["metal_lt", "metal", "amber_dk", "metal_lt", "metal",
                           "wood_hi"]):
        s.poly([(0.85 + i * 0.42, 0.74, 14 + 30), (0.96 + i * 0.42, 0.74, 14 + 30),
                (0.96 + i * 0.42, 0.74, 14 + 54), (0.85 + i * 0.42, 0.74, 14 + 54)],
               c, "ink")
    s.line((0.8, 0.74, 14 + 56), (3.2, 0.74, 14 + 56), "wood_lt", 2)

    # Forge, pushed to the front-left of the covered half so its mouth faces
    # the viewer and the glow lands on the open yard.
    s.box(0.85, 1.35, 1.85, 2.0, 14, 14 + 36, "stone_dk",
          right=shade("stone_dk", 1.2), left=shade("stone_dk", 0.95))
    s.poly([(0.98, 2.02, 14 + 6), (1.72, 2.02, 14 + 6),
            (1.72, 2.02, 14 + 30), (0.98, 2.02, 14 + 30)], "amber_dk", "ink")
    s.poly([(1.06, 2.03, 14 + 9), (1.64, 2.03, 14 + 9),
            (1.64, 2.03, 14 + 26), (1.06, 2.03, 14 + 26)], "amber", None)
    s.poly([(1.16, 2.04, 14 + 12), (1.54, 2.04, 14 + 12),
            (1.54, 2.04, 14 + 22), (1.16, 2.04, 14 + 22)], "amber_glow", None)
    s.glow(1.35, 2.05, 14 + 18, 92, "amber", 128)
    # chimney, tall and clear of the roof
    s.box(1.1, 1.5, 1.55, 1.9, 14 + 36, 14 + BODY + 66, "stone_dk",
          right=shade("stone_dk", 1.25), left=shade("stone_dk", 0.9))
    s.box(1.04, 1.44, 1.61, 1.96, 14 + BODY + 66, 14 + BODY + 74, "stone")

    # --- the yard: the work itself, out in the open ------------------------
    # anvil on a stump
    s.box(2.55, 2.55, 2.95, 2.95, 14, 14 + 16, "wood_dk")
    s.box(2.5, 2.62, 3.05, 2.9, 14 + 16, 14 + 22, "metal_dk")
    s.box(2.38, 2.66, 3.1, 2.86, 14 + 22, 14 + 27, "metal")
    s.box(2.62, 2.68, 2.88, 2.84, 14 + 27, 14 + 29, "metal_lt")
    s.glow(2.72, 2.78, 14 + 30, 26, "amber", 70)
    # workbench with clamped work + a bucket
    s.box(2.35, 1.25, 3.45, 1.8, 14, 14 + 24, "wood_lt",
          right=shade("wood_lt", 0.78), left=shade("wood_lt", 0.56))
    s.box(2.3, 1.2, 3.5, 1.85, 14 + 24, 14 + 29, "wood_hi")
    for i, c in enumerate(["metal_lt", "amber", "metal"]):
        s.box(2.5 + i * 0.32, 1.35, 2.62 + i * 0.32, 1.47, 14 + 29, 14 + 29 + 12 + i * 4, c)
    s.box(3.3, 3.2, 3.6, 3.5, 14, 14 + 14, "metal_dk")
    # timber stack + crates in the yard
    s.box(0.6, 2.9, 1.5, 3.2, 14, 14 + 10, "wood_hi")
    s.box(0.6, 2.9, 1.5, 3.2, 14 + 10, 14 + 19, "wood_lt")
    s.box(1.75, 3.15, 2.25, 3.65, 14, 14 + 24, "wood_hi")
    s.box(1.8, 3.2, 2.2, 3.6, 14 + 24, 14 + 42, "wood_lt")
    # sparks drifting off the anvil
    for (sx, sy, sz, r) in [(2.8, 2.6, 44, 5), (2.95, 2.5, 54, 4), (2.7, 2.45, 62, 3)]:
        s.glow(sx, sy, 14 + sz, r, "amber_lt", 150)

    z = 14 + BODY
    # Lean-to roof: a single slope over the back half, front edge held on posts.
    s.post(0.5, YARD, 14, z, 0.10, "wood_lt")
    s.post(2.0, YARD, 14, z, 0.10, "wood_lt")
    s.post(3.5, YARD, 14, z, 0.10, "wood_lt")
    s.poly([(0.2, 0.2, z + 30), (3.8, 0.2, z + 30),
            (3.8, YARD + 0.18, z), (0.2, YARD + 0.18, z)], shade("wood_dk", 1.15), "ink")
    # roof battens so the slope is not one dead plane
    for i in range(6):
        t = (i + 1) / 7
        s.line((0.2, 0.2 + (YARD - 0.02) * t, z + 30 - 30 * t),
               (3.8, 0.2 + (YARD - 0.02) * t, z + 30 - 30 * t), shade("wood_dk", 0.85), 1)
    # fascia along the open eave, lit from the forge below
    s.poly([(0.2, YARD + 0.18, z), (3.8, YARD + 0.18, z),
            (3.8, YARD + 0.18, z - 7), (0.2, YARD + 0.18, z - 7)], "wood", "ink")
    s.poly([(0.2, YARD + 0.18, z - 6), (3.8, YARD + 0.18, z - 6),
            (3.8, YARD + 0.18, z - 8), (0.2, YARD + 0.18, z - 8)], "amber_dk", None)
    # ridge cap
    s.poly([(0.2, 0.2, z + 30), (3.8, 0.2, z + 30),
            (3.8, 0.2, z + 24), (0.2, 0.2, z + 24)], "metal_dk", "ink")
    # smoke, above everything
    for i, (r, a) in enumerate([(10, 62), (14, 44), (18, 28)]):
        s.glow(1.32 + i * 0.1, 1.7 - i * 0.16, z + 82 + i * 15, r, "cloth_lt", a)
    lantern_post(s, 3.72, 3.72, 40, "amber", 28, 98)
    return s.save(path)


def build_stage(path):
    """STAGE -- a raised platform, proscenium arch, curtain, footlights."""
    s = civic(165)
    s.shadow(0, 0, 4, 4, 95)
    paved_base(s, 4, 4, 6, "stone_dk", 0.02, seed=47)
    DECK = 34
    s.box(0.3, 0.3, 3.7, 3.2, 6, 6 + DECK, "wood",
          right=shade("wood", 1.15), left=shade("wood", 0.9))
    s.diamond(0.3, 0.3, 3.7, 3.2, 6 + DECK, "wood_lt")
    for i in range(9):
        s.line((0.3 + i * 0.42, 0.3, 6 + DECK + 1), (0.3 + i * 0.42, 3.2, 6 + DECK + 1),
               shade("wood", 0.8), 1)
    # steps up from the plaza side
    for i in range(4):
        zz = (6 + DECK) * (4 - i) / 4
        s.box(1.2, 3.2 + i * 0.18, 2.8, 3.2 + (i + 1) * 0.18, 0, zz,
              shade("wood", 0.78 + i * 0.07))

    z = 6 + DECK
    # Proscenium: two heavy piers and a beam, framing the performer.
    s.box(0.35, 0.35, 0.75, 0.85, z, z + 88, "stone_dk")
    s.box(3.25, 0.35, 3.65, 0.85, z, z + 88, shade("stone_dk", 1.15))
    s.box(0.35, 0.35, 3.65, 0.85, z + 88, z + 104, "stone")
    # backdrop
    s.box(0.7, 0.42, 3.3, 0.62, z, z + 88, "violet_dk")
    # curtains, drawn back, violet with amber trim
    for (cx0, cx1, c) in [(0.7, 1.35, "violet"), (2.65, 3.3, "violet")]:
        s.poly([(cx0, 0.9, z), (cx1, 0.9, z), (cx1, 0.9, z + 88), (cx0, 0.9, z + 88)],
               c, "ink")
        for i in range(4):
            s.line((cx0 + 0.13 * (i + 1), 0.92, z), (cx0 + 0.13 * (i + 1), 0.92, z + 88),
                   "violet_dk", 1)
        s.poly([(cx0, 0.9, z + 88), (cx1, 0.9, z + 88), (cx1, 0.9, z + 80),
                (cx0, 0.9, z + 80)], "amber", "ink")
    # pelmet
    s.poly([(0.6, 0.88, z + 104), (3.4, 0.88, z + 104),
            (3.4, 0.88, z + 86), (0.6, 0.88, z + 86)], "violet", "ink")
    for i in range(9):
        xx = 0.6 + i * 0.31
        s.poly([(xx, 0.88, z + 86), (xx + 0.16, 0.88, z + 86), (xx + 0.08, 0.88, z + 78)],
               "amber", "ink")

    # Footlights along the front edge: the unmistakable stage cue.
    for i in range(7):
        lx = 0.45 + i * 0.48
        s.box(lx - 0.07, 3.08, lx + 0.07, 3.18, z, z + 8, "amber_lt", right="amber",
              left="amber_dk")
        s.glow(lx, 3.12, z + 6, 22, "amber_lt", 92)
    s.glow(2.0, 1.8, z + 30, 96, "amber", 52)
    return s.save(path)


def build_garden(path):
    """GARDEN -- no building. Hedge, trees, pond, an arbour and a bench. Quiet."""
    s = civic(120)
    s.shadow(0, 0, 4, 4, 55)
    # soft earth, not paving
    s.box(0.02, 0.02, 3.98, 3.98, 0, 5, "leaf_dk")
    s.dither([(0.02, 0.02, 5), (3.98, 0.02, 5), (3.98, 3.98, 5), (0.02, 3.98, 5)],
             "leaf", 0.20, 51)
    # gravel path through it
    s.poly([(1.6, 0.1, 5.5), (2.4, 0.1, 5.5), (2.4, 3.9, 5.5), (1.6, 3.9, 5.5)],
           "stone_dk", None)
    s.dither([(1.6, 0.1, 5.6), (2.4, 0.1, 5.6), (2.4, 3.9, 5.6), (1.6, 3.9, 5.6)],
             "stone_lt", 0.14, 52)

    # Low hedge round the outside: an enclosure you can see over.
    for (a, b, c, d) in [(0.05, 0.05, 3.95, 0.35), (0.05, 3.65, 3.95, 3.95),
                         (0.05, 0.05, 0.35, 3.95), (3.65, 0.05, 3.95, 3.95)]:
        s.box(a, b, c, d, 5, 22, "leaf")
        s.dither([(a, d, 22), (c, d, 22), (c, d, 5), (a, d, 5)], "leaf_hi", 0.12, 53)
    # gaps in the hedge where the path crosses
    s.box(1.62, 0.03, 2.38, 0.37, 0, 5, "leaf_dk")
    s.box(1.62, 3.63, 2.38, 3.97, 0, 5, "leaf_dk")

    # Pond with a reflected lantern.
    s.diamond(0.55, 1.5, 1.45, 3.0, 6, "water", "leaf_dk")
    s.diamond(0.7, 1.68, 1.3, 2.8, 6, "water_lt")
    s.line((0.9, 2.1, 7), (1.15, 2.5, 7), "amber_dk", 2)

    # Trees: trunk + a canopy built from three offset lumps. One box reads as
    # a crate; three overlapping ones read as foliage.
    def tree(tx, ty, h, r, seed):
        s.post(tx, ty, 5, 5 + h, 0.10, "wood_dk")
        s.post(tx, ty, 5, 5 + h * 0.6, 0.06, shade("wood_dk", 1.5))
        base = 5 + h
        # Darker and rounder than the first pass: at 0.4x a bright mint canopy
        # read as a stack of crates and jumped out of the dusk palette.
        lumps = [(-r * 0.58, r * 0.28, r * 0.95, 0.0, shade("leaf_dk", 1.25)),
                 (r * 0.50, -r * 0.32, r * 0.82, r * 7, "leaf"),
                 (-r * 0.12, -r * 0.52, r * 0.72, r * 15, shade("leaf", 1.20)),
                 (r * 0.10, r * 0.10, r * 0.58, r * 23, "leaf_lt"),
                 (-r * 0.05, -r * 0.05, r * 0.34, r * 30, shade("leaf_lt", 1.12))]
        for (ox, oy, rr, dz, col) in lumps:
            s.box(tx + ox - rr, ty + oy - rr, tx + ox + rr, ty + oy + rr,
                  base + dz, base + dz + rr * 38, col,
                  right=shade(col, 0.80), left=shade(col, 0.55), outline=None)
            # a lit rim on the sunward corner only, so the lump reads as round
            s.line((tx + ox + rr * 0.2, ty + oy - rr, base + dz + rr * 38),
                   (tx + ox + rr, ty + oy - rr * 0.2, base + dz + rr * 38),
                   shade(col, 1.22), 1)
            # break the box corners with small notches -- a hard cuboid corner
            # is the single thing that makes foliage read as a crate
            for (nx, ny, nz, nr) in [(-rr, -rr, rr * 38, rr * 0.42),
                                     (rr, rr, rr * 10, rr * 0.36),
                                     (-rr, rr, rr * 30, rr * 0.30),
                                     (rr, -rr, rr * 20, rr * 0.34)]:
                s.box(tx + ox + nx - nr, ty + oy + ny - nr,
                      tx + ox + nx + nr, ty + oy + ny + nr,
                      base + dz + nz - nr * 16, base + dz + nz + nr * 16,
                      shade(col, 1.08), right=shade(col, 0.85),
                      left=shade(col, 0.6), outline=None)
        s.dither([(tx - r, ty + r, base + r * 30), (tx + r, ty + r, base + r * 30),
                  (tx + r, ty + r, base), (tx - r, ty + r, base)],
                 shade("leaf_hi", 0.9), 0.10, seed)

    tree(0.85, 0.85, 26, 0.40, 54)
    tree(3.15, 0.75, 20, 0.32, 55)
    tree(3.25, 3.25, 30, 0.44, 56)
    tree(0.75, 3.3, 17, 0.27, 57)

    # Arbour: a trellis arch over the path with a bench under it.
    for (ax, ay) in [(1.6, 2.05), (2.4, 2.05), (1.6, 2.55), (2.4, 2.55)]:
        s.post(ax, ay, 5, 5 + 48, 0.06, "wood_lt")
    s.box(1.54, 1.99, 2.46, 2.61, 5 + 48, 5 + 53, "wood_lt")
    s.box(1.64, 2.09, 2.36, 2.51, 5 + 53, 5 + 58, "leaf")
    s.dither([(1.64, 2.51, 5 + 58), (2.36, 2.51, 5 + 58), (2.36, 2.51, 5 + 48),
              (1.64, 2.51, 5 + 48)], "leaf_hi", 0.20, 58)
    # bench under the arbour
    s.box(1.72, 2.26, 2.28, 2.40, 5, 5 + 10, "wood")
    s.box(1.72, 2.36, 2.28, 2.42, 5 + 10, 5 + 22, "wood_dk")

    # Two soft lanterns. A garden is lit, not floodlit.
    lantern_post(s, 0.55, 2.0, 32, "amber", 24, 70)
    lantern_post(s, 3.45, 2.0, 32, "amber", 24, 70)
    # flowers
    rnd = random.Random(58)
    for _ in range(16):
        fx, fy = rnd.uniform(0.5, 3.5), rnd.uniform(0.5, 3.5)
        if 1.5 < fx < 2.5:
            continue
        s.box(fx, fy, fx + 0.08, fy + 0.08, 5, 5 + 5,
              rnd.choice(["amber_lt", "private", "violet_lt", "leaf_hi"]))
    return s.save(path)


def build_board(path):
    """BOARD -- a great notice board: pinned papers under a lantern, on posts."""
    s = civic(150)
    s.shadow(0, 0, 4, 4, 80)
    paved_base(s, 4, 4, 8, "stone_dk", 0.02, seed=61)
    s.box(0.4, 0.4, 3.6, 3.6, 8, 13, "stone")

    # Two heavy posts and a wide board facing the viewer.
    s.post(0.5, 2.9, 13, 13 + 108, 0.14, "wood")
    s.post(3.5, 2.9, 13, 13 + 108, 0.14, "wood")
    s.box(0.45, 2.82, 3.55, 3.0, 13 + 34, 13 + 104, "wood_dk",
          right=shade("wood_dk", 1.2), left=shade("wood_dk", 1.35))
    # the board face
    s.poly([(0.52, 3.01, 13 + 38), (3.48, 3.01, 13 + 38),
            (3.48, 3.01, 13 + 100), (0.52, 3.01, 13 + 100)], "wood_hi", "ink")
    s.poly([(0.6, 3.02, 13 + 42), (3.4, 3.02, 13 + 42),
            (3.4, 3.02, 13 + 96), (0.6, 3.02, 13 + 96)], shade("wood_dk", 1.1), "ink")
    # pinned notices, deliberately uneven
    rnd = random.Random(62)
    for i in range(9):
        px = 0.68 + (i % 5) * 0.56 + rnd.uniform(-0.03, 0.03)
        pz = 13 + 48 + (i // 5) * 26 + rnd.uniform(-2, 2)
        w, hh = rnd.uniform(0.28, 0.40), rnd.uniform(16, 22)
        col = rnd.choice(["paper", "paper", "paper_dk", "amber_lt", "violet_lt"])
        s.poly([(px, 3.03, pz), (px + w, 3.03, pz), (px + w, 3.03, pz + hh),
                (px, 3.03, pz + hh)], col, "ink")
        for ln in range(3):
            s.line((px + 0.04, 3.04, pz + hh - 4 - ln * 5),
                   (px + w - 0.06, 3.04, pz + hh - 4 - ln * 5), "stone_dk", 1)
        s.box(px + w / 2 - 0.02, 3.03, px + w / 2 + 0.02, 3.05, pz + hh - 2, pz + hh + 1,
              "private")
    # Pent roof over the board, keeping the notices dry. Given real thickness:
    # as a single polygon it read as a stray diagonal line.
    s.poly([(0.30, 2.68, 13 + 104), (3.70, 2.68, 13 + 104),
            (3.70, 3.18, 13 + 122), (0.30, 3.18, 13 + 122)],
           shade("metal_dk", 1.5), "ink")
    for i in range(7):
        t = (i + 1) / 8
        s.line((0.30, 2.68 + 0.5 * t, 13 + 104 + 18 * t),
               (3.70, 2.68 + 0.5 * t, 13 + 104 + 18 * t), shade("metal_dk", 1.15), 1)
    # front fascia + back ridge, so the roof has depth
    s.poly([(0.30, 3.18, 13 + 122), (3.70, 3.18, 13 + 122),
            (3.70, 3.18, 13 + 115), (0.30, 3.18, 13 + 115)], "metal", "ink")
    s.poly([(0.30, 2.68, 13 + 110), (3.70, 2.68, 13 + 110),
            (3.70, 2.68, 13 + 104), (0.30, 2.68, 13 + 104)], "metal_dk", "ink")
    # lantern hung under the roof, lighting the notices
    s.box(1.9, 2.9, 2.1, 3.1, 13 + 100, 13 + 112, "amber_lt", right="amber",
          left="amber_dk")
    s.glow(2.0, 3.0, 13 + 106, 78, "amber", 105)

    # A standing rail of smaller boards behind, plus a bin of scrolls.
    s.post(0.9, 1.1, 13, 13 + 46, 0.08, "wood")
    s.post(2.1, 1.1, 13, 13 + 46, 0.08, "wood")
    s.poly([(0.9, 1.14, 13 + 18), (2.1, 1.14, 13 + 18),
            (2.1, 1.14, 13 + 44), (0.9, 1.14, 13 + 44)], "wood_hi", "ink")
    for i in range(3):
        s.poly([(1.0 + i * 0.36, 1.15, 13 + 22), (1.26 + i * 0.36, 1.15, 13 + 22),
                (1.26 + i * 0.36, 1.15, 13 + 40), (1.0 + i * 0.36, 1.15, 13 + 40)],
               "paper", "ink")
    s.box(2.8, 1.3, 3.2, 1.7, 13, 13 + 18, "wood_dk")
    for i in range(4):
        s.post(2.88 + (i % 2) * 0.16, 1.38 + (i // 2) * 0.16, 13 + 18, 13 + 34, 0.05,
               "paper_dk")
    lantern_post(s, 3.5, 0.5, 40, "amber", 26, 86)
    return s.save(path)


# ==========================================================================
# 3. CONSTRUCTION SCAFFOLD  (3x3, same anchor as the access buildings)
# ==========================================================================
def build_scaffold(stage, path):
    s = Sprite(ACCESS_FW, ACCESS_FH, ACCESS_HZ, pad=10)
    s.shadow(0, 0, 3, 3, 60 + stage * 14)
    # churned ground + a staked-out outline: every stage starts here
    s.box(0.02, 0.02, 2.98, 2.98, 0, 5, shade("wood_dk", 1.1))
    s.dither([(0.02, 0.02, 5), (2.98, 0.02, 5), (2.98, 2.98, 5), (0.02, 2.98, 5)],
             "wood", 0.16, 70 + stage)
    for (cx, cy) in [(0.2, 0.2), (2.8, 0.2), (0.2, 2.8), (2.8, 2.8)]:
        s.post(cx, cy, 5, 5 + 22, 0.05, "wood_lt")
    # string line between the stakes
    for (a, b) in [((0.2, 0.2), (2.8, 0.2)), ((2.8, 0.2), (2.8, 2.8)),
                   ((2.8, 2.8), (0.2, 2.8)), ((0.2, 2.8), (0.2, 0.2))]:
        s.line((a[0], a[1], 5 + 20), (b[0], b[1], 5 + 20), "rope", 1)
    # materials on site
    s.box(0.3, 2.3, 0.9, 2.85, 5, 5 + 14, "stone_lt")
    s.box(0.36, 2.36, 0.84, 2.79, 5 + 14, 5 + 24, "stone")
    s.box(2.1, 0.25, 2.75, 0.6, 5, 5 + 10, "wood_hi")
    s.box(2.1, 0.25, 2.75, 0.6, 5 + 10, 5 + 19, "wood_lt")

    if stage >= 2:
        # timber frame going up + one scaffold lift + a ladder
        FR = 58
        for (cx, cy) in [(0.5, 0.5), (2.5, 0.5), (0.5, 2.5), (2.5, 2.5),
                         (1.5, 0.5), (0.5, 1.5)]:
            s.post(cx, cy, 5, 5 + FR, 0.09, "wood")
        s.box(0.42, 0.42, 2.58, 0.58, 5 + FR, 5 + FR + 8, "wood_lt")
        s.box(0.42, 0.42, 0.58, 2.58, 5 + FR, 5 + FR + 8, shade("wood_lt", 0.9))
        s.box(2.42, 0.42, 2.58, 2.58, 5 + FR, 5 + FR + 8, shade("wood_lt", 1.08))
        # part-built wall
        s.box(0.55, 0.55, 2.45, 0.72, 5, 5 + 30, "stone")
        s.dither([(0.55, 0.72, 5 + 30), (2.45, 0.72, 5 + 30), (2.45, 0.72, 5),
                  (0.55, 0.72, 5)], "stone_lt", 0.14, 74)
        # scaffold poles + a plank walkway on the viewer side
        for px in [0.35, 1.15, 1.95, 2.75]:
            s.post(px, 2.78, 5, 5 + 44, 0.045, "metal")
        s.box(0.3, 2.7, 2.8, 2.86, 5 + 38, 5 + 44, "wood_hi")
        s.line((0.35, 2.78, 5 + 20), (2.75, 2.78, 5 + 20), "metal_lt", 1)
        # ladder
        s.post(2.55, 2.62, 5, 5 + 52, 0.035, "wood_lt")
        s.post(2.78, 2.62, 5, 5 + 52, 0.035, "wood_lt")
        for i in range(6):
            s.line((2.55, 2.62, 5 + 8 + i * 8), (2.78, 2.62, 5 + 8 + i * 8), "wood_lt", 1)

    if stage >= 3:
        # walls up, roof trusses on, tarp wrap, hoist arm, a working lamp
        s.box(0.5, 0.5, 2.5, 2.5, 5, 5 + 70, "stone_dk",
              right=shade("stone_dk", 1.15), left=shade("stone_dk", 0.92))
        s.dither([(0.5, 2.5, 5 + 70), (2.5, 2.5, 5 + 70), (2.5, 2.5, 5),
                  (0.5, 2.5, 5)], "stone", 0.09, 76)
        # trusses
        for i in range(4):
            xx = 0.55 + i * 0.63
            s.line((xx, 0.5, 5 + 70), (xx, 1.5, 5 + 96), "wood_lt", 2)
            s.line((xx, 2.5, 5 + 70), (xx, 1.5, 5 + 96), "wood_lt", 2)
        s.line((0.55, 1.5, 5 + 96), (2.44, 1.5, 5 + 96), "wood_hi", 2)
        # tarp over half the frame
        s.poly([(0.45, 2.55, 5 + 74), (1.6, 2.55, 5 + 74),
                (1.55, 2.55, 5 + 18), (0.42, 2.55, 5 + 24)], "cloth", "ink")
        s.dither([(0.45, 2.55, 5 + 74), (1.6, 2.55, 5 + 74), (1.55, 2.55, 5 + 18),
                  (0.42, 2.55, 5 + 24)], "cloth_lt", 0.12, 77)
        # scaffold all the way up the front
        for px in [0.35, 1.15, 1.95, 2.75]:
            s.post(px, 2.78, 5, 5 + 92, 0.045, "metal")
        s.box(0.3, 2.7, 2.8, 2.86, 5 + 78, 5 + 84, "wood_hi")
        s.box(0.3, 2.7, 2.8, 2.86, 5 + 38, 5 + 44, "wood_hi")
        # hoist arm with a hanging block
        s.post(2.78, 0.4, 5, 5 + 104, 0.06, "metal_dk")
        s.line((2.78, 0.4, 5 + 104), (2.78, 1.5, 5 + 104), "metal_dk", 3)
        s.line((2.78, 1.5, 5 + 104), (2.78, 1.5, 5 + 62), "rope", 1)
        s.box(2.68, 1.4, 2.88, 1.6, 5 + 50, 5 + 62, "wood_hi")
        # work lamp: somebody is on site tonight
        s.box(1.4, 2.82, 1.6, 2.96, 5 + 84, 5 + 94, "amber_lt", right="amber",
              left="amber_dk")
        s.glow(1.5, 2.9, 5 + 89, 58, "amber", 100)

    if stage == 1:
        # a lone work lamp on a stake, so an empty site still reads as active
        s.box(1.4, 0.9, 1.6, 1.1, 5 + 18, 5 + 28, "amber", right="amber_dk",
              left="amber_dk")
        s.post(1.5, 1.0, 5, 5 + 18, 0.04, "metal_dk")
        s.glow(1.5, 1.0, 5 + 24, 40, "amber", 78)
    return s.save(path)


# ==========================================================================
# 4. GROUND TILES  -- paths (16-way), scatter overlays
# ==========================================================================
DIRS = ["n", "e", "s", "w"]
# tile-north = ty-1 (screen up-right); tile-east = tx+1 (down-right);
# tile-south = ty+1 (down-left); tile-west = tx-1 (up-left)
DIR_VEC = {"n": (0, -1), "e": (1, 0), "s": (0, 1), "w": (-1, 0)}


def tile_sprite():
    return Sprite(1, 1, 0, pad=0)


def _diamond_mask(s, x0, y0, x1, y1):
    return [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)]


GROUND_SPEC = {
    # kind: (base, mid, light, pattern)
    "plaza":    ("stone_dk", "stone", "stone_lt", "slab"),
    "library":  (mix("stone_dk", "violet_dk", 0.35), mix("stone", "violet_dk", 0.30),
                 "stone_lt", "slab"),
    "workshop": ("wood_dk", "wood", "wood_lt", "plank"),
    "stage":    (mix("wood_dk", "violet_dk", 0.55), mix("wood", "violet_dk", 0.45),
                 "stone_lt", "plank"),
    "garden":   ("leaf_dk", "leaf", "leaf_lt", "grass"),
    "board":    (mix("stone_dk", "void", 0.30), mix("stone", "void", 0.20),
                 "stone_lt", "flag"),
    "wild":     (mix("leaf_dk", "void", 0.30), mix("leaf", "void", 0.15),
                 "leaf_lt", "grass"),
}


def build_ground(kind, path):
    """A calm 2:1 ground tile, already the right shape for the diamond.

    The legacy tiles/*.png are 64x64 photographic-ish noise squashed to 64x32 by
    the renderer; at 0.4x a whole region of them reads as scree and swallows
    everything standing on it. These are drawn at 64x32 so nothing is squashed,
    and deliberately low-contrast so repetition never turns into a pattern."""
    base, midc, lite, pattern = GROUND_SPEC[kind]
    s = tile_sprite()
    rnd = random.Random(900 + sum(ord(c) for c in kind))
    s.poly(_diamond_mask(s, 0, 0, 1, 1), base)
    s.poly(_diamond_mask(s, 0.02, 0.02, 0.98, 0.98), midc)

    if pattern in ("slab", "flag"):
        # Four sub-diamonds with a hairline groove between them. Anchored to the
        # tile's own edges, so it joins its neighbours without seams.
        for (a, b) in [(0, 0), (0.5, 0), (0, 0.5), (0.5, 0.5)]:
            tone = rnd.choice([midc, midc, shade(midc, 1.10), shade(midc, 0.92)])
            s.poly(_diamond_mask(s, a + 0.035, b + 0.035, a + 0.465, b + 0.465), tone)
        s.dither(_diamond_mask(s, 0.05, 0.05, 0.95, 0.95), lite, 0.035, 901)
        if pattern == "flag":
            for _ in range(2):
                x, y = rnd.uniform(0.15, 0.7), rnd.uniform(0.15, 0.7)
                s.line((x, y, 0), (x + 0.18, y + 0.1, 0), shade(base, 0.7), 1)
    elif pattern == "plank":
        for i in range(5):
            a = 0.04 + i * 0.19
            tone = shade(midc, [0.94, 1.06, 0.98, 1.10, 1.0][i])
            s.poly(_diamond_mask(s, a, 0.03, a + 0.16, 0.97), tone)
            s.line((a + 0.165, 0.03, 0), (a + 0.165, 0.97, 0), shade(base, 0.85), 1)
        s.dither(_diamond_mask(s, 0.05, 0.05, 0.95, 0.95), lite, 0.04, 902)
    else:  # grass
        s.dither(_diamond_mask(s, 0.02, 0.02, 0.98, 0.98), shade(midc, 1.18), 0.16, 903)
        s.dither(_diamond_mask(s, 0.02, 0.02, 0.98, 0.98), shade(base, 1.05), 0.10, 904)
        for _ in range(7):
            x, y = rnd.uniform(0.1, 0.85), rnd.uniform(0.1, 0.85)
            s.line((x, y, 0), (x + 0.05, y + 0.05, 3), shade(lite, 0.8), 1)
    return s.save(path)


def build_path(mask, path):
    """A paved path tile. `mask` is the set of connected tile directions.

    The stone runs from the tile centre out to each connected edge, so any
    combination of neighbours joins seamlessly. 16 tiles cover every case."""
    s = tile_sprite()
    seed = 100 + sum(1 << i for i, d in enumerate(DIRS) if d in mask)
    C = 0.5
    HALF = 0.20   # half-width of the carriageway, in tile units
    KERB = 0.045  # the darker lip that keeps the road's edge crisp

    def arm(d):
        dx, dy = DIR_VEC[d]
        if dx:
            x0, x1 = (C, 1.0) if dx > 0 else (0.0, C)
            return (x0, C - HALF, x1, C + HALF)
        y0, y1 = (C, 1.0) if dy > 0 else (0.0, C)
        return (C - HALF, y0, C + HALF, y1)

    quads = [(C - HALF, C - HALF, C + HALF, C + HALF)]
    for d in mask:
        quads.append(arm(d))

    # kerb first (darker + slightly wider), carriageway on top -> a crisp edge
    for (a, b, c, dd) in quads:
        s.poly(_diamond_mask(s, a - KERB, b - KERB, c + KERB, dd + KERB), "road_dk")
    for (a, b, c, dd) in quads:
        s.poly(_diamond_mask(s, a, b, c, dd), "road")
    # A couple of laid slabs rather than random grit: a road should be calm at
    # 0.4x, and speckle at that size turns a whole street into noise.
    rnd = random.Random(seed)
    for (a, b, c, dd) in quads:
        span_x, span_y = c - a, dd - b
        n = 3 if max(span_x, span_y) > 0.45 else 2
        for i in range(n):
            t0 = i / n
            t1 = (i + 0.72) / n
            if span_x >= span_y:
                sa, sb = a + span_x * t0, b + span_y * 0.18
                sc, sd = a + span_x * t1, dd - span_y * 0.18
            else:
                sa, sb = a + span_x * 0.18, b + span_y * t0
                sc, sd = c - span_x * 0.18, b + span_y * t1
            s.poly(_diamond_mask(s, sa, sb, sc, sd),
                   "road_warm" if rnd.random() < 0.3 else "road_lt")
    for i, (a, b, c, dd) in enumerate(quads):
        s.dither(_diamond_mask(s, a, b, c, dd), "road_lt", 0.05, seed + i)
    return s.save(path)


def build_scatter(kind, path):
    """Transparent overlay tiles, drawn on top of a region tile for variety."""
    s = tile_sprite()
    rnd = random.Random({"pebbles": 201, "tuft": 202, "flowers": 203,
                         "crack": 204, "puddle": 205, "leaves": 206}[kind])

    def spot(x, y, w, h, c):
        s.poly(_diamond_mask(s, x, y, x + w, y + h), c)

    if kind == "pebbles":
        for _ in range(14):
            x, y = rnd.uniform(0.1, 0.85), rnd.uniform(0.1, 0.85)
            spot(x, y, 0.07, 0.07, rnd.choice(["stone_lt", "stone", "stone_hi"]))
    elif kind == "tuft":
        for _ in range(7):
            x, y = rnd.uniform(0.15, 0.8), rnd.uniform(0.15, 0.8)
            spot(x, y, 0.1, 0.1, "leaf")
            spot(x + 0.02, y + 0.02, 0.05, 0.05, "leaf_lt")
    elif kind == "flowers":
        for _ in range(9):
            x, y = rnd.uniform(0.15, 0.8), rnd.uniform(0.15, 0.8)
            spot(x, y, 0.08, 0.08, "leaf_lt")
            spot(x + 0.025, y + 0.025, 0.035, 0.035,
                 rnd.choice(["amber_lt", "private", "violet_lt", "paper"]))
    elif kind == "crack":
        px, py = 0.15, 0.3
        for _ in range(9):
            nx, ny = px + rnd.uniform(0.03, 0.12), py + rnd.uniform(-0.06, 0.1)
            nx, ny = min(nx, 0.9), min(max(ny, 0.08), 0.9)
            s.line((px, py, 0), (nx, ny, 0), "void", 1)
            px, py = nx, ny
    elif kind == "puddle":
        spot(0.25, 0.3, 0.42, 0.34, "water")
        spot(0.31, 0.36, 0.28, 0.2, "water_lt")
        spot(0.38, 0.42, 0.1, 0.06, "amber_dk")
    elif kind == "leaves":
        for _ in range(11):
            x, y = rnd.uniform(0.1, 0.85), rnd.uniform(0.1, 0.85)
            spot(x, y, 0.09, 0.06, rnd.choice(["amber_dk", "wood_lt", "leaf_lt"]))
    return s.save(path)


# ==========================================================================
# 5. PROPS  (1x1 footprint)
# ==========================================================================
def prop(hz, pad=6):
    return Sprite(1, 1, hz, pad=pad)


def build_prop_lantern(path):
    s = prop(56)
    s.shadow(0.3, 0.3, 0.7, 0.7, 70)
    s.box(0.34, 0.34, 0.66, 0.66, 0, 5, "stone_dk")
    s.box(0.40, 0.40, 0.60, 0.60, 5, 9, "metal_dk")
    s.post(0.5, 0.5, 9, 38, 0.055, "metal_dk")
    s.box(0.39, 0.39, 0.61, 0.61, 38, 50, "amber_lt", right="amber", left="amber_dk")
    s.line((0.5, 0.39, 41), (0.5, 0.39, 47), "amber_glow", 1)
    s.box(0.36, 0.36, 0.64, 0.64, 50, 54, "metal_dk")
    s.box(0.46, 0.46, 0.54, 0.54, 54, 56, "metal_dk")
    s.glow(0.5, 0.5, 45, 26, "amber", 105)
    s.glow(0.5, 0.5, 4, 24, "amber", 38)
    return s.save(path)


def build_prop_bench(path):
    s = prop(30)
    s.shadow(0.08, 0.25, 0.92, 0.75, 70)
    for bx in (0.2, 0.8):
        s.box(bx - 0.06, 0.32, bx + 0.06, 0.68, 0, 12, "wood_dk")
    s.box(0.1, 0.3, 0.9, 0.7, 12, 17, "wood_lt", right=shade("wood_lt", 0.76),
          left=shade("wood_lt", 0.55))
    s.box(0.1, 0.62, 0.9, 0.7, 17, 30, "wood",
          right=shade("wood", 0.8), left=shade("wood", 1.08))
    for i in range(5):
        s.line((0.14 + i * 0.18, 0.3, 18), (0.14 + i * 0.18, 0.7, 18),
               shade("wood_lt", 0.7), 1)
    return s.save(path)


def build_prop_planter(path):
    s = prop(46)
    s.shadow(0.2, 0.2, 0.8, 0.8, 70)
    s.box(0.22, 0.22, 0.78, 0.78, 0, 16, "wood", right=shade("wood", 1.15),
          left=shade("wood", 0.88))
    s.box(0.2, 0.2, 0.8, 0.8, 16, 19, "wood_lt")
    s.box(0.26, 0.26, 0.74, 0.74, 19, 21, "leaf_dk")
    s.box(0.26, 0.26, 0.74, 0.74, 21, 38, shade("leaf", 1.15),
          right=shade("leaf", 0.95), left=shade("leaf", 0.7))
    s.dither([(0.26, 0.74, 38), (0.74, 0.74, 38), (0.74, 0.74, 21), (0.26, 0.74, 21)],
             "leaf_hi", 0.18, 301)
    rnd = random.Random(302)
    for _ in range(5):
        fx, fy = rnd.uniform(0.3, 0.68), rnd.uniform(0.3, 0.68)
        s.box(fx, fy, fx + 0.07, fy + 0.07, 38, 44,
              rnd.choice(["amber_lt", "private", "violet_lt"]))
    return s.save(path)


def build_prop_crates(path):
    s = prop(44)
    s.shadow(0.1, 0.1, 0.9, 0.9, 70)
    s.box(0.12, 0.45, 0.55, 0.9, 0, 20, "wood_hi", right=shade("wood_hi", 0.78),
          left=shade("wood_hi", 0.56))
    s.box(0.5, 0.12, 0.92, 0.55, 0, 24, "wood_lt", right=shade("wood_lt", 0.78),
          left=shade("wood_lt", 0.56))
    s.box(0.2, 0.5, 0.55, 0.85, 20, 40, "wood_lt", right=shade("wood_lt", 0.78),
          left=shade("wood_lt", 0.56))
    for (a, b, c, d, z) in [(0.12, 0.45, 0.55, 0.9, 20), (0.5, 0.12, 0.92, 0.55, 24),
                            (0.2, 0.5, 0.55, 0.85, 40)]:
        s.line((a, d, z), (c, d, z - 12), "wood_dk", 1)
        s.line((a, d, z - 12), (c, d, z), "wood_dk", 1)
    return s.save(path)


def build_prop_signpost(path):
    s = prop(58)
    s.shadow(0.38, 0.38, 0.62, 0.62, 60)
    s.post(0.5, 0.5, 0, 50, 0.05, "wood")
    # two arms pointing opposite ways -- says "there is somewhere else to go"
    s.poly([(0.5, 0.52, 44), (1.05, 0.52, 44), (1.05, 0.52, 34), (0.5, 0.52, 34)],
           "wood_lt", "ink")
    s.poly([(-0.05, 0.48, 30), (0.5, 0.48, 30), (0.5, 0.48, 20), (-0.05, 0.48, 20)],
           "wood", "ink")
    s.line((0.62, 0.53, 39), (0.95, 0.53, 39), "amber", 1)
    s.line((0.05, 0.49, 25), (0.4, 0.49, 25), "amber_dk", 1)
    s.box(0.44, 0.44, 0.56, 0.56, 50, 56, "amber")
    s.glow(0.5, 0.5, 53, 26, "amber", 85)
    return s.save(path)


def build_prop_brazier(path):
    s = prop(52)
    s.shadow(0.28, 0.28, 0.72, 0.72, 75)
    for (lx, ly) in [(0.32, 0.32), (0.68, 0.32), (0.32, 0.68), (0.68, 0.68)]:
        s.line((0.5, 0.5, 26), (lx, ly, 0), "metal_dk", 2)
    s.box(0.3, 0.3, 0.7, 0.7, 26, 36, "metal", right=shade("metal", 0.76),
          left=shade("metal", 0.54))
    s.diamond(0.34, 0.34, 0.66, 0.66, 36, "amber")
    s.box(0.4, 0.4, 0.6, 0.6, 36, 46, "amber_lt")
    s.box(0.45, 0.45, 0.55, 0.55, 46, 52, "amber_glow")
    s.glow(0.5, 0.5, 44, 54, "amber", 130)
    s.glow(0.5, 0.5, 6, 40, "amber", 50)
    return s.save(path)


def build_prop_wellstone(path):
    """A low ring of stone with water -- somewhere for bodies to gather round."""
    s = prop(34)
    s.shadow(0.12, 0.12, 0.88, 0.88, 80)
    s.box(0.14, 0.14, 0.86, 0.86, 0, 16, "stone_lt", right=shade("stone_lt", 0.76),
          left=shade("stone_lt", 0.54))
    s.diamond(0.22, 0.22, 0.78, 0.78, 16, "water")
    s.diamond(0.3, 0.3, 0.7, 0.7, 16, "water_lt")
    s.dither([(0.14, 0.86, 16), (0.86, 0.86, 16), (0.86, 0.86, 0), (0.14, 0.86, 0)],
             "stone_hi", 0.10, 303)
    s.glow(0.5, 0.5, 18, 24, "water_lt", 40)
    return s.save(path)


def build_prop_rubble(path):
    s = prop(30)
    rnd = random.Random(304)
    s.shadow(0.06, 0.06, 0.94, 0.94, 70)
    s.diamond(0.08, 0.08, 0.92, 0.92, 2, shade("stone_dk", 0.8))
    lumps = [(0.10, 0.22, 0.30, 12), (0.34, 0.08, 0.26, 20), (0.58, 0.30, 0.30, 15),
             (0.22, 0.56, 0.28, 9), (0.52, 0.62, 0.24, 18), (0.12, 0.10, 0.18, 6)]
    for i, (x, y, w, h) in enumerate(lumps):
        col = ["stone_lt", "stone", "stone_dk", "stone_hi"][i % 4]
        s.box(x, y, x + w, y + w, 0, h, col)
    s.dither([(0.08, 0.92, 6), (0.92, 0.92, 6), (0.92, 0.92, 0), (0.08, 0.92, 0)],
             "stone_hi", 0.12, 305)
    return s.save(path)


# ==========================================================================
# 6. ANIMALS  -- 64x64, drawn through the same path as chars/*.png
# ==========================================================================
def sheep_frame(path, pose):
    """A sheep: the idle local model, grazing where nothing needs it.

    64x64 so it drops straight into the existing character draw call
    (drawImage(img, x-20, y-20, 40, 40)). Faces the viewer's RIGHT; flip
    in-engine for left, exactly like the human/agent side sprites."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def R(x0, y0, x1, y1, c):
        d.rectangle([x0, y0, x1, y1], fill=rgba(c))

    # GROUND = 62. The existing chars/*.png put the feet on the very bottom of
    # the 64px frame, because the renderer squashes 64x64 into a 40x40 box whose
    # bottom edge is the standing point. Match that or the flock floats.
    GROUND = 62
    lift = {"graze": 0, "idle": 0, "walk_a": 1, "walk_b": 0}[pose]
    TOP = 34 - lift          # top of the fleece
    BOT = 52 - lift          # belly line

    d.ellipse([14, GROUND - 6, 50, GROUND + 1], fill=(3, 4, 12, 95))

    # --- legs -------------------------------------------------------------
    legs = {
        "graze":  [(21, 0), (27, 0), (37, 0), (43, 0)],
        "idle":   [(21, 0), (27, 0), (37, 0), (43, 0)],
        "walk_a": [(18, 0), (29, 3), (35, 3), (45, 0)],
        "walk_b": [(23, 3), (26, 0), (39, 0), (42, 3)],
    }[pose]
    for (lx, short) in legs:
        R(lx, BOT - 2, lx + 2, GROUND - short, "wool_sh")
        R(lx, GROUND - 2 - short, lx + 2, GROUND - short, "ink")

    # --- fleece: three overlapping lumps, never one slab -------------------
    lumps = [(17, TOP + 4, 31, BOT), (24, TOP, 40, BOT), (33, TOP + 3, 45, BOT - 1)]
    for (a, b, c, e) in lumps:
        R(a, b, c, e, "wool_dk")
    for (a, b, c, e) in lumps:
        R(a + 1, b + 1, c - 1, e - 2, "wool")
    # bumpy crown and a bumpy rump, so the silhouette is never a rectangle
    for bx in range(18, 45, 4):
        top = TOP + (2 if bx < 24 or bx > 40 else 0)
        R(bx, top - 2, bx + 3, top + 2, "wool")
        R(bx + 1, top - 3, bx + 2, top - 1, "wool_dk")
    R(16, TOP + 8, 19, BOT - 4, "wool")            # rump / tail lump
    R(15, TOP + 12, 17, TOP + 18, "wool_dk")       # tail
    # belly in shadow, a couple of lit pixels on the crown
    R(18, BOT - 3, 44, BOT - 1, "wool_sh")
    for bx in (21, 29, 37):
        R(bx, TOP - 3, bx + 1, TOP - 2, "amber_lt")

    # --- head: dark, so it separates from the fleece at any size -----------
    hdrop = {"graze": 11, "idle": 0, "walk_a": 2, "walk_b": 0}[pose]
    hx, hy = 43, TOP + 5 + hdrop
    R(hx + 2, hy - 3, hx + 6, hy + 1, "wool")            # fleece cap over the poll
    R(hx, hy, hx + 8, hy + 8, "ink")                     # head silhouette
    R(hx + 1, hy + 1, hx + 7, hy + 7, "wool_sh")         # face
    R(hx + 4, hy + 3, hx + 8, hy + 7, "stone_dk")        # muzzle
    R(hx + 7, hy + 4, hx + 8, hy + 5, "ink")             # nostril
    R(hx + 2, hy + 2, hx + 3, hy + 3, "ink")             # eye
    R(hx + 2, hy + 2, hx + 2, hy + 2, "amber_lt")        # catchlight
    R(hx - 1, hy + 1, hx + 1, hy + 3, "wool_dk")         # ear
    R(hx - 1, hy + 1, hx - 1, hy + 1, "ink")

    if pose == "graze":
        for gx in range(46, 58, 3):
            d.line([gx, GROUND, gx + 1, GROUND - 6], fill=rgba("leaf_lt"))
            d.line([gx + 1, GROUND, gx + 2, GROUND - 4], fill=rgba("leaf"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)
    return {"w": 64, "h": 64, "anchor": [32, 62], "footprint": [1, 1],
            "drawLike": "chars"}


# ==========================================================================
# 7. CARRIED ITEMS  -- 24x24, anchored at the grip
# ==========================================================================
def item(path, draw_fn):
    img = Image.new("RGBA", (24, 24), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_fn(d, img)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)
    return {"w": 24, "h": 24, "anchor": [12, 12]}


def item_document(d, img):
    """A sheet of paper with ruled lines and a wax seal. Read/write/report."""
    d.polygon([(5, 3), (18, 3), (18, 21), (5, 21)], fill=rgba("paper"),
              outline=rgba("ink"))
    d.polygon([(5, 3), (18, 3), (18, 6), (5, 6)], fill=rgba("paper_dk"))
    for i in range(5):
        d.line([7, 8 + i * 2.4, 16, 8 + i * 2.4], fill=rgba("stone_dk"))
    d.rectangle([14, 16, 17, 19], fill=rgba("private"), outline=rgba("ink"))
    # a lit edge so it shows against a dark body
    d.line([5, 3, 5, 21], fill=rgba("amber_lt"))


def item_tool(d, img):
    """A claw hammer: making, building, fixing.

    An even T-bar read as a mallet or a sign. The offset head and the split
    claw are what make it read as a TOOL at 12px."""
    # handle, angled slightly so it is not a perfect cross
    d.polygon([(11, 9), (15, 9), (14, 22), (10, 22)], fill=rgba("wood"),
              outline=rgba("ink"))
    d.line([12, 11, 11, 21], fill=rgba("wood_hi"))
    # head: a heavy face on the right, a split claw on the left
    d.polygon([(12, 2), (20, 3), (20, 10), (12, 10)], fill=rgba("metal"),
              outline=rgba("ink"))
    d.line([14, 4, 19, 4], fill=rgba("metal_lt"))
    d.rectangle([18, 3, 20, 10], fill=rgba("metal_lt"), outline=rgba("ink"))
    d.polygon([(12, 3), (6, 2), (3, 6), (6, 6), (9, 5), (12, 6)], fill=rgba("metal_dk"),
              outline=rgba("ink"))
    d.line([5, 3, 8, 4], fill=rgba("metal")) 


def item_lamp(d, img):
    """A hand lantern: carrying light, or carrying attention."""
    d.line([12, 2, 12, 6], fill=rgba("metal_dk"))
    d.arc([7, 1, 17, 9], 180, 360, fill=rgba("metal_dk"))
    d.rectangle([8, 6, 16, 8], fill=rgba("metal_dk"), outline=rgba("ink"))
    d.rectangle([8, 8, 16, 17], fill=rgba("amber"), outline=rgba("ink"))
    d.rectangle([10, 10, 14, 15], fill=rgba("amber_glow"))
    d.rectangle([7, 17, 17, 20], fill=rgba("metal_dk"), outline=rgba("ink"))
    glow = Image.new("RGBA", (24, 24), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([2, 5, 22, 22], fill=rgba("amber", 46))
    img.alpha_composite(glow)


def item_seedling(d, img):
    """Something being planted -- a claim, a new space, a first message."""
    d.rectangle([7, 15, 17, 21], fill=rgba("wood"), outline=rgba("ink"))
    d.rectangle([8, 15, 16, 17], fill=rgba("wood_dk"))
    d.line([12, 15, 12, 7], fill=rgba("leaf_lt"))
    d.polygon([(12, 10), (6, 8), (12, 6)], fill=rgba("leaf_hi"), outline=rgba("ink"))
    d.polygon([(12, 12), (18, 10), (12, 8)], fill=rgba("leaf_lt"), outline=rgba("ink"))


# ==========================================================================
# BUILD
# ==========================================================================
def main():
    out = {}

    def rel(*p):
        return os.path.join(ART, *p)

    def web(*p):
        return "/art/" + "/".join(p)

    manifest_assets = {"buildings": {}, "civic": {}, "scaffold": {},
                       "ground": {}, "paths": {}, "scatter": {}, "props": {},
                       "animals": {}, "items": {}}

    # --- ground tiles -----------------------------------------------------
    for kind in GROUND_SPEC:
        meta = build_ground(kind, rel("tiles", "ground", f"{kind}.png"))
        meta.update({"file": web("tiles", "ground", f"{kind}.png"), "room": kind,
                     "replaces": f"/art/tiles/{kind}.png" if kind != "wild" else None,
                     "reads_as": "Calm 2:1 ground for this region. Draw unscaled at "
                                 "(x-32, y); the legacy 64x64 tile is squashed and noisy."})
        manifest_assets["ground"][kind] = meta

    # --- access buildings -------------------------------------------------
    for name, fn, blurb in [
        ("private", build_private,
         "Closed compound: unbroken wall, crenellations, a shut gate barred in pink. "
         "Nothing shows through the silhouette -- there is no way in and the shape says so."),
        ("public_view", build_public_view,
         "Colonnade: a roof on columns with lit gaps between them and an unbroken blue "
         "rail across the front. You can see the whole interior and cannot walk into it."),
        ("public_write", build_public_write,
         "Open pavilion: four posts, an amber canopy, no walls at all, broad steps on "
         "both viewer-facing sides. Ground shows under the roof -- walk straight in."),
    ]:
        meta = fn(rel("buildings", f"{name}.png"))
        meta.update({"file": web("buildings", f"{name}.png"), "access": name,
                     "reads_as": blurb})
        manifest_assets["buildings"][name] = meta

    # --- civic ------------------------------------------------------------
    for name, fn, blurb in [
        ("plaza", build_plaza, "Fountain, ringed paving, four lanterns, benches. The meeting ground."),
        ("library", build_library, "Tall gabled hall, two rows of warm windows, an arched door with books inside, a lit cupola."),
        ("workshop", build_workshop, "Open-fronted shed: forge mouth glowing, smoking chimney, anvil, tool rack, crates."),
        ("stage", build_stage, "Raised deck, proscenium piers, drawn violet curtains, a row of footlights."),
        ("garden", build_garden, "No building: hedge, three trees, a pond, a trellis arbour over a bench. Quiet."),
        ("board", build_board, "Wide notice board on posts, pinned papers under a hung lantern, a scroll bin."),
    ]:
        meta = fn(rel("civic", f"{name}.png"))
        meta.update({"file": web("civic", f"{name}.png"), "room": name, "reads_as": blurb})
        manifest_assets["civic"][name] = meta

    # --- scaffold ---------------------------------------------------------
    for stage, blurb in [
        (1, "Staked out: corner stakes, string lines, a pallet of stone and a stack of timber, one work lamp."),
        (2, "Framed: timber posts and a head plate, a part-built wall, scaffold poles, a plank lift and a ladder."),
        (3, "Topped out: walls up, roof trusses on, half the frame under a tarp, a hoist arm and a work lamp burning."),
    ]:
        meta = build_scaffold(stage, rel("scaffold", f"stage-{stage}.png"))
        meta.update({"file": web("scaffold", f"stage-{stage}.png"), "stage": stage,
                     "reads_as": blurb})
        manifest_assets["scaffold"][f"stage-{stage}"] = meta

    # --- paths ------------------------------------------------------------
    for bits in range(16):
        mask = [d for i, d in enumerate(DIRS) if bits & (1 << i)]
        key = "".join(mask) if mask else "o"
        meta = build_path(mask, rel("tiles", "paths", f"path-{key}.png"))
        meta.update({"file": web("tiles", "paths", f"path-{key}.png"),
                     "connects": mask,
                     "reads_as": "Paved path; arms run to each connected neighbour."})
        manifest_assets["paths"][key] = meta

    # --- scatter ----------------------------------------------------------
    for kind, blurb in [
        ("pebbles", "Loose stones. Breaks up a paved region."),
        ("tuft", "Grass tufts. Breaks up open ground."),
        ("flowers", "Small flowers. Garden and claimed-plot edges."),
        ("crack", "A hairline crack. Old paving."),
        ("puddle", "Standing water catching a lantern."),
        ("leaves", "Fallen leaves. Autumn edge of the garden."),
    ]:
        meta = build_scatter(kind, rel("tiles", "scatter", f"{kind}.png"))
        meta.update({"file": web("tiles", "scatter", f"{kind}.png"), "reads_as": blurb,
                     "overlay": True})
        manifest_assets["scatter"][kind] = meta

    # --- props ------------------------------------------------------------
    for name, fn, blurb in [
        ("lantern", build_prop_lantern, "Standing lantern. The campus light source; line them along paths."),
        ("bench", build_prop_bench, "Bench. Somewhere for a body to be idle that is not nowhere."),
        ("planter", build_prop_planter, "Planted box. Softens a paved edge."),
        ("crates", build_prop_crates, "Stacked crates. Workshop and construction edges."),
        ("signpost", build_prop_signpost, "Signpost. Marks a junction; says the world continues."),
        ("brazier", build_prop_brazier, "Lit brazier. A warm gathering point, brighter than a lantern."),
        ("wellstone", build_prop_wellstone, "Low water basin. A thing to stand around."),
        ("rubble", build_prop_rubble, "Loose stone. Construction sites and wild edges."),
    ]:
        meta = fn(rel("props", f"{name}.png"))
        meta.update({"file": web("props", f"{name}.png"), "reads_as": blurb})
        manifest_assets["props"][name] = meta

    # --- animals ----------------------------------------------------------
    for pose, blurb in [
        ("graze", "Head down, cropping grass. An idle local model with nothing to do."),
        ("idle", "Head up, standing. Idle but alert."),
        ("walk_a", "Walk frame A."),
        ("walk_b", "Walk frame B."),
    ]:
        meta = sheep_frame(rel("animals", f"sheep-{pose.replace('_','-')}.png"), pose)
        meta.update({"file": web("animals", f"sheep-{pose.replace('_','-')}.png"),
                     "reads_as": blurb, "faces": "right"})
        manifest_assets["animals"][f"sheep-{pose.replace('_','-')}"] = meta

    # --- items ------------------------------------------------------------
    for name, fn, blurb in [
        ("document", item_document, "A sealed sheet. Carried while reading, writing or reporting."),
        ("tool", item_tool, "A hammer. Carried while building or fixing."),
        ("lamp", item_lamp, "A hand lantern. Carried while searching or leading."),
        ("seedling", item_seedling, "A potted cutting. Carried while claiming or planting a new space."),
    ]:
        meta = item(rel("items", f"{name}.png"), fn)
        meta.update({"file": web("items", f"{name}.png"), "reads_as": blurb})
        manifest_assets["items"][name] = meta

    write_manifest(manifest_assets)
    total = sum(len(v) for v in manifest_assets.values())
    print(f"generated {total} assets into {ART}")
    return manifest_assets


def write_manifest(assets):
    manifest = {
        "$comment": "Generated by tools/generate_art.py. Edit the script, not this file.",
        "style": "original 16-bit dusk lantern campus, chunky outlines, limited palette",
        "geometry": {
            "tileWidth": 64,
            "tileHeight": 32,
            "note": "iso(tx,ty) is the diamond's NORTH VERTEX. Ground tiles draw at (x-32, y).",
        },
        "anchorConvention": {
            "rule": "Place the sprite's anchor pixel exactly on iso(tx,ty) of its north-most footprint tile.",
            "draw": "ctx.drawImage(img, ox + p.x - anchor[0], oy + p.y - anchor[1], w, h)",
            "derivation": "anchor = [fh*32 + pad, structureHeightPx + pad] for a fw x fh footprint",
            "sortKey": "Draw structures back-to-front by (tx + ty) of the SOUTH-most footprint tile.",
            "exceptions": {
                "animals": "64x64, drawn through the CHARACTER path unchanged: "
                           "drawImage(img, x-20, y-20, 40, 40) with y = iso.y - 18. "
                           "Feet sit on the bottom edge of the frame, like chars/*.png.",
                "items": "24x24. The anchor is the GRIP POINT, to be placed at a "
                         "body's hand -- not on a tile.",
            },
            "bodyOffset": "The renderer stands bodies on the tile's NORTH VERTEX "
                          "(feet-ellipse at iso.y) while a footprint covers the tile "
                          "diamond (iso.y .. iso.y+32). A body on tile T therefore "
                          "appears half a tile north of a prop on tile T.",
        },
        "palette": {k: "#%02x%02x%02x" % v for k, v in sorted(PAL.items())},
        # legacy keys, unchanged, so nothing already wired breaks
        "tileSize": 64,
        "spriteSize": 64,
        "tiles": {
            "plaza": "/art/tiles/plaza.png",
            "library": "/art/tiles/library.png",
            "workshop": "/art/tiles/workshop.png",
            "stage": "/art/tiles/stage.png",
            "garden": "/art/tiles/garden.png",
            "board": "/art/tiles/board.png",
        },
        "chars": {
            "human": {
                "idle": "/art/chars/human-front.png",
                "side": "/art/chars/human-side.png",
                "chatting": "/art/chars/human-speak.png",
            },
            "agent": {
                "idle": "/art/chars/agent-front.png",
                "side": "/art/chars/agent-side.png",
                "working": "/art/chars/agent-work.png",
            },
        },
        "ground": assets["ground"],
        "buildings": assets["buildings"],
        "civic": assets["civic"],
        "scaffold": assets["scaffold"],
        "paths": assets["paths"],
        "scatter": assets["scatter"],
        "props": assets["props"],
        "animals": assets["animals"],
        "items": assets["items"],
        "notes": [
            "All art is generated by tools/generate_art.py. No third-party sprite packs; "
            "no Metro City / LimeZu / Star Office / Pixel Agents assets.",
            "Side-facing sprites (chars, animals) face the viewer's RIGHT; flip in-engine for left.",
            "Legacy tiles/*.png are 64x64 squashed to 64x32 by the renderer. Everything new "
            "is already 2:1 and must be drawn at its declared pixel size, unscaled.",
            "Path tiles key on connected TILE directions: n = ty-1 (screen up-right), "
            "e = tx+1 (down-right), s = ty+1 (down-left), w = tx-1 (up-left).",
            "Animals are 64x64 to match chars/*.png and drop into the same draw call.",
        ],
    }
    with open(os.path.join(ART, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
