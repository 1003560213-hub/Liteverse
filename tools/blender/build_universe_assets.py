#!/usr/bin/env python3
"""Liteverse "Deep Universe" asset builder.

Builds ten galaxy archetypes and a deep-field background catalogue as 3D point
clouds, loads them into Blender as vertex-only meshes with custom attributes,
optionally renders Cycles previews, and exports the runtime `.lvpc` binaries
plus `manifest.json` *from the Blender mesh attributes* (the Blender scene is
the source of truth for the exported bytes).

Run either way (arguments after `--` are used when present):

    blender --background --factory-startup \
        --python tools/blender/build_universe_assets.py -- --seed 1729
    python tools/blender/build_universe_assets.py --seed 1729   # bpy module

See tools/blender/README.md for the physical model, the formulas, parameter
values and the exact binary layout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

import bpy  # noqa: E402  (Blender or the bpy wheel)

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
DEFAULT_OUT = REPO_ROOT / "public" / "universe"
DEFAULT_PREVIEWS = SCRIPT_PATH.parent / "previews"
DEFAULT_BLEND_DIR = SCRIPT_PATH.parent / "out"

SCHEMA_VERSION = "liteverse-universe-assets-v1"
DEFAULT_SEED = 1729
DEFAULT_POINTS = 40_000
MAGIC = b"LVPC"
FORMAT_VERSION = 1
HEADER_BYTES = 32
RECORD_DTYPE = np.dtype(
    [
        ("p", "<i2", (3,)),
        ("rgb", "u1", (3,)),
        ("size", "u1"),
        ("pop", "u1"),
        ("extra", "u1"),
    ]
)
assert RECORD_DTYPE.itemsize == 12

# Populations (u8 `population`).
POP_OLD, POP_DISK, POP_YOUNG, POP_HII, POP_DUST, POP_NUCLEUS = 0, 1, 2, 3, 4, 5
POP_DISTANT_GALAXY, POP_FOREGROUND_STAR = 6, 7
POP_NAMES = {
    0: "old",
    1: "disk",
    2: "young",
    3: "hii",
    4: "dust",
    5: "nucleus",
    6: "distantGalaxy",
    7: "foregroundStar",
}

# Structural component codes (u8 `extra`) for galaxy clouds.
C_DISK, C_BULGE, C_BAR, C_ARM, C_RING, C_TIDAL, C_COMPANION, C_HALO = range(8)

ARCHETYPES = [
    ("g01-grand-design-spiral", "Grand-design spiral", "SA(s)c grand-design spiral"),
    ("g02-barred-spiral", "Barred spiral", "SB(s)bc barred spiral"),
    ("g03-flocculent-spiral", "Flocculent spiral", "SA(rs)c flocculent spiral"),
    ("g04-elliptical", "Elliptical", "E3 triaxial elliptical"),
    ("g05-lenticular", "Lenticular", "S0 lenticular"),
    ("g06-ring", "Ring galaxy", "collisional ring galaxy"),
    ("g07-irregular-dwarf", "Irregular dwarf", "dIrr / Magellanic irregular"),
    ("g08-interacting-pair", "Interacting pair", "interacting spiral pair with tidal tail and bridge"),
    ("g09-starburst", "Starburst", "nuclear starburst with bipolar superwind"),
    ("g10-seyfert-spiral", "Seyfert spiral", "Seyfert 2 spiral with ionisation cone"),
]


# --------------------------------------------------------------------------
# Colour science (documented approximations)
# --------------------------------------------------------------------------

def _g(x, mu, s1, s2):
    s = np.where(x < mu, s1, s2)
    return np.exp(-0.5 * ((x - mu) / s) ** 2)


def cie_cmf(lam_nm):
    """Wyman, Sloan & Shirley (2013) multi-lobe fit of the CIE 1931 2° CMFs."""
    x = (1.056 * _g(lam_nm, 599.8, 37.9, 31.0) + 0.362 * _g(lam_nm, 442.0, 16.0, 26.7)
         - 0.065 * _g(lam_nm, 501.1, 20.4, 26.2))
    y = 0.821 * _g(lam_nm, 568.8, 46.9, 40.5) + 0.286 * _g(lam_nm, 530.9, 16.3, 31.1)
    z = 1.217 * _g(lam_nm, 437.0, 11.8, 36.0) + 0.681 * _g(lam_nm, 459.0, 26.0, 13.8)
    return x, y, z


XYZ_TO_LINEAR_SRGB = np.array(
    [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]
)


def xyz_to_chroma(xyz):
    """XYZ -> linear sRGB, pushed into gamut by adding white, max channel = 1."""
    rgb = xyz @ XYZ_TO_LINEAR_SRGB.T
    rgb = rgb - np.minimum(rgb.min(axis=-1, keepdims=True), 0.0)
    return rgb / rgb.max(axis=-1, keepdims=True)


_LAM = np.arange(380.0, 781.0, 1.0)
_CMF = np.stack(cie_cmf(_LAM), axis=-1)  # (401, 3)
_T_GRID = np.geomspace(1000.0, 40000.0, 1024)


def _planck_lut():
    h, c, k = 6.62607015e-34, 2.99792458e8, 1.380649e-23
    lam = _LAM[None, :] * 1e-9
    spec = lam ** -5 / np.expm1(h * c / (lam * k * _T_GRID[:, None]))
    return xyz_to_chroma(spec @ _CMF)


_BB_LUT = _planck_lut()


def blackbody_chroma(T):
    """Linear-sRGB chromaticity (max channel 1) of a Planckian radiator at T [K]."""
    t = np.log(np.clip(np.asarray(T, dtype=np.float64), 1000.0, 40000.0))
    lg = np.log(_T_GRID)
    return np.stack([np.interp(t, lg, _BB_LUT[:, i]) for i in range(3)], axis=-1)


def line_mix_chroma(lines):
    """Chroma of an emission-line spectrum [(lambda_nm, relative flux), ...]."""
    xyz = np.zeros(3)
    for lam, flux in lines:
        xyz += flux * np.array([float(v) for v in cie_cmf(np.array(lam))])
    return xyz_to_chroma(xyz[None, :])[0]


# Typical HII region (case-B Balmer decrement Hα/Hβ ≈ 2.86 plus forbidden lines)
# and a weak nebular/stellar blue continuum approximated by adding 15 % of a
# 20 000 K blackbody.
HII_LINES = [(656.3, 2.86), (658.4, 0.9), (671.7, 0.3), (673.1, 0.25),
             (486.1, 1.0), (434.0, 0.47), (500.7, 1.1), (495.9, 0.37), (372.7, 0.0)]
# Seyfert narrow-line region: [OIII] ≫ Hβ.
NLR_LINES = [(500.7, 10.0), (495.9, 3.3), (486.1, 1.0), (656.3, 2.9), (658.4, 2.5)]


def camera_rgb(lines):
    """Linear RGB of an emission-line spectrum seen through idealised top-hat
    broadband filters B = 400–500 nm, G = 500–600 nm, R = 600–700 nm.

    This mimics how HII regions appear in broadband/narrowband composites
    (Hubble/JWST press palettes, astrophotography): Hα lands in the red
    channel, so HII regions read as pink. Human-eye CIE colour of the same
    spectrum is pale violet-teal, which is *not* what people recognise.
    """
    rgb = np.zeros(3)
    for lam, flux in lines:
        if 600.0 <= lam < 700.0:
            rgb[0] += flux
        elif 500.0 <= lam < 600.0:
            rgb[1] += flux
        elif 400.0 <= lam < 500.0:
            rgb[2] += flux
    return rgb / rgb.max()


def hii_chroma():
    c = camera_rgb(HII_LINES) * 0.9 + blackbody_chroma(20000.0) * 0.1
    return c / c.max()


HII_RGB = hii_chroma()
NLR_RGB = camera_rgb(NLR_LINES)
# Dust: transmitted tint for the darkening pass (reddening: blue absorbed most).
DUST_RGB = np.array([0.42, 0.27, 0.16])


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


# --------------------------------------------------------------------------
# Sampling helpers (all positions: disk in x–z plane, y up, units ≈ kpc)
# --------------------------------------------------------------------------

def trunc_exp(rng, n, scale, lo, hi):
    """R in [lo, hi] with density ∝ exp(-R/scale)."""
    u = rng.random(n)
    span = 1.0 - math.exp(-(hi - lo) / scale)
    return lo - scale * np.log1p(-u * span)


def exp_disk_R(rng, n, Rd, Rmax, Rmin=0.0):
    """Radii of an exponential disk Σ ∝ exp(-R/Rd): p(R) ∝ R exp(-R/Rd) (Gamma k=2)."""
    out = np.empty(0)
    while out.size < n:
        r = rng.gamma(2.0, Rd, size=2 * (n - out.size) + 16)
        out = np.concatenate([out, r[(r <= Rmax) & (r >= Rmin)]])
    return out[:n]


def sech2(rng, n, z0):
    """Heights from ρ(z) ∝ sech²(z/z0): inverse CDF z = z0·artanh(2u−1)."""
    u = np.clip(rng.random(n), 1e-6, 1 - 1e-6)
    return z0 * np.arctanh(2 * u - 1)


def iso_dirs(rng, n):
    v = rng.normal(size=(n, 3))
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def sersic_radii(rng, n, Re, nser, rmax):
    """3D radii from the Prugniel–Simien deprojection of a Sérsic profile.

    ρ(r) ∝ (r/Re)^−p exp(−b (r/Re)^{1/n}); with t = b (r/Re)^{1/n} the enclosed
    mass is a Gamma(n(3−p)) variable, so r = Re (t/b)^n exactly.
    """
    p = 1.0 - 0.6097 / nser + 0.05463 / nser ** 2
    b = 2.0 * nser - 1.0 / 3.0 + 0.009876 / nser
    out = np.empty(0)
    while out.size < n:
        t = rng.gamma(nser * (3.0 - p), 1.0, size=2 * (n - out.size) + 16)
        r = Re * (t / b) ** nser
        out = np.concatenate([out, r[r <= rmax]])
    return out[:n]


def sersic_body(rng, n, Re, nser, rmax, axes=(1.0, 1.0, 1.0)):
    r = sersic_radii(rng, n, Re, nser, rmax)
    return iso_dirs(rng, n) * r[:, None] * np.asarray(axes)[None, :]


def ferrers_bar(rng, n, a, b, c, angle, nf=2):
    """Ferrers bar ρ ∝ (1 − m²)^nf, m² = x²/a² + z²/b² + y²/c² (in-plane a, b)."""
    out = np.empty((0, 3))
    while out.shape[0] < n:
        k = 3 * (n - out.shape[0]) + 16
        pts = rng.uniform(-1, 1, size=(k, 3))
        m2 = (pts ** 2).sum(axis=1)
        keep = (m2 < 1) & (rng.random(k) < (1 - m2) ** nf)
        out = np.concatenate([out, pts[keep]])
    out = out[:n] * np.array([a, c, b])
    return rot_y(out, angle)


def rot_y(p, ang):
    """Rotate about +y by ang (positive = −θ sense, the trailing-arm rotation)."""
    ca, sa = math.cos(ang), math.sin(ang)
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    return np.stack([x * ca + z * sa, y, -x * sa + z * ca], axis=1)


def rot_x(p, ang):
    ca, sa = math.cos(ang), math.sin(ang)
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    return np.stack([x, y * ca - z * sa, y * sa + z * ca], axis=1)


def polar(R, th, y):
    return np.stack([R * np.cos(th), y, R * np.sin(th)], axis=1)


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def alloc(N, fracs):
    """Integer allocation of N points to named fractions (largest gets remainder)."""
    keys = list(fracs)
    tot = sum(fracs.values())
    counts = {k: int(math.floor(N * fracs[k] / tot)) for k in keys}
    big = max(keys, key=lambda k: fracs[k])
    counts[big] += N - sum(counts.values())
    return counts


class Arms:
    """Set of logarithmic-spiral segments r = a·exp(b(θ−φ)), b = tan(pitch).

    θ increases outward; with rotation in the −θ sense (positive about +y) the
    arms trail. The concave (inner) edge of an arm is at +Δθ.
    """

    def __init__(self):
        self.seg = []  # (a, b, phase, Rlo, Rhi, weight)

    def add(self, a, pitch_deg, phase, Rlo, Rhi, weight=1.0):
        self.seg.append((a, math.tan(math.radians(pitch_deg)), phase, Rlo, Rhi, weight))
        return self

    def theta(self, i, R):
        a, b, ph, *_ = self.seg[i]
        return np.log(R / a) / b + ph

    def sample(self, rng, n, Rd):
        """Points along segments with linear density ∝ exp(−R/Rd). Returns R, θ0, seg idx."""
        w = np.array([s[5] * Rd * (math.exp(-s[3] / Rd) - math.exp(-s[4] / Rd)) for s in self.seg])
        idx = rng.choice(len(self.seg), size=n, p=w / w.sum())
        R = np.empty(n)
        th = np.empty(n)
        for i in range(len(self.seg)):
            m = idx == i
            k = int(m.sum())
            if k:
                R[m] = trunc_exp(rng, k, Rd, self.seg[i][3], self.seg[i][4])
                th[m] = self.theta(i, R[m])
        return R, th, idx

    def contrast(self, R, th, width):
        """Σ_k exp(−d²/2w²) with d the azimuthal distance (length) to segment k."""
        s = np.zeros_like(R)
        for i, (a, b, ph, lo, hi, _w) in enumerate(self.seg):
            inside = (R >= lo * 0.9) & (R <= hi * 1.05)
            d = wrap(th - self.theta(i, np.maximum(R, 1e-3))) * R
            taper = np.clip((R - lo * 0.9) / (0.1 * lo + 0.3), 0, 1) * np.clip((hi * 1.05 - R) / (0.1 * hi + 0.3), 0, 1)
            s += np.where(inside, np.exp(-0.5 * (d / width(R)) ** 2) * taper, 0.0)
        return s


class Cloud:
    def __init__(self):
        self.pos, self.chroma, self.lum, self.size, self.pop, self.extra = [], [], [], [], [], []

    def add(self, pos, pop, chroma, lum, size, extra):
        n = pos.shape[0]
        if n == 0:
            return
        chroma = np.broadcast_to(np.asarray(chroma, dtype=np.float64), (n, 3))
        self.pos.append(np.asarray(pos, dtype=np.float64))
        self.chroma.append(np.array(chroma))
        self.lum.append(np.broadcast_to(np.asarray(lum, dtype=np.float64), (n,)).copy())
        self.size.append(np.broadcast_to(np.asarray(size, dtype=np.float64), (n,)).copy())
        self.pop.append(np.full(n, pop, dtype=np.int64))
        self.extra.append(np.broadcast_to(np.asarray(extra, dtype=np.int64), (n,)).copy())

    def extend(self, other, transform=None, extra_override=None):
        for i in range(len(other.pos)):
            p = other.pos[i] if transform is None else transform(other.pos[i])
            ex = other.extra[i] if extra_override is None else np.full(p.shape[0], extra_override)
            self.add(p, int(other.pop[i][0]), other.chroma[i], other.lum[i], other.size[i], ex)

    def finish(self, rng, N, adaptive=True, k_nn=32):
        """Concatenate, apply adaptive smoothing lengths, shuffle.

        adaptive=True (galaxies): like SPH rendering, each point's sprite radius
        follows its local smoothing length h_i (distance to the k-th nearest
        neighbour), times the population jitter in `size`. Colour is then
        multiplied by (s_med/size)² so the *flux* of a sprite (peak × area)
        stays ∝ the population luminosity: sparse outer points become large and
        faint, dense cores small and bright, and the image stays smooth.
        """
        pos = np.concatenate(self.pos)
        assert pos.shape[0] == N, (pos.shape[0], N)
        pop = np.concatenate(self.pop)
        chroma = np.concatenate(self.chroma)
        lum = np.concatenate(self.lum)
        jitter = np.clip(np.concatenate(self.size), 0.0, 1.0)
        extra = np.concatenate(self.extra)
        dust = pop == POP_DUST
        size_scale = 1.0
        if adaptive:
            h = knn_distance(pos, k_nn)
            raw = h * (0.5 + jitter)
            size_scale = float(np.quantile(raw, 0.995))
            floor = max(float(np.quantile(raw, 0.03)) / size_scale, 2.0 / 255.0)
            size = np.clip(raw / size_scale, floor, 1.0)
            s_med = float(np.median(size[~dust]))
            comp = (s_med / size) ** FLUX_EXPONENT
            rgb = chroma * (lum * comp)[:, None]
            peak = float(np.quantile(rgb[~dust].max(axis=1), 0.997))
            rgb = rgb / peak
            # Dust: rgb = transmission at the sprite centre (1 = clear). Optical
            # depth per sprite ∝ (s_med/size)² keeps the dust column density
            # independent of sampling density (sparse puffs are fainter).
            if dust.any():
                sd = float(np.median(size[dust]))
                opacity = np.clip(DUST_OPACITY * (sd / size) ** 2, 0.03, 0.7)
                rgb = np.where(dust[:, None], 1.0 - opacity[:, None] * (1.0 - chroma), rgb)
        else:
            size = jitter
            rgb = chroma * lum[:, None]
            rgb = np.where(dust[:, None], 1.0 - 0.6 * (1.0 - chroma), rgb)
        perm = rng.permutation(N)  # any prefix is a uniform subsample (LOD)
        return {
            "pos": pos[perm],
            "rgb": np.clip(rgb[perm], 0.0, 1.0),
            "size": size[perm],
            "pop": pop[perm],
            "extra": extra[perm],
            "size_scale": size_scale,
        }


# 2.0 would conserve flux exactly; slightly less lifts the faint outer disk
# (artistic choice for legibility on a laptop screen).
FLUX_EXPONENT = 1.8
DUST_OPACITY = 0.55


def knn_distance(pos, k):
    """Distance to the k-th nearest neighbour (mathutils KD-tree, deterministic)."""
    from mathutils.kdtree import KDTree
    n = pos.shape[0]
    tree = KDTree(n)
    for i, co in enumerate(pos.tolist()):
        tree.insert(co, i)
    tree.balance()
    out = np.empty(n)
    for i, co in enumerate(pos.tolist()):
        out[i] = tree.find_n(co, k + 1)[-1][2]
    return out


def lum_powerlaw(rng, n, lo, hi, alpha=2.35):
    """Luminosity weights with a Salpeter-like power-law tail, mapped to [lo, hi]."""
    u = rng.random(n)
    x = (1 - u) ** (-1.0 / (alpha - 1.0))  # Pareto ≥ 1
    return lo + (hi - lo) * (1 - 1.0 / x)


def temps_old(rng, n, mean=4600.0, sd=350.0):
    return np.clip(rng.normal(mean, sd, n), 3300.0, 5600.0)


def temps_disk(rng, n, R, Rmax):
    base = 5100.0 + 1300.0 * np.clip(R / Rmax, 0, 1)  # bluer outward (age/metallicity gradient)
    return np.clip(rng.normal(base, 500.0, n), 3800.0, 8000.0)


def temps_young(rng, n, lo=9000.0, hi=26000.0):
    return np.exp(rng.uniform(math.log(lo), math.log(hi), n))


def hii_colors(rng, n):
    j = rng.normal(0.0, 0.05, (n, 3))
    c = HII_RGB[None, :] * (1 + j)
    return c / c.max(axis=1, keepdims=True)


# --------------------------------------------------------------------------
# Generic disk-galaxy builder
# --------------------------------------------------------------------------

def spiral_galaxy(rng, N, P):
    """Exponential disk + Sérsic bulge + optional bar + spiral segments + dust.

    P keys: Rd, Rmax, hz (sech² scale height), bulge=(Re, n, flatten, rmax),
    arms (Arms), arm_Rd, arm_width(R) -> σ, disk_contrast, bar=(a,b,c,angle)|None,
    frac (dict of component fractions), clumps, nucleus_sigma, nucleus_T,
    nucleus_lum, dust_offset(R) -> inner-edge offset length.
    """
    c = Cloud()
    f = P["frac"]
    n = alloc(N, f)
    Rd, Rmax, hz = P["Rd"], P["Rmax"], P["hz"]
    arms: Arms = P["arms"]
    width = P["arm_width"]

    # 1) Bulge (old, Sérsic via Prugniel–Simien).
    Re, ns, flat, brmax = P["bulge"]
    k = n.get("bulge", 0)
    if k:
        p = sersic_body(rng, k, Re, ns, brmax, axes=(1.0, flat, 1.0))
        r = np.linalg.norm(p, axis=1)
        T = temps_old(rng, k, P.get("bulge_T", 4500.0), 300.0) - 250.0 * np.exp(-r / Re)
        c.add(p, POP_OLD, blackbody_chroma(T), rng.uniform(0.45, 0.75, k), rng.uniform(0.14, 0.32, k), C_BULGE)

    # 2) Bar (Ferrers, n=2): old + intermediate stars.
    bar = P.get("bar")
    k = n.get("bar", 0)
    if bar and k:
        a, b, cc, ang = bar
        p = ferrers_bar(rng, k, a, b, cc, ang)
        c.add(p, POP_OLD, blackbody_chroma(temps_old(rng, k, 4900.0, 400.0)),
              rng.uniform(0.45, 0.75, k), rng.uniform(0.14, 0.32, k), C_BAR)

    # 3) Disk (intermediate age) with density-wave modulation by the arms.
    k = n.get("disk", 0)
    if k:
        A = P.get("disk_contrast", 1.5)
        R_all, th_all = np.empty(0), np.empty(0)
        while R_all.size < k:
            m = 3 * (k - R_all.size) + 64
            R = exp_disk_R(rng, m, Rd, Rmax, P.get("disk_Rmin", 0.0))
            th = rng.uniform(-np.pi, np.pi, m)
            w = (1.0 + A * np.minimum(arms.contrast(R, th, lambda r: 1.8 * width(r)), 1.5)) / (1.0 + 1.5 * A)
            keep = rng.random(m) < w
            R_all = np.concatenate([R_all, R[keep]])
            th_all = np.concatenate([th_all, th[keep]])
        R, th = R_all[:k], th_all[:k]
        y = sech2(rng, k, hz * (1.0 + 0.6 * R / Rmax))  # mild flaring
        T = temps_disk(rng, k, R, Rmax)
        c.add(polar(R, th, y), POP_DISK, blackbody_chroma(T), rng.uniform(0.3, 0.6, k),
              rng.uniform(0.12, 0.3, k), C_DISK)

    # Star-forming complexes along the arms (shared by young stars and HII).
    nclump = P.get("clumps", 90)
    cR, cth, _ = arms.sample(rng, nclump, P["arm_Rd"])
    cth = cth + (rng.normal(0, 1, nclump) * width(cR) * 0.6 - 0.15) / cR
    csig = rng.uniform(0.18, 0.5, nclump) * P.get("clump_scale", 1.0)

    # 4) Young stars: 55 % in complexes, 45 % diffuse along the arms.
    k = n.get("young", 0)
    if k:
        kc = int(k * 0.55)
        idx = rng.integers(0, nclump, kc)
        pc = polar(cR[idx], cth[idx], np.zeros(kc)) + rng.normal(size=(kc, 3)) * csig[idx, None] * np.array([1, 0.35, 1])
        kd = k - kc
        R, th, _ = arms.sample(rng, kd, P["arm_Rd"])
        th = th + (rng.normal(0, 1, kd) * width(R) - 0.2) / R
        pd = polar(R, th, sech2(rng, kd, hz * 0.35))
        p = np.concatenate([pc, pd])
        c.add(p, POP_YOUNG, blackbody_chroma(temps_young(rng, k)), lum_powerlaw(rng, k, 0.4, 0.9),
              rng.uniform(0.15, 0.45, k) + 0.25 * rng.random(k) ** 6, C_ARM)

    # 5) HII regions: compact knots on a subset of complexes, slightly downstream
    #    (outer/convex side, −Δθ) of the dust lanes.
    k = n.get("hii", 0)
    if k:
        sub = rng.choice(nclump, size=max(8, int(nclump * 0.6)), replace=False)
        idx = sub[rng.integers(0, sub.size, k)]
        off = -0.15 / cR[idx]
        p = polar(cR[idx], cth[idx] + off, np.zeros(k)) + rng.normal(size=(k, 3)) * (0.35 * csig[idx, None]) * np.array([1, 0.4, 1])
        c.add(p, POP_HII, hii_colors(rng, k), rng.uniform(0.6, 1.0, k), rng.uniform(0.35, 0.8, k), C_ARM)

    # 6) Dust: lanes on the inner (concave) edge of arms + thin midplane layer.
    k = n.get("dust", 0)
    if k:
        kl = int(k * P.get("dust_lane_share", 0.7))
        R, th, _ = arms.sample(rng, kl, P["arm_Rd"] * 1.2)
        doff = P.get("dust_offset", lambda r: 0.45 + 0.05 * r)(R)
        th = th + (doff + rng.normal(0, 1, kl) * 0.3 * width(R)) / R
        pl = polar(R, th, sech2(rng, kl, hz * 0.25))
        km = k - kl
        # midplane layer also modulated by the arms (dust follows the gas)
        Rm_all, thm_all = np.empty(0), np.empty(0)
        while Rm_all.size < km:
            m = 3 * (km - Rm_all.size) + 64
            R = exp_disk_R(rng, m, Rd * 1.1, Rmax * 0.95, P.get("dust_Rmin", 0.6))
            th = rng.uniform(-np.pi, np.pi, m)
            w = (0.35 + np.minimum(arms.contrast(R, th - 0.3 / R, lambda r: 1.5 * width(r)), 1.0)) / 1.35
            keep = rng.random(m) < w
            Rm_all = np.concatenate([Rm_all, R[keep]])
            thm_all = np.concatenate([thm_all, th[keep]])
        pm = polar(Rm_all[:km], thm_all[:km], sech2(rng, km, hz * 0.3))
        p = np.concatenate([pl, pm])
        extras = np.concatenate([np.full(kl, C_ARM), np.full(km, C_DISK)])
        # bar dust lanes on the leading edges (−θ side) of the bar
        if bar and P.get("bar_dust", 0) > 0:
            kb = int(k * P["bar_dust"])
            a, b, cc, ang = bar
            s = rng.uniform(-1, 1, kb)
            x = s * a * 0.95
            zoff = -np.sign(s) * (0.55 * b + 0.25 * np.abs(s) * b) + rng.normal(0, 0.12, kb)
            pb = rot_y(np.stack([x, sech2(rng, kb, hz * 0.2), zoff], axis=1), ang)
            p[:kb] = pb
            extras[:kb] = C_BAR
        c.add(p, POP_DUST, DUST_RGB * rng.uniform(0.85, 1.15, (k, 1)), 1.0,
              rng.uniform(0.45, 1.0, k), extras)

    # 7) Nucleus: compact nuclear star cluster (or AGN, see Seyfert).
    k = n.get("nucleus", 0)
    if k:
        p = rng.normal(size=(k, 3)) * P.get("nucleus_sigma", 0.06) * np.array([1, 0.7, 1])
        T = np.asarray(P.get("nucleus_T", 5200.0)) + rng.normal(0, 300, k)
        c.add(p, POP_NUCLEUS, blackbody_chroma(T), P.get("nucleus_lum", 0.95),
              rng.uniform(*P.get("nucleus_size", (0.25, 0.55)), k), C_BULGE)
    return c


# --------------------------------------------------------------------------
# Archetypes
# --------------------------------------------------------------------------

def g01_grand_design(rng, N):
    arms = Arms()
    for ph in (0.0, math.pi):
        arms.add(1.2, 15.0, ph, 1.3, 14.0)
    P = dict(Rd=3.2, Rmax=15.0, hz=0.22, bulge=(0.9, 2.0, 0.75, 5.0), arms=arms, arm_Rd=4.5,
             arm_width=lambda R: 0.45 + 0.07 * R, disk_contrast=2.0, clumps=120, clump_scale=1.2,
             frac=dict(bulge=0.15, disk=0.36, young=0.17, hii=0.06, dust=0.25, nucleus=0.01))
    return spiral_galaxy(rng, N, P)


def g02_barred(rng, N):
    bar_a = 4.2
    arms = Arms()
    for ph in (0.0, math.pi):
        arms.add(bar_a, 16.0, ph, bar_a, 14.0)
    P = dict(Rd=3.4, Rmax=15.0, hz=0.24, bulge=(0.7, 1.5, 0.7, 4.0), arms=arms, arm_Rd=5.0,
             arm_width=lambda R: 0.45 + 0.065 * R, disk_contrast=1.8, clumps=100, clump_scale=1.1,
             bar=(bar_a, 1.35, 0.5, 0.0), bar_dust=0.14, disk_Rmin=0.0,
             frac=dict(bulge=0.08, bar=0.12, disk=0.3, young=0.18, hii=0.06, dust=0.25, nucleus=0.01))
    return spiral_galaxy(rng, N, P)


def g03_flocculent(rng, N):
    arms = Arms()
    for _ in range(34):
        R0 = float(rng.uniform(1.5, 10.0))
        pitch = float(rng.uniform(18.0, 28.0))
        dth = float(rng.uniform(0.5, 1.3))
        b = math.tan(math.radians(pitch))
        R1 = min(R0 * math.exp(b * dth), 13.0)
        arms.add(R0, pitch, float(rng.uniform(-math.pi, math.pi)), R0, R1, weight=1.0)
    P = dict(Rd=3.0, Rmax=13.5, hz=0.22, bulge=(0.7, 1.5, 0.8, 3.5), arms=arms, arm_Rd=4.0,
             arm_width=lambda R: 0.3 + 0.04 * R, disk_contrast=1.6, clumps=160, clump_scale=1.0,
             dust_lane_share=0.6, dust_offset=lambda R: 0.18 + 0.02 * R,
             frac=dict(bulge=0.13, disk=0.38, young=0.2, hii=0.05, dust=0.23, nucleus=0.01))
    return spiral_galaxy(rng, N, P)


def g04_elliptical(rng, N):
    c = Cloud()
    n = alloc(N, dict(body=0.975, gc=0.02, nucleus=0.005))
    Re = 3.0
    k = n["body"]
    p = sersic_body(rng, k, Re, 4.0, 9.0 * Re, axes=(1.0, 0.62, 0.8))  # triaxial E3–E4
    r = np.linalg.norm(p / np.array([1.0, 0.62, 0.8]), axis=1)
    # metallicity gradient: redder centre, slightly bluer envelope
    T = np.clip(rng.normal(4250.0 + 260.0 * np.log10(1.0 + r / Re * 3.0), 220.0), 3300.0, 5400.0)
    c.add(p, POP_OLD, blackbody_chroma(T), rng.uniform(0.35, 0.65, k), rng.uniform(0.12, 0.3, k), C_BULGE)
    k = n["gc"]
    p = sersic_body(rng, k, 2.5 * Re, 2.0, 30.0, axes=(1.0, 0.85, 0.95))
    c.add(p, POP_OLD, blackbody_chroma(rng.normal(5000.0, 300.0, k)), rng.uniform(0.55, 0.85, k),
          rng.uniform(0.25, 0.45, k), C_HALO)
    k = n["nucleus"]
    p = rng.normal(size=(k, 3)) * 0.08
    c.add(p, POP_NUCLEUS, blackbody_chroma(rng.normal(4400.0, 150.0, k)), 0.9, rng.uniform(0.25, 0.5, k), C_BULGE)
    return c


def g05_lenticular(rng, N):
    c = Cloud()
    n = alloc(N, dict(bulge=0.36, disk=0.52, lens=0.06, dust=0.05, nucleus=0.01))
    k = n["bulge"]
    p = sersic_body(rng, k, 1.3, 3.0, 10.0, axes=(1.0, 0.62, 1.0))
    c.add(p, POP_OLD, blackbody_chroma(temps_old(rng, k, 4500.0, 280.0)), rng.uniform(0.4, 0.7, k),
          rng.uniform(0.12, 0.3, k), C_BULGE)
    k = n["disk"]
    R = exp_disk_R(rng, k, 2.6, 13.0)
    th = rng.uniform(-np.pi, np.pi, k)
    y = sech2(rng, k, 0.32)
    T = np.clip(rng.normal(5000.0 + 400.0 * R / 13.0, 350.0), 3600.0, 6500.0)
    c.add(polar(R, th, y), POP_DISK, blackbody_chroma(T), rng.uniform(0.3, 0.55, k), rng.uniform(0.12, 0.28, k), C_DISK)
    # lens: shallow plateau component typical of S0s
    k = n["lens"]
    R = 4.2 * np.sqrt(rng.random(k))
    th = rng.uniform(-np.pi, np.pi, k)
    c.add(polar(R, th, sech2(rng, k, 0.25)), POP_DISK, blackbody_chroma(temps_old(rng, k, 4800.0, 250.0)),
          rng.uniform(0.3, 0.5, k), rng.uniform(0.12, 0.25, k), C_DISK)
    # faint inner dust disk/ring (e.g. NGC 4526-like)
    k = n["dust"]
    R = np.clip(rng.normal(2.6, 0.55, k), 1.2, 4.5)
    th = rng.uniform(-np.pi, np.pi, k)
    c.add(polar(R, th, sech2(rng, k, 0.05)), POP_DUST, DUST_RGB * rng.uniform(0.9, 1.1, (k, 1)), 1.0,
          rng.uniform(0.4, 0.85, k), C_RING)
    k = n["nucleus"]
    c.add(rng.normal(size=(k, 3)) * 0.07, POP_NUCLEUS, blackbody_chroma(rng.normal(4700.0, 150.0, k)), 0.95,
          rng.uniform(0.25, 0.5, k), C_BULGE)
    return c


def g06_ring(rng, N):
    """Cartwheel-like collisional ring: expanding density wave, offset nucleus."""
    c = Cloud()
    n = alloc(N, dict(ring_young=0.22, ring_hii=0.08, ring_disk=0.18, inner=0.12, spokes=0.06,
                      disk=0.14, dust=0.17, nucleus=0.01, nucl_bulge=0.02))
    Rring, qx, qz = 10.0, 1.0, 0.86
    nuc = np.array([-3.0, 0.0, -1.2])

    def ring_pts(k, width, h):
        th = rng.uniform(-np.pi, np.pi, k)
        # sharper outer edge (the wave front), softer trailing inner side
        g = rng.normal(0, 1, k)
        dr = np.where(g > 0, g * width * 0.55, g * width * 1.3)
        R = Rring * (1 + 0.06 * np.cos(3 * th + 0.7)) + dr
        return np.stack([R * np.cos(th) * qx, sech2(rng, k, h), R * np.sin(th) * qz], axis=1), th

    k = n["ring_young"]
    kc = int(k * 0.55)
    ccent, _ = ring_pts(70, 1.0, 0.1)
    idx = rng.integers(0, 60, kc)
    pc = ccent[idx] + rng.normal(size=(kc, 3)) * np.array([0.55, 0.15, 0.55])
    pd, _ = ring_pts(k - kc, 1.4, 0.2)
    c.add(np.concatenate([pc, pd]), POP_YOUNG, blackbody_chroma(temps_young(rng, k, 10000.0, 30000.0)),
          lum_powerlaw(rng, k, 0.35, 0.8), rng.uniform(0.15, 0.45, k) + 0.25 * rng.random(k) ** 6, C_RING)
    k = n["ring_hii"]
    idx = rng.integers(0, 45, k)
    p = ccent[idx] * 1.02 + rng.normal(size=(k, 3)) * np.array([0.14, 0.06, 0.14])
    c.add(p, POP_HII, hii_colors(rng, k), rng.uniform(0.6, 1.0, k), rng.uniform(0.35, 0.8, k), C_RING)
    k = n["ring_disk"]
    p, _ = ring_pts(k, 1.6, 0.3)
    c.add(p, POP_DISK, blackbody_chroma(rng.normal(6500.0, 700.0, k)), rng.uniform(0.3, 0.55, k),
          rng.uniform(0.12, 0.3, k), C_RING)
    # inner ring around the offset nucleus (old/yellow)
    k = n["inner"]
    th = rng.uniform(-np.pi, np.pi, k)
    R = np.abs(rng.normal(2.6, 0.45, k))
    p = polar(R, th, sech2(rng, k, 0.2)) + nuc
    c.add(p, POP_OLD, blackbody_chroma(temps_old(rng, k, 4800.0, 350.0)), rng.uniform(0.4, 0.7, k),
          rng.uniform(0.12, 0.3, k), C_RING)
    # spokes: radial streams from inner ring to outer ring
    k = n["spokes"]
    nsp = 14
    ang = np.sort(rng.uniform(-np.pi, np.pi, nsp))
    s = rng.integers(0, nsp, k)
    t = rng.random(k) ** 0.8
    a0 = nuc[None, :] + polar(np.full(k, 2.8), ang[s], np.zeros(k))
    a1 = polar(np.full(k, Rring * 0.9), ang[s] + 0.15, np.zeros(k)) * np.array([qx, 1, qz])
    p = a0 + (a1 - a0) * t[:, None] + rng.normal(size=(k, 3)) * np.array([0.7, 0.15, 0.7])
    c.add(p, POP_DISK, blackbody_chroma(rng.normal(5600.0, 600.0, k)), rng.uniform(0.25, 0.5, k),
          rng.uniform(0.12, 0.28, k), C_DISK)
    # faint underlying disk
    k = n["disk"]
    R = exp_disk_R(rng, k, 4.0, 13.0)
    th = rng.uniform(-np.pi, np.pi, k)
    c.add(polar(R, th, sech2(rng, k, 0.3)) + nuc * 0.5, POP_DISK, blackbody_chroma(temps_disk(rng, k, R, 13.0)),
          rng.uniform(0.2, 0.45, k), rng.uniform(0.12, 0.28, k), C_DISK)
    # dust on the inner side of the ring and along spokes
    k = n["dust"]
    kr = int(k * 0.88)
    th = rng.uniform(-np.pi, np.pi, kr)
    R = Rring * (1 + 0.06 * np.cos(3 * th + 0.7)) - 0.9 + rng.normal(0, 0.35, kr)
    pr = np.stack([R * np.cos(th) * qx, sech2(rng, kr, 0.06), R * np.sin(th) * qz], axis=1)
    ks = k - kr
    s = rng.integers(0, nsp, ks)
    t = rng.uniform(0.2, 1.0, ks)
    a0 = nuc[None, :] + polar(np.full(ks, 2.8), ang[s] + 0.08, np.zeros(ks))
    a1 = polar(np.full(ks, Rring * 0.88), ang[s] + 0.23, np.zeros(ks)) * np.array([qx, 1, qz])
    ps = a0 + (a1 - a0) * t[:, None] + rng.normal(size=(ks, 3)) * np.array([0.18, 0.05, 0.18])
    c.add(np.concatenate([pr, ps]), POP_DUST, DUST_RGB * rng.uniform(0.85, 1.15, (k, 1)), 1.0,
          rng.uniform(0.4, 0.9, k), C_RING)
    k = n["nucl_bulge"]
    c.add(sersic_body(rng, k, 0.6, 2.0, 3.0, axes=(1, 0.7, 1)) + nuc, POP_OLD,
          blackbody_chroma(temps_old(rng, k, 4500.0, 250.0)), rng.uniform(0.5, 0.8, k), rng.uniform(0.14, 0.32, k), C_BULGE)
    k = n["nucleus"]
    c.add(rng.normal(size=(k, 3)) * 0.1 + nuc, POP_NUCLEUS, blackbody_chroma(rng.normal(4800.0, 200.0, k)), 0.95,
          rng.uniform(0.25, 0.55, k), C_BULGE)
    return c


def g07_irregular(rng, N):
    """Magellanic-type dwarf: off-centre bar, clumpy star formation, low mass."""
    c = Cloud()
    n = alloc(N, dict(old=0.22, bar=0.1, young=0.33, hii=0.14, dust=0.2, nucleus=0.01))
    q = np.array([1.0, 1.0, 0.72])
    k = n["old"]
    R = exp_disk_R(rng, k, 1.2, 5.0)
    th = rng.uniform(-np.pi, np.pi, k)
    p = polar(R, th, sech2(rng, k, 0.4)) * q
    c.add(p, POP_OLD, blackbody_chroma(temps_old(rng, k, 5000.0, 450.0)), rng.uniform(0.15, 0.3, k),
          rng.uniform(0.12, 0.28, k), C_DISK)
    k = n["bar"]
    p = ferrers_bar(rng, k, 2.2, 0.6, 0.45, 0.35) + np.array([0.6, 0.0, -0.3])
    c.add(p, POP_DISK, blackbody_chroma(rng.normal(5600.0, 600.0, k)), rng.uniform(0.4, 0.65, k),
          rng.uniform(0.12, 0.3, k), C_BAR)
    ncl = 26
    cl = polar(np.abs(rng.normal(0, 2.0, ncl)) + 0.3, rng.uniform(-np.pi, np.pi, ncl), rng.normal(0, 0.25, ncl)) * q
    cw = rng.pareto(1.3, ncl) + 1.0
    cw /= cw.sum()
    csig = rng.uniform(0.2, 0.6, ncl)
    k = n["young"]
    idx = rng.choice(ncl, size=k, p=cw)
    p = cl[idx] + rng.normal(size=(k, 3)) * csig[idx, None] * np.array([1, 0.6, 1])
    c.add(p, POP_YOUNG, blackbody_chroma(temps_young(rng, k, 9000.0, 28000.0)), lum_powerlaw(rng, k, 0.5, 1.0),
          rng.uniform(0.15, 0.45, k) + 0.25 * rng.random(k) ** 6, C_DISK)
    k = n["hii"]
    idx = rng.choice(ncl, size=k, p=cw)
    # 30 Doradus-like giant HII complexes: shells around the brightest clumps
    shell = iso_dirs(rng, k) * (csig[idx, None] * rng.uniform(0.3, 1.1, (k, 1)))
    c.add(cl[idx] + shell * np.array([1, 0.7, 1]), POP_HII, hii_colors(rng, k), rng.uniform(0.55, 1.0, k),
          rng.uniform(0.35, 0.8, k), C_DISK)
    k = n["dust"]
    idx = rng.choice(ncl, size=k, p=cw)
    p = cl[idx] + rng.normal(size=(k, 3)) * (1.6 * csig[idx, None]) * np.array([1, 0.35, 1])
    c.add(p, POP_DUST, DUST_RGB * rng.uniform(0.85, 1.15, (k, 1)), 1.0, rng.uniform(0.4, 0.9, k), C_DISK)
    k = n["nucleus"]
    c.add(rng.normal(size=(k, 3)) * 0.25 + np.array([0.6, 0, -0.3]), POP_NUCLEUS,
          blackbody_chroma(rng.normal(6500.0, 500.0, k)), 0.7, rng.uniform(0.2, 0.45, k), C_BAR)
    return c


def g08_interacting(rng, N):
    """M51-like pair: primary grand-design spiral, companion at the end of a
    tidal bridge, and a long curved tidal tail with a vertical warp."""
    c = Cloud()
    n = alloc(N, dict(primary=0.62, companion=0.16, bridge=0.08, tail=0.14))
    arms = Arms()
    for ph in (0.0, math.pi):
        arms.add(1.5, 15.0, ph, 1.7, 11.5)
    P = dict(Rd=2.8, Rmax=12.5, hz=0.22, bulge=(0.8, 2.0, 0.75, 4.5), arms=arms, arm_Rd=4.0,
             arm_width=lambda R: 0.45 + 0.065 * R, disk_contrast=1.8, clumps=100, clump_scale=1.1,
             frac=dict(bulge=0.14, disk=0.33, young=0.2, hii=0.07, dust=0.25, nucleus=0.01))
    c.extend(spiral_galaxy(rng, n["primary"], P))

    # end of arm 0 in the primary
    b = math.tan(math.radians(15.0))
    R_end = 11.5
    th_end0 = math.log(R_end / 1.5) / b
    C = np.array([R_end * math.cos(th_end0 + 0.9) * 1.35, -1.6, R_end * math.sin(th_end0 + 0.9) * 1.35])

    arms2 = Arms()
    for ph in (0.4, 0.4 + math.pi):
        arms2.add(0.8, 22.0, ph, 0.9, 3.6)
    P2 = dict(Rd=1.1, Rmax=4.5, hz=0.18, bulge=(0.55, 2.5, 0.8, 3.0), arms=arms2, arm_Rd=1.5,
              arm_width=lambda R: 0.2 + 0.05 * R, disk_contrast=0.8, clumps=20,
              frac=dict(bulge=0.42, disk=0.34, young=0.06, hii=0.01, dust=0.15, nucleus=0.02))
    comp = spiral_galaxy(rng, n["companion"], P2)
    c.extend(comp, transform=lambda p: rot_y(rot_x(p, math.radians(58.0)), -0.6) + C, extra_override=C_COMPANION)

    def curve_cloud(k, P0, P1, P2c, width0, width1, lift):
        t = rng.random(k)
        pts = ((1 - t) ** 2)[:, None] * P0 + (2 * (1 - t) * t)[:, None] * P1 + (t ** 2)[:, None] * P2c
        w = width0 + (width1 - width0) * t
        pts = pts + rng.normal(size=(k, 3)) * w[:, None] * np.array([1, 0.35, 1])
        pts[:, 1] += lift * t ** 2
        return pts, t

    # bridge: from the end of arm 0 to the companion
    P0 = np.array([R_end * math.cos(th_end0), 0.0, R_end * math.sin(th_end0)])
    P1 = P0 * 1.25 + (C - P0) * 0.2
    k = n["bridge"]
    ky = int(k * 0.3)
    kd = int(k * 0.5)
    kdu = k - ky - kd
    p, t = curve_cloud(kd, P0, P1, C, 0.5, 0.8, 0.0)
    c.add(p, POP_DISK, blackbody_chroma(rng.normal(5800.0, 600.0, kd)), rng.uniform(0.3, 0.55, kd),
          rng.uniform(0.12, 0.3, kd), C_TIDAL)
    p, t = curve_cloud(ky, P0, P1, C, 0.35, 0.5, 0.0)
    c.add(p, POP_YOUNG, blackbody_chroma(temps_young(rng, ky)), lum_powerlaw(rng, ky, 0.5, 1.0),
          rng.uniform(0.15, 0.45, ky), C_TIDAL)
    p, t = curve_cloud(kdu, P0, P1, C, 0.25, 0.4, 0.0)
    p = p + (np.array([0.0, 0.0, 0.0]))
    c.add(p, POP_DUST, DUST_RGB * rng.uniform(0.85, 1.15, (kdu, 1)), 1.0, rng.uniform(0.45, 0.9, kdu), C_TIDAL)

    # long tidal tail from arm 1, winding outward and warping out of the plane
    k = n["tail"]
    th1 = math.log(R_end / 1.5) / b + math.pi
    s = rng.random(k)
    th = th1 + 1.9 * s
    R = R_end * (24.0 / R_end) ** s
    w = 0.5 + 1.6 * s
    p = polar(R, th, 4.5 * s ** 2) + rng.normal(size=(k, 3)) * w[:, None] * np.array([1, 0.3, 1])
    ky = int(k * 0.18)
    kh = int(k * 0.03)
    kd = k - ky - kh
    c.add(p[:kd], POP_DISK, blackbody_chroma(rng.normal(6000.0, 700.0, kd)), rng.uniform(0.25, 0.5, kd),
          rng.uniform(0.12, 0.3, kd), C_TIDAL)
    # tidal dwarf candidates: clumps of young stars + HII in the tail
    nt = 9
    tc = rng.uniform(0.2, 0.95, nt)
    tcp = polar(R_end * (24.0 / R_end) ** tc, th1 + 1.9 * tc, 4.5 * tc ** 2)
    idx = rng.integers(0, nt, ky)
    c.add(tcp[idx] + rng.normal(size=(ky, 3)) * 1.0, POP_YOUNG, blackbody_chroma(temps_young(rng, ky)),
          lum_powerlaw(rng, ky, 0.5, 1.0), rng.uniform(0.15, 0.45, ky), C_TIDAL)
    idx = rng.integers(0, nt, kh)
    c.add(tcp[idx] + rng.normal(size=(kh, 3)) * 0.2, POP_HII, hii_colors(rng, kh), rng.uniform(0.6, 1.0, kh),
          rng.uniform(0.35, 0.75, kh), C_TIDAL)
    return c


def g09_starburst(rng, N):
    """M82-like: compact disk, nuclear starburst of super star clusters, heavy
    chaotic dust, and an Hα bipolar superwind along the minor axis (y)."""
    c = Cloud()
    n = alloc(N, dict(bulge=0.08, disk=0.28, ssc=0.18, hii=0.13, dust=0.12, wind=0.2, nucleus=0.01))
    k = n["bulge"]
    c.add(sersic_body(rng, k, 0.45, 1.5, 3.0, axes=(1, 0.6, 1)), POP_OLD,
          blackbody_chroma(temps_old(rng, k, 4800.0, 300.0)), rng.uniform(0.45, 0.75, k), rng.uniform(0.14, 0.3, k), C_BULGE)
    k = n["disk"]
    R = exp_disk_R(rng, k, 1.3, 7.0)
    th = rng.uniform(-np.pi, np.pi, k)
    c.add(polar(R, th, sech2(rng, k, 0.28)), POP_DISK, blackbody_chroma(np.clip(rng.normal(6600.0, 900.0, k), 4500, 11000)),
          rng.uniform(0.3, 0.6, k), rng.uniform(0.12, 0.3, k), C_DISK)
    # super star clusters in the central ~1.5 kpc
    nss = 45
    sc = polar(np.abs(rng.normal(0, 0.8, nss)) + 0.1, rng.uniform(-np.pi, np.pi, nss), rng.normal(0, 0.08, nss))
    sw = rng.pareto(1.2, nss) + 1
    sw /= sw.sum()
    k = n["ssc"]
    idx = rng.choice(nss, size=k, p=sw)
    c.add(sc[idx] + rng.normal(size=(k, 3)) * 0.1, POP_YOUNG, blackbody_chroma(temps_young(rng, k, 12000.0, 35000.0)),
          lum_powerlaw(rng, k, 0.6, 1.0), rng.uniform(0.2, 0.5, k) + 0.25 * rng.random(k) ** 6, C_BULGE)
    k = n["hii"]
    kc = int(k * 0.6)
    idx = rng.choice(nss, size=kc, p=sw)
    ph = sc[idx] + rng.normal(size=(kc, 3)) * 0.14
    kd = k - kc
    R = exp_disk_R(rng, kd, 1.4, 5.5)
    ph2 = polar(R, rng.uniform(-np.pi, np.pi, kd), sech2(rng, kd, 0.1))
    c.add(np.concatenate([ph, ph2]), POP_HII, hii_colors(rng, k), rng.uniform(0.6, 1.0, k), rng.uniform(0.35, 0.8, k), C_DISK)
    # chaotic dust: random-walk filaments threading the disk
    k = n["dust"]
    nf = 40
    per = k // nf
    fil = []
    for i in range(nf):
        m = per if i < nf - 1 else k - per * (nf - 1)
        start = polar(np.array([rng.uniform(0.9, 4.5)]), np.array([rng.uniform(-np.pi, np.pi)]), np.array([rng.normal(0, 0.12)]))[0]
        step = rng.normal(size=(m, 3)) * np.array([0.09, 0.012, 0.09])
        fil.append(start + np.cumsum(step, axis=0) + rng.normal(size=(m, 3)) * np.array([0.08, 0.03, 0.08]))
    c.add(np.concatenate(fil), POP_DUST, DUST_RGB * rng.uniform(0.85, 1.15, (k, 1)), 1.0, rng.uniform(0.4, 0.9, k), C_DISK)
    # bipolar superwind: Hα filaments in two cones (half-opening ~30°) along ±y
    k = n["wind"]
    nfl = 70
    fdir = rng.uniform(-np.pi, np.pi, nfl)
    fopen = np.radians(rng.uniform(5.0, 32.0, nfl))
    fside = np.where(rng.random(nfl) < 0.5, -1.0, 1.0)
    idx = rng.integers(0, nfl, k)
    h = 0.3 + 6.5 * rng.random(k) ** 1.6
    rr = h * np.tan(fopen[idx]) + 0.35
    p = np.stack([rr * np.cos(fdir[idx]), fside[idx] * h, rr * np.sin(fdir[idx])], axis=1)
    p += rng.normal(size=(k, 3)) * (0.08 + 0.05 * h[:, None])
    lum = np.clip(0.8 * np.exp(-h / 3.0) + 0.15, 0.1, 1.0) * rng.uniform(0.6, 1.0, k)
    col = HII_RGB * 0.7 + np.array([1.0, 0.25, 0.25]) * 0.3
    c.add(p, POP_HII, col / col.max(), lum, rng.uniform(0.3, 0.7, k), C_TIDAL)
    k = n["nucleus"]
    c.add(rng.normal(size=(k, 3)) * 0.06, POP_NUCLEUS, blackbody_chroma(rng.normal(9000.0, 1000.0, k)), 1.0,
          rng.uniform(0.3, 0.6, k), C_BULGE)
    return c


def g10_seyfert(rng, N):
    """NGC 1068/4151-like Seyfert: spiral with a starburst pseudo-ring, a very
    compact bright nucleus population and an [OIII] ionisation cone."""
    c = Cloud()
    n = alloc(N, dict(galaxy=0.935, agn=0.035, cone=0.03))
    arms = Arms()
    for ph in (0.0, math.pi):
        arms.add(1.9, 17.0, ph, 1.9, 13.0)
    P = dict(Rd=3.0, Rmax=14.0, hz=0.22, bulge=(0.8, 1.8, 0.75, 4.0), arms=arms, arm_Rd=4.5,
             arm_width=lambda R: 0.45 + 0.065 * R, disk_contrast=1.8, clumps=110, clump_scale=1.1,
             frac=dict(bulge=0.16, disk=0.33, young=0.19, hii=0.06, dust=0.24, ring=0.02))
    g = spiral_galaxy(rng, n["galaxy"] - alloc(n["galaxy"], P["frac"])["ring"], {**P, "frac": {k: v for k, v in P["frac"].items() if k != "ring"}})
    c.extend(g)
    k = alloc(n["galaxy"], P["frac"])["ring"]
    th = rng.uniform(-np.pi, np.pi, k)
    R = np.abs(rng.normal(1.6, 0.18, k))
    c.add(polar(R, th, sech2(rng, k, 0.05)), POP_YOUNG, blackbody_chroma(temps_young(rng, k)),
          lum_powerlaw(rng, k, 0.55, 1.0), rng.uniform(0.2, 0.5, k), C_RING)
    k = n["agn"]
    r = np.abs(rng.standard_cauchy(k)) * 0.015
    r = np.minimum(r, 0.6)
    p = iso_dirs(rng, k) * r[:, None]
    c.add(p, POP_NUCLEUS, blackbody_chroma(rng.uniform(15000.0, 35000.0, k)), 1.0,
          np.clip(0.95 - r / 0.6 * 0.5, 0.4, 1.0) * rng.uniform(0.7, 1.0, k), C_BULGE)
    k = n["cone"]
    axis = rot_x(np.array([[0.0, 1.0, 0.0]]), math.radians(35.0))[0]
    side = np.where(rng.random(k) < 0.5, -1.0, 1.0)
    h = 0.1 + 2.2 * rng.random(k) ** 1.5
    open_ = np.radians(rng.uniform(0.0, 22.0, k))
    phi = rng.uniform(-np.pi, np.pi, k)
    local = np.stack([h * np.tan(open_) * np.cos(phi), h, h * np.tan(open_) * np.sin(phi)], axis=1)
    # rotate local y to axis
    ang = math.acos(axis[1])
    p = rot_x(local, math.radians(35.0)) * side[:, None]
    del ang
    lum = np.clip(np.exp(-h / 1.5), 0.15, 1.0) * rng.uniform(0.5, 0.9, k)
    c.add(p + rng.normal(size=(k, 3)) * 0.05, POP_NUCLEUS, 0.5 * NLR_RGB + 0.5, lum * 0.6, rng.uniform(0.25, 0.55, k), C_TIDAL)
    return c


BUILDERS = {
    "g01-grand-design-spiral": g01_grand_design,
    "g02-barred-spiral": g02_barred,
    "g03-flocculent-spiral": g03_flocculent,
    "g04-elliptical": g04_elliptical,
    "g05-lenticular": g05_lenticular,
    "g06-ring": g06_ring,
    "g07-irregular-dwarf": g07_irregular,
    "g08-interacting-pair": g08_interacting,
    "g09-starburst": g09_starburst,
    "g10-seyfert-spiral": g10_seyfert,
}


# --------------------------------------------------------------------------
# Deep field
# --------------------------------------------------------------------------

def angular_diameter_distance(z, om=0.3):
    """Flat ΛCDM D_A in units of c/H0 (numerical integration)."""
    zz = np.linspace(0.0, float(np.max(z)) + 1e-6, 4000)
    Ez = np.sqrt(om * (1 + zz) ** 3 + (1 - om))
    dc = np.concatenate([[0.0], np.cumsum(0.5 * (1 / Ez[1:] + 1 / Ez[:-1]) * np.diff(zz))])
    return np.interp(z, zz, dc) / (1 + z)


def deep_field(rng, n_gal=6000, n_star=2500):
    N = n_gal + n_star
    # ---- distant galaxies -------------------------------------------------
    z = np.empty(0)
    while z.size < n_gal:
        cand = rng.gamma(3.0, 0.55, 2 * n_gal)  # p(z) ∝ z² exp(−z/0.55)
        z = np.concatenate([z, cand[(cand > 0.08) & (cand < 8.0)]])
    z = np.sort(z[:n_gal])[rng.permutation(n_gal)]
    # directions: 40 % in ~70 angular groups, rest isotropic
    dirs = iso_dirs(rng, n_gal)
    ng = 70
    gdir = iso_dirs(rng, ng)
    grp = rng.random(n_gal) < 0.4
    gi = rng.integers(0, ng, n_gal)
    d2 = gdir[gi] + rng.normal(size=(n_gal, 3)) * 0.035
    d2 /= np.linalg.norm(d2, axis=1, keepdims=True)
    dirs = np.where(grp[:, None], d2, dirs)
    # group members share a redshift (± small scatter)
    zg = rng.gamma(3.0, 0.55, ng).clip(0.1, 6.0)
    z = np.where(grp, np.abs(zg[gi] + rng.normal(0, 0.02, n_gal)), z)
    shell = 0.8 + 0.2 * np.clip(np.log1p(z) / math.log(9.0), 0, 1)
    pos_g = dirs * shell[:, None]
    # morphology mix: late types / irregulars become more common with z
    u = rng.random(n_gal)
    f_irr = np.clip(0.08 + 0.1 * z, 0, 0.5)
    f_ell = np.clip(0.28 - 0.04 * z, 0.08, 0.3)
    f_s0 = 0.08
    sub = np.where(u < f_irr, 3, np.where(u < f_irr + f_ell, 1, np.where(u < f_irr + f_ell + f_s0, 2, 0)))
    # rest-frame colour temperature by type; observed ≈ T/(1+z)^0.55 (artistic
    # compromise between true redshifting T/(1+z) and a false-colour IR palette)
    Trest = np.select([sub == 0, sub == 1, sub == 2, sub == 3],
                      [rng.normal(6800, 1300, n_gal), rng.normal(4300, 250, n_gal),
                       rng.normal(4900, 300, n_gal), rng.normal(11000, 3000, n_gal)])
    Tobs = np.clip(Trest, 3000, 30000) / (1 + z) ** 0.55
    chroma = blackbody_chroma(Tobs)
    # physical half-light size evolves ~ (1+z)^-1; angular ∝ size / D_A
    Re = np.exp(rng.normal(math.log(4.0), 0.45, n_gal)) / (1 + z) ** 0.9
    Re = np.where(sub == 1, Re * 0.8, Re)
    ang = Re / angular_diameter_distance(z)
    size = np.clip(np.log(ang / np.percentile(ang, 1.0)) / np.log(np.percentile(ang, 99.8) / np.percentile(ang, 1.0)), 0, 1)
    size = 0.08 + 0.92 * size
    # brightness: log-compressed flux proxy (L ∝ Re², flux ∝ L/D_L²)
    DL = angular_diameter_distance(z) * (1 + z) ** 2
    flux = Re ** 2 / DL ** 2
    lf = np.log10(flux)
    lum_g = np.clip(0.2 + 0.8 * (lf - np.percentile(lf, 2)) / (np.percentile(lf, 99.5) - np.percentile(lf, 2)), 0.12, 1.0)
    # axis ratio: thin disks q = sqrt(q0² + (1−q0²)cos² i) with cos i ~ U(0,1)
    cosi = rng.random(n_gal)
    q = np.select([sub == 0, sub == 1, sub == 2, sub == 3],
                  [np.sqrt(0.18 ** 2 + (1 - 0.18 ** 2) * cosi ** 2), rng.uniform(0.55, 1.0, n_gal),
                   np.sqrt(0.3 ** 2 + (1 - 0.3 ** 2) * cosi ** 2), rng.uniform(0.35, 0.9, n_gal)])
    qc = np.clip(np.floor((q - 0.2) / 0.2), 0, 3).astype(np.int64)
    pa = rng.uniform(0, np.pi, n_gal)
    pac = np.clip(np.floor(pa / np.pi * 16), 0, 15).astype(np.int64)
    extra_g = sub | (qc << 2) | (pac << 4)

    # ---- foreground Milky-Way stars ----------------------------------------
    band = rng.random(n_star) < 0.55
    sinb = np.where(band, np.clip(rng.laplace(0, 0.16, n_star), -0.99, 0.99), rng.uniform(-1, 1, n_star))
    lon = rng.uniform(-np.pi, np.pi, n_star)
    cb = np.sqrt(1 - sinb ** 2)
    sdir = np.stack([cb * np.cos(lon), cb * np.sin(lon), sinb], axis=1)
    sdir = rot_x(sdir, math.radians(62.0))  # tilt the galactic plane in the sky
    pos_s = sdir * rng.uniform(0.55, 0.75, n_star)[:, None]
    # counts N(>F) ∝ F^-0.9 (flatter than Euclidean −1.5: finite disk)
    F = (1 - rng.random(n_star)) ** (-1 / 0.9)
    lF = np.log10(F)
    lum_s = np.clip(0.18 + 0.82 * lF / np.percentile(lF, 99.7), 0.12, 1.0)
    size_s = np.clip(0.1 + 0.9 * lF / np.percentile(lF, 99.9), 0.1, 1.0)
    u = rng.random(n_star)
    Ts = np.where(u < 0.7, rng.uniform(3300, 5300, n_star),
                  np.where(u < 0.95, rng.uniform(5300, 7500, n_star), np.exp(rng.uniform(math.log(7500), math.log(22000), n_star))))
    spike = np.zeros(n_star, dtype=np.int64)
    spike[np.argsort(-F, kind="stable")[:14]] = 1

    c = Cloud()
    c.add(pos_g, POP_DISTANT_GALAXY, chroma, lum_g, size, extra_g)
    c.add(pos_s, POP_FOREGROUND_STAR, blackbody_chroma(Ts), lum_s, size_s, spike)
    return c, N


# --------------------------------------------------------------------------
# Blender scene
# --------------------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "LiteverseUniverse"
    return scene


def make_mesh_object(name, data, collection):
    n = data["pos"].shape[0]
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(n)
    mesh.vertices.foreach_set("co", data["pos"].astype(np.float32).ravel())
    rgba = np.concatenate([data["rgb"], np.ones((n, 1))], axis=1).astype(np.float32)
    a = mesh.attributes.new("_color", "FLOAT_COLOR", "POINT")  # linear scene-referred sRGB primaries
    a.data.foreach_set("color", rgba.ravel())
    a = mesh.attributes.new("_size", "FLOAT", "POINT")
    a.data.foreach_set("value", data["size"].astype(np.float32))
    a = mesh.attributes.new("_population", "INT8", "POINT")
    a.data.foreach_set("value", data["pop"].astype(np.int32))
    a = mesh.attributes.new("_extra", "INT", "POINT")
    a.data.foreach_set("value", data["extra"].astype(np.int32))
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj["lv_size_scale"] = float(data["size_scale"])  # world units of size = 1.0
    collection.objects.link(obj)
    return obj


def read_mesh_object(obj):
    """Read the point cloud back from the Blender mesh attributes."""
    me = obj.data
    n = len(me.vertices)
    pos = np.empty(n * 3, dtype=np.float32)
    me.attributes["position"].data.foreach_get("vector", pos)
    col = np.empty(n * 4, dtype=np.float32)
    me.attributes["_color"].data.foreach_get("color", col)
    size = np.empty(n, dtype=np.float32)
    me.attributes["_size"].data.foreach_get("value", size)
    pop = np.empty(n, dtype=np.int32)
    me.attributes["_population"].data.foreach_get("value", pop)
    extra = np.empty(n, dtype=np.int32)
    me.attributes["_extra"].data.foreach_get("value", extra)
    return {"pos": pos.reshape(n, 3), "rgb": col.reshape(n, 4)[:, :3], "size": size, "pop": pop, "extra": extra,
            "size_scale": float(obj.get("lv_size_scale", 1.0))}


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def encode_lvpc(d):
    pos = d["pos"].astype(np.float64)
    n = pos.shape[0]
    radius = np.float32(np.linalg.norm(pos, axis=1).max())
    q = np.clip(np.rint(pos / float(radius) * 32767.0), -32767, 32767).astype("<i2")
    rec = np.zeros(n, dtype=RECORD_DTYPE)
    rec["p"] = q
    rec["rgb"] = np.rint(linear_to_srgb(d["rgb"].astype(np.float64)) * 255.0).astype(np.uint8)
    rec["size"] = np.rint(np.clip(d["size"].astype(np.float64), 0, 1) * 255.0).astype(np.uint8)
    rec["pop"] = d["pop"].astype(np.uint8)
    rec["extra"] = d["extra"].astype(np.uint8)
    header = struct.pack("<4sIIIf3f", MAGIC, FORMAT_VERSION, n, 0, float(radius), 0.0, 0.0, 0.0)
    assert len(header) == HEADER_BYTES
    return header + rec.tobytes(), float(radius), rec


def summarize(rec):
    rgb = rec["rgb"].astype(np.float64) / 255.0
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    emit = rec["pop"] != POP_DUST
    w = lin[emit].sum(axis=1, keepdims=True)
    mean = (lin[emit] * 1.0).sum(axis=0) / max(1.0, float(w.sum()))
    mean = mean / mean.max() if mean.max() > 0 else mean
    dom = [round(float(v), 4) for v in linear_to_srgb(mean)]
    pops = {}
    for code, name in POP_NAMES.items():
        cnt = int((rec["pop"] == code).sum())
        if cnt:
            pops[name] = cnt
    return dom, pops


def file_sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# --------------------------------------------------------------------------
# Previews (Cycles, CPU)
# --------------------------------------------------------------------------

def build_preview_rig(scene, samples, res):
    scene.render.engine = "CYCLES"
    cy = scene.cycles
    cy.device = "CPU"
    cy.samples = samples
    cy.use_denoising = False
    cy.use_adaptive_sampling = False
    cy.max_bounces = 0
    cy.diffuse_bounces = 0
    cy.glossy_bounces = 0
    cy.transmission_bounces = 0
    cy.volume_bounces = 0
    cy.transparent_max_bounces = 256
    cy.seed = 7
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("Black")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)
    scene.world = world
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def make_materials(emission_strength, dust_strength):
    """One point material: additive glow for stars, tinted transmission for dust.

    Stars:  Add(Transparent(white), Emission(_color · strength))  -> additive
    Dust:   Transparent(mix(white, _color, dust_strength))         -> multiplicative
    The per-point `lv_dust` mask (0/1) written by Geometry Nodes selects the branch.
    """
    mat = bpy.data.materials.new("LV_Point")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    col = nt.nodes.new("ShaderNodeAttribute")
    col.attribute_type = "GEOMETRY"
    col.attribute_name = "_color"
    mask = nt.nodes.new("ShaderNodeAttribute")
    mask.attribute_type = "GEOMETRY"
    mask.attribute_name = "lv_dust"
    em = nt.nodes.new("ShaderNodeEmission")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    add = nt.nodes.new("ShaderNodeAddShader")
    # Soft sprite: weight = (1 − facing)^3 ≈ Gaussian falloff towards the limb,
    # so overlapping points blend like the runtime's Gaussian point sprites.
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    inv = nt.nodes.new("ShaderNodeMath")
    inv.operation = "SUBTRACT"
    inv.inputs[0].default_value = 1.0
    nt.links.new(lw.outputs["Facing"], inv.inputs[1])
    powr = nt.nodes.new("ShaderNodeMath")
    powr.operation = "POWER"
    nt.links.new(inv.outputs[0], powr.inputs[0])
    powr.inputs[1].default_value = 3.0
    strength = nt.nodes.new("ShaderNodeMath")
    strength.name = "Emission"
    strength.operation = "MULTIPLY"
    strength.inputs[1].default_value = emission_strength
    nt.links.new(powr.outputs[0], strength.inputs[0])
    nt.links.new(strength.outputs[0], em.inputs["Strength"])
    nt.links.new(col.outputs["Color"], em.inputs["Color"])
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.name = "DustTint"
    mix.data_type = "RGBA"
    dfac = nt.nodes.new("ShaderNodeMath")
    dfac.operation = "MULTIPLY"
    dfac.inputs[1].default_value = dust_strength
    dpow = nt.nodes.new("ShaderNodeMath")
    dpow.operation = "POWER"
    nt.links.new(inv.outputs[0], dpow.inputs[0])
    dpow.inputs[1].default_value = 1.5
    nt.links.new(dpow.outputs[0], dfac.inputs[0])
    nt.links.new(dfac.outputs[0], mix.inputs["Factor"])
    mix.inputs["A"].default_value = (1, 1, 1, 1)
    nt.links.new(col.outputs["Color"], mix.inputs["B"])
    trd = nt.nodes.new("ShaderNodeBsdfTransparent")
    nt.links.new(mix.outputs["Result"], trd.inputs["Color"])
    ms = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(mask.outputs["Fac"], ms.inputs["Fac"])
    nt.links.new(add.outputs[0], ms.inputs[1])
    nt.links.new(trd.outputs[0], ms.inputs[2])
    nt.links.new(ms.outputs[0], out.inputs["Surface"])
    return mat


def add_points_modifier(obj, mat, star_scale, dust_scale):
    """Geometry Nodes: Mesh to Points with radius from `_size`; stores `lv_dust`."""
    ng = bpy.data.node_groups.new(f"LV_Points_{obj.name}", "GeometryNodeTree")
    ng.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    N = ng.nodes
    L = ng.links
    gi = N.new("NodeGroupInput")
    go = N.new("NodeGroupOutput")
    popn = N.new("GeometryNodeInputNamedAttribute")
    popn.data_type = "INT"
    popn.inputs["Name"].default_value = "_population"
    cmp = N.new("FunctionNodeCompare")
    cmp.data_type = "INT"
    cmp.operation = "EQUAL"
    ints = [s for s in cmp.inputs if s.type == "INT" and s.enabled]
    L.new(popn.outputs["Attribute"], ints[0])
    ints[1].default_value = POP_DUST
    sz = N.new("GeometryNodeInputNamedAttribute")
    sz.data_type = "FLOAT"
    sz.inputs["Name"].default_value = "_size"
    # radius = (size + 0.02) * (dust ? dust_scale : star_scale)
    scale = N.new("GeometryNodeSwitch")
    scale.input_type = "FLOAT"
    L.new(cmp.outputs[0], scale.inputs["Switch"])
    scale.inputs["False"].default_value = star_scale
    scale.inputs["True"].default_value = dust_scale
    addc = N.new("ShaderNodeMath")
    addc.operation = "ADD"
    L.new(sz.outputs["Attribute"], addc.inputs[0])
    addc.inputs[1].default_value = 0.02
    mul = N.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    L.new(addc.outputs[0], mul.inputs[0])
    L.new(scale.outputs[0], mul.inputs[1])
    store = N.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT"
    store.domain = "POINT"
    store.inputs["Name"].default_value = "lv_dust"
    L.new(gi.outputs[0], store.inputs["Geometry"])
    L.new(cmp.outputs[0], store.inputs["Value"])
    m2p = N.new("GeometryNodeMeshToPoints")
    m2p.mode = "VERTICES"
    L.new(store.outputs["Geometry"], m2p.inputs["Mesh"])
    L.new(mul.outputs[0], m2p.inputs["Radius"])
    sm = N.new("GeometryNodeSetMaterial")
    sm.inputs["Material"].default_value = mat
    L.new(m2p.outputs["Points"], sm.inputs["Geometry"])
    L.new(sm.outputs["Geometry"], go.inputs[0])
    mod = obj.modifiers.new("LV_Points", "NODES")
    mod.node_group = ng
    return mod


def aim_camera(cam, loc, target=(0, 0, 0)):
    from mathutils import Vector
    cam.location = Vector(loc)
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def render_to_array(scene, path):
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(str(path))
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[:, :, :3]  # bottom-up rows, display-encoded


def save_rgb(arr, path, quality=85):
    h, w, _ = arr.shape
    img = bpy.data.images.new(Path(path).stem, width=w, height=h, alpha=False)
    rgba = np.concatenate([np.clip(arr, 0, 1), np.ones((h, w, 1), dtype=np.float32)], axis=2)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.filepath_raw = str(path)
    img.file_format = "JPEG"
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = quality
    scene.render.image_settings.color_mode = "RGB"
    img.save_render(str(path), scene=scene)
    scene.render.image_settings.file_format = "PNG"
    bpy.data.images.remove(img)


FRAMING = {"g04-elliptical": 96.0, "g05-lenticular": 98.0}
STAR_K, DUST_K = 1.0, 1.0  # sprite radius = size × sizeScale × K (world units)


def render_previews(scene, objects, preview_dir, samples, res, tmp, gain):
    preview_dir.mkdir(parents=True, exist_ok=True)
    cam = build_preview_rig(scene, samples, res)
    mat = make_materials(1.0, 1.0)  # dust: transmission = mix(white, rgb, falloff)
    emission = mat.node_tree.nodes["Emission"].inputs[1]
    pairs = []
    t0 = time.time()
    for gid, obj in objects:
        d = read_mesh_object(obj)
        R = np.linalg.norm(d["pos"][:, [0, 2]], axis=1)
        R_view = float(np.percentile(R, FRAMING.get(gid, 99.3))) * 1.08
        px = 2 * R_view / res  # world units per pixel
        S = d["size_scale"]
        add_points_modifier(obj, mat, star_scale=S * STAR_K, dust_scale=S * DUST_K)
        # Normalise emission by total emitting cross-section so previews of
        # different archetypes share a comparable exposure.
        emit = d["pop"] != POP_DUST
        r_px = (d["size"][emit] + 0.02) * S * STAR_K / px
        flux = float((np.pi * r_px ** 2 * d["rgb"][emit].mean(axis=1)).sum())
        emission.default_value = gain * res * res / max(flux, 1e-6) * 0.06 * 4.0
        for o in scene.objects:
            if o.type == "MESH":
                o.hide_render = o is not obj
        frames = []
        for view, inc in (("face", 0.0), ("tilt", 60.0)):
            cam.data.ortho_scale = 2 * R_view
            D = 10 * R_view
            cam.data.clip_start = 0.1
            cam.data.clip_end = 30 * R_view
            i = math.radians(inc)
            # Galaxy frame: disk in x–z, y up. Blender axes are used verbatim.
            aim_camera(cam, (0.0, D * math.cos(i), -D * math.sin(i)))
            frames.append(render_to_array(scene, Path(tmp) / f"{gid}-{view}.png"))
        pair = np.concatenate(frames, axis=1)
        save_rgb(pair, preview_dir / f"{gid}.jpg")
        pairs.append(pair)
        obj.hide_render = True
        print(f"[preview] {gid} {time.time() - t0:.1f}s", flush=True)
    # contact sheet: 2 columns x 5 rows of (face|tilt) pairs, 2x downsampled
    if len(pairs) == len(ARCHETYPES):
        small = [p.reshape(p.shape[0] // 2, 2, p.shape[1] // 2, 2, 3).mean(axis=(1, 3)) for p in pairs]
        rows = [np.concatenate(small[r * 2:(r + 1) * 2], axis=1) for r in range(5)]
        sheet = np.concatenate(rows[::-1], axis=0)  # pixel rows are bottom-up
        save_rgb(sheet, preview_dir / "contact-sheet.jpg", quality=82)
    return mat


def render_deep_field_preview(scene, obj, mat, preview_dir, tmp):
    from mathutils import Vector
    for o in scene.objects:
        if o.type == "MESH":
            o.hide_render = o is not obj
    add_points_modifier(obj, mat, star_scale=0.0011, dust_scale=0.001)
    mat.node_tree.nodes["Emission"].inputs[1].default_value = 8.0
    cam = scene.camera
    cam.data.type = "PERSP"
    cam.data.lens = 24
    cam.data.clip_start = 0.01
    cam.data.clip_end = 10
    cam.location = Vector((0, 0, 0))
    cam.rotation_euler = Vector((0.2, 1.0, 0.1)).to_track_quat("-Z", "Y").to_euler()
    scene.render.resolution_x = 640
    scene.render.resolution_y = 400
    arr = render_to_array(scene, Path(tmp) / "deep-field.png")
    save_rgb(arr, preview_dir / "deep-field.jpg", quality=82)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--points", type=int, default=DEFAULT_POINTS)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory (public/universe)")
    ap.add_argument("--preview", action="store_true", help="render Cycles previews")
    ap.add_argument("--preview-dir", type=Path, default=DEFAULT_PREVIEWS)
    ap.add_argument("--preview-samples", type=int, default=16)
    ap.add_argument("--preview-size", type=int, default=384)
    ap.add_argument("--preview-gain", type=float, default=2.5, help="preview exposure multiplier")
    ap.add_argument("--save-blend", action="store_true", help="save tools/blender/out/universe.blend")
    ap.add_argument("--check", action="store_true",
                    help="regenerate into a temp dir and compare with the committed manifest")
    ap.add_argument("--only", default="", help="comma-separated archetype ids (implies --no-export)")
    ap.add_argument("--no-export", action="store_true")
    return ap.parse_args(argv)


def build(args, out_dir, export=True):
    t0 = time.time()
    scene = reset_scene()
    only = [s for s in args.only.split(",") if s]
    objects = []
    for idx, (gid, name, morph) in enumerate(ARCHETYPES):
        if only and gid not in only:
            continue
        rng = np.random.default_rng(np.random.SeedSequence([args.seed, idx + 1]))
        cloud = BUILDERS[gid](rng, args.points)
        data = cloud.finish(rng, args.points)
        coll = bpy.data.collections.new(gid)
        scene.collection.children.link(coll)
        obj = make_mesh_object(gid, data, coll)
        objects.append((gid, obj))
        print(f"[build] {gid}: {args.points} pts ({time.time() - t0:.1f}s)", flush=True)
    df_obj = None
    if not only:
        rng = np.random.default_rng(np.random.SeedSequence([args.seed, 1000]))
        cloud, n = deep_field(rng)
        data = cloud.finish(rng, n, adaptive=False)
        coll = bpy.data.collections.new("deep-field")
        scene.collection.children.link(coll)
        df_obj = make_mesh_object("deep-field", data, coll)

    manifest = None
    if export:
        (out_dir / "galaxies").mkdir(parents=True, exist_ok=True)
        galaxies = []
        for (gid, obj), (_, name, morph) in zip(objects, ARCHETYPES):
            blob, radius, rec = encode_lvpc(read_mesh_object(obj))
            rel = f"galaxies/{gid}.lvpc"
            (out_dir / rel).write_bytes(blob)
            dom, pops = summarize(rec)
            galaxies.append({
                "id": gid, "name": name, "morphology": morph, "pointCount": int(rec.shape[0]),
                "radius": radius, "byteLength": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                "file": rel, "dominantColor": dom, "populations": pops,
            })
        blob, radius, rec = encode_lvpc(read_mesh_object(df_obj))
        (out_dir / "deep-field.lvpc").write_bytes(blob)
        dom, pops = summarize(rec)
        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "generator": {
                "tool": "tools/blender/build_universe_assets.py",
                "scriptSha256": file_sha(SCRIPT_PATH),
                "blenderVersion": bpy.app.version_string,
                "seed": args.seed,
                "points": args.points,
            },
            "format": {"magic": "LVPC", "version": FORMAT_VERSION, "headerBytes": HEADER_BYTES,
                       "recordBytes": RECORD_DTYPE.itemsize, "color": "sRGB-encoded u8",
                       "axes": "disk in x-z plane, +y up; rotation positive about +y makes arms trail"},
            "galaxies": galaxies,
            "deepField": {
                "id": "deep-field", "name": "Deep field", "morphology": "distant galaxies + foreground stars",
                "pointCount": int(rec.shape[0]), "radius": radius, "byteLength": len(blob),
                "sha256": hashlib.sha256(blob).hexdigest(), "file": "deep-field.lvpc",
                "dominantColor": dom, "populations": pops,
            },
        }
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"[build] done in {time.time() - t0:.1f}s", flush=True)
    return scene, objects, df_obj, manifest


def main():
    args = parse_args()
    t_start = time.time()
    if args.check:
        committed = json.loads((args.out / "manifest.json").read_text())
        args.seed = committed["generator"]["seed"]
        args.points = committed["generator"]["points"]
        with tempfile.TemporaryDirectory() as tmp:
            _, _, _, man = build(args, Path(tmp))
            problems = []
            new_text = (Path(tmp) / "manifest.json").read_text()
            if new_text != (args.out / "manifest.json").read_text():
                for key in ("generator",):
                    if man[key] != committed.get(key):
                        problems.append(f"manifest.{key} differs: {committed.get(key)} -> {man[key]}")
            for entry in man["galaxies"] + [man["deepField"]]:
                f = args.out / entry["file"]
                if not f.exists():
                    problems.append(f"missing {f}")
                    continue
                got = file_sha(f)
                if got != entry["sha256"]:
                    problems.append(f"{entry['file']}: committed {got[:12]} != regenerated {entry['sha256'][:12]}")
            if new_text != (args.out / "manifest.json").read_text() and not problems:
                problems.append("manifest.json text differs from the regenerated manifest")
        if problems:
            print("[check] FAILED\n  " + "\n  ".join(problems), file=sys.stderr)
            sys.exit(1)
        print(f"[check] OK: all assets byte-identical ({time.time() - t_start:.1f}s)")
        return

    export = not (args.no_export or args.only)
    scene, objects, df_obj, _ = build(args, args.out, export=export)
    if args.save_blend:
        DEFAULT_BLEND_DIR.mkdir(parents=True, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=str(DEFAULT_BLEND_DIR / "universe.blend"), compress=True)
    if args.preview:
        with tempfile.TemporaryDirectory() as tmp:
            mat = render_previews(scene, objects, args.preview_dir, args.preview_samples, args.preview_size, tmp,
                                  args.preview_gain)
            if df_obj is not None:
                render_deep_field_preview(scene, df_obj, mat, args.preview_dir, tmp)
    print(f"[total] {time.time() - t_start:.1f}s")


if __name__ == "__main__":
    main()
