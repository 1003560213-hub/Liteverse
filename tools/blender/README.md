# Deep Universe assets (Blender pipeline)

`build_universe_assets.py` generates the 3D point-cloud assets for the
Liteverse universe view (plan §5.2): ten galaxy archetypes and one deep-field
background catalogue. Everything is procedural, seeded and byte-reproducible;
no third-party textures, HDRIs or photographs are used.

```
public/universe/manifest.json
public/universe/galaxies/<id>.lvpc      # 10 × 40,000 points, 480,032 B each
public/universe/deep-field.lvpc         # 6,000 distant galaxies + 2,500 stars
tools/blender/previews/*.jpg            # Cycles review renders (committed, small)
tools/blender/out/universe.blend        # optional, git-ignored
```

## Running

The script runs in real Blender (pin: **Blender 4.5 LTS**) or with the `bpy`
wheel. Arguments after `--` are used when present, otherwise `sys.argv[1:]`.

```bash
blender --background --factory-startup \
  --python tools/blender/build_universe_assets.py -- [args]
python tools/blender/build_universe_assets.py [args]        # bpy 4.5 module
```

| flag | default | meaning |
| --- | --- | --- |
| `--seed N` | 1729 | master seed; archetype *i* uses `SeedSequence([seed, i])`, the deep field `[seed, 1000]` |
| `--points N` | 40000 | points per galaxy |
| `--out DIR` | `public/universe` | export directory |
| `--preview` | off | Cycles CPU previews into `tools/blender/previews/` |
| `--preview-samples` / `--preview-size` / `--preview-gain` | 16 / 384 / 2.5 | preview quality and exposure |
| `--save-blend` | off | save `tools/blender/out/universe.blend` |
| `--check` | off | rebuild into a temp dir using the committed manifest's seed/points and compare every hash and the manifest text; exits 1 on mismatch |
| `--only id,id` | – | build a subset (use `deep-field` for the background); implies no export |
| `--no-export` | off | build and preview only |

Timings on a 4-core Linux container (bpy 4.5.0): build + export ≈ 8 s
(most of it is the k-nearest-neighbour pass), `--check` ≈ 8 s, previews ≈ 5 min
(the elliptical alone takes about 2 min because of deep sprite overdraw).

## Pipeline

1. numpy generates each cloud (positions, linear colour, size, population,
   component) from the models below, then shuffles it with the same RNG so any
   prefix is a uniform subsample (the runtime draws the first *N* points as a
   lower LOD).
2. Each cloud becomes a vertex-only mesh in its own collection with the
   attributes `_color` (`FLOAT_COLOR`, linear sRGB primaries), `_size`
   (`FLOAT`), `_population` (`INT8`) and `_extra` (`INT`), plus the object
   property `lv_size_scale`.
3. **Export reads the clouds back from `obj.data.attributes`** (`position`,
   `_color`, …). The Blender scene is the source of truth for the bytes.
4. With `--preview`, a Geometry Nodes modifier (Named Attribute →
   Mesh to Points, radius = (`_size` + 0.02) · sizeScale; Store Named Attribute
   `lv_dust`) and one material render the points in Cycles. Stars use
   Add(Transparent, Emission(`_color`)) with a soft (1 − facing)³ limb falloff,
   which blends additively like Gaussian sprites. Dust uses a Transparent BSDF
   tinted by `_color`, which multiplies the light behind it. Each archetype is
   rendered face-on and at 60° inclination in an orthographic view (384 × 384,
   16 spp, AgX). Exposure comes from the 99th percentile of a face-on flux map.

## `.lvpc` binary format (version 1, little-endian)

| offset | type | field |
| --- | --- | --- |
| 0 | `char[4]` | magic `"LVPC"` |
| 4 | `u32` | version = 1 |
| 8 | `u32` | pointCount |
| 12 | `u32` | flags = 0 |
| 16 | `f32` | radius = max ‖p‖ over all points, before quantisation |
| 20 | `f32[3]` | reserved = 0 |
| 32 | record × pointCount | 12 bytes each |

Record (12 bytes, no padding):

| offset | type | field |
| --- | --- | --- |
| 0 | `i16[3]` | x, y, z = round(p / radius · 32767), clamped to ±32767; decode p = q / 32767 · radius |
| 6 | `u8[3]` | r, g, b, **sRGB-encoded** (the standard piecewise sRGB transfer function applied to linear values) |
| 9 | `u8` | size: sprite radius = size / 255 · `sizeScale` · radius (`sizeScale` is in the manifest) |
| 10 | `u8` | population |
| 11 | `u8` | extra |

The file length is always 32 + 12 · pointCount bytes.

Populations: `0` old stars, `1` disk (intermediate age), `2` young OB stars,
`3` HII / ionised gas, `4` dust, `5` nucleus / AGN, `6` distant galaxy
(deep field only), `7` foreground star (deep field only).

Colour semantics:

- **Emitters** (all populations except 4): the additive sprite colour. It
  already includes the population luminosity and the flux compensation
  described below, so a runtime should draw a Gaussian sprite with peak =
  colour, using additive blending.
- **Dust** (population 4): the transmission at the sprite centre, where 1 means
  clear. The darkening pass multiplies the framebuffer by
  `mix(1, rgb, gaussian(r))`.

Extra byte:

- Galaxies: structural component. `0` disk, `1` bulge/nucleus, `2` bar,
  `3` spiral arm, `4` ring, `5` tidal/outflow/ionisation cone, `6` companion
  galaxy (g08), `7` globular-cluster halo.
- Distant galaxies (population 6): bits 0–1 are the sub-type (`0` spiral,
  `1` elliptical, `2` lenticular, `3` irregular). Bits 2–3 are the axis-ratio
  class, with q ≈ 0.3 / 0.5 / 0.7 / 0.9. Bits 4–7 are the position angle k,
  where PA = k · 180°/16.
- Foreground stars (population 7): bit 0 marks diffraction spikes. The 14
  brightest stars carry it.

Coordinates: galaxy disks lie in the **x–z plane with +y up**. Units are
nominally kpc before normalisation. The azimuth is θ = atan2(z, x). Arms
follow r = a·e^{b(θ−φ)} and wind outward with increasing θ, so a **positive
rotation about +y** (which decreases θ) makes them trail. Use that sense for the
Ω(R) ≈ v₀/√(R² + R_c²) shader rotation. The cylindrical radius is
√(x² + z²). The pair's companion (extra = 6) is off-centre, so rotate it
rigidly or not at all. The deep field is a unit-radius shell: stars occupy
0.55–0.75 and galaxies 0.8–1.0, where radius grows with the redshift proxy.

## Manifest (`public/universe/manifest.json`)

`schemaVersion` is `liteverse-universe-assets-v1`. `generator` holds
`{tool, scriptSha256, blenderVersion, seed, points}`, and `format` holds a
self-description of the fields above. Each `galaxies[]` entry and `deepField`
has these fields: `id`, `name`, `morphology`, `pointCount`, `radius`,
`sizeScale`, `byteLength`, `sha256`, `file`, `dominantColor`, and
`populations` (counts by name). `dominantColor` is the flux-weighted mean
emitter colour, normalised to a maximum channel of 1 and sRGB-encoded in
[0, 1].

The output is 4,910,283 bytes in total (budget ≤ 6 MB). `--check` and
`tests/universe-assets.test.mjs` enforce this budget.

## Physical model

Formulas and parameters, with what is physically motivated and what is
artistic.

### Profiles (physically motivated)

- **Exponential disk**: Σ(R) ∝ exp(−R/R_d). Radii are drawn exactly as
  R ~ Gamma(k = 2, θ = R_d), because p(R) ∝ R·Σ(R), truncated at R_max.
- **Vertical profile**: ρ(z) ∝ sech²(z/z₀), sampled as z = z₀·artanh(2u − 1).
  Stellar disks have z₀ = h_z ≈ 0.07 R_d (0.22–0.24 kpc for R_d ≈ 3 kpc), with
  mild flaring z₀·(1 + 0.6 R/R_max). Young stars use 0.35 h_z and dust
  0.25–0.3 h_z.
- **Sérsic bulge** via the Prugniel–Simien deprojection:
  ρ(r) ∝ (r/R_e)^{−p} exp(−b (r/R_e)^{1/n}), with p = 1 − 0.6097/n + 0.05463/n²
  and b = 2n − 1/3 + 0.009876/n. Substituting t = b (r/R_e)^{1/n} makes the
  enclosed mass a Gamma(n(3 − p)) variable, so r = R_e (t/b)^n exactly.
  Directions are isotropic, then scaled by the axis ratios.
  - Elliptical (g04): n = 4, R_e = 3 kpc, triaxial axes 1 : 0.62 (y) : 0.8 (z).
    Its colour gradient is T = 4250 + 260·log₁₀(1 + 3r/R_e) K ± 220 K. It also
    has a 2 % globular-cluster halo (n = 2, R_e = 7.5 kpc).
  - Lenticular (g05): n = 3, R_e = 1.3 kpc, oblate 0.62. The thick disk has
    R_d = 2.6 kpc and z₀ = 0.32 kpc, and there is a lens plateau (R < 4.2 kpc)
    and a thin inner dust ring at R ≈ 2.6 kpc.
  - Spiral pseudo-bulges: n = 1.5–2.0, R_e = 0.7–0.9 kpc, vertical flattening
    0.7–0.8.
- **Logarithmic spiral arms**: r = a·exp(b(θ − φ)) with b = tan(pitch).
  | archetype | arms | pitch | a (kpc) | R range (kpc) |
  | --- | --- | --- | --- | --- |
  | g01 grand-design | 2 | 15° | 1.2 | 1.3–14 |
  | g02 barred | 2, from the bar ends | 16° | 4.2 (= bar a) | 4.2–14 |
  | g03 flocculent | 34 short segments | 18–28° | random | R₀ ∈ [1.5, 10], Δθ ∈ [0.5, 1.3] rad |
  | g08 primary / companion | 2 / 2 | 15° / 22° | 1.5 / 0.8 | 1.7–11.5 / 0.9–3.6 |
  | g10 Seyfert | 2 | 17° | 1.9 | 1.9–13 |
  - Arm points follow a linear density ∝ exp(−R/R_arm), with R_arm = 4–5 kpc.
  - Their perpendicular scatter is σ(R) = 0.45 + 0.065–0.07 R kpc (flocculent:
    0.3 + 0.04 R).
  - The disk population is modulated as a density wave by rejection with weight
    1 + A·min(Σ_k exp(−d_k²/2(1.8σ)²), 1.5). Here d_k is the azimuthal
    distance to arm k, and A = 1.6–2.0.
- **Stream ordering across an arm** (density-wave shock picture). Dust lanes
  sit on the concave (inner, +Δθ) edge, offset by 0.45 + 0.05 R kpc. Young
  complexes sit about 0.15–0.2 kpc downstream (−Δθ), and HII knots a further
  0.15 kpc. 70 % of the dust is in lanes and 30 % in an arm-modulated midplane
  layer (R_d,dust = 1.1 R_d).
- **Bar**: a Ferrers ellipsoid ρ ∝ (1 − m²)², with m² = x²/a² + z²/b² + y²/c².
  For g02, a = 4.2, b = 1.35 and c = 0.5 kpc. Straight dust lanes lie on the
  leading (−θ) edges of the bar, offset 0.55–0.8 b.
- **Collisional ring** (g06, Cartwheel-like):
  - The ring has R = 10 kpc, an m = 3 ripple of 6 % and an axis ratio of 0.86.
    Its profile is asymmetric: a sharp outer front (σ = 0.55 w) and a softer
    trailing side (σ = 1.3 w).
  - The ring holds young stars, HII knots and dust on its inner side. Its
    brightness varies as 0.55 + 0.45 cos(θ − 2.2).
  - The nucleus is offset to (−3, 0, −1.2) kpc and surrounded by an old inner
    ring at 2.6 kpc.
  - 14 diffuse spokes run between the two rings.
- **Irregular dwarf** (g07, Magellanic):
  - An exponential old component (R_d = 1.2 kpc, thick, q = 0.72).
  - An off-centre Ferrers bar (2.2 × 0.6 kpc).
  - 26 star-forming complexes with Pareto(1.3) weights. HII sits in shells
    around them, like 30 Doradus.
- **Interacting pair** (g08, M51-like):
  - The primary is a two-armed spiral.
  - The companion is a bulge-dominated disk inclined 58° and placed about
    15 kpc away, 1.6 kpc below the plane.
  - A quadratic-Bézier bridge runs from the end of arm 0 to the companion.
  - A long tidal tail continues arm 1, with R growing from 11.5 to 24 kpc over
    Δθ = 1.9 rad. It warps vertically as 4.5 s² kpc and carries 9 tidal-dwarf
    clumps.
- **Starburst** (g09, M82-like):
  - A compact disk (R_d = 1.3 kpc) with 45 super star clusters within about
    1 kpc.
  - Random-walk dust filaments.
  - A bipolar Hα superwind along ±y: 70 filaments in cones up to about 32°
    half-opening, extending to 6.8 kpc, with brightness ∝ exp(−h/3 kpc).
- **Seyfert** (g10, NGC 1068-like):
  - A spiral with a starburst pseudo-ring at 1.6 kpc.
  - An unresolved nucleus drawn from a Cauchy (Lorentzian) radial profile with
    scale 15 pc, capped at 0.6 kpc, and 3.5 % of the points. Its continuum
    temperature is 15–35 kK.
  - An [OIII] ionisation bicone (half-opening ≤ 22°, axis tilted 35° from the
    disk normal).

### Colours

The colour model mixes physical approximations with artistic choices.

- **Blackbody → sRGB (physically motivated).** The Planck spectrum
  B(λ, T) ∝ λ⁻⁵ / (exp(hc/λkT) − 1) is integrated over 380–780 nm against the
  CIE 1931 2° colour-matching functions. The CMFs use the analytic multi-lobe
  fit of Wyman, Sloan & Shirley (2013, JCGT 2(2)).
  - XYZ is converted to linear sRGB (D65) with the standard matrix.
  - Out-of-gamut values are pulled in by adding white (−min channel), then
    normalised to a maximum channel of 1.
  - A 1,024-entry log-T lookup table covers 1,000–40,000 K.
- **Population temperatures (artistic approximation of integrated colours; not
  spectral synthesis).** Each point stands for an unresolved stellar
  population, and T is only a colour proxy.
  | population | temperature |
  | --- | --- |
  | old bulge / elliptical | ≈ 3,300–5,600 K (mean 4,300–4,900 K), with a redder centre |
  | disk | 5,100 + 1,300 R/R_max ± 500 K (bluer outward) |
  | young | log-uniform 9,000–26,000 K (starburst 12,000–35,000 K) |
  | nuclei | 4,400–5,200 K; the AGN is 15,000–35,000 K |
- **HII regions.** Emission lines use case-B Balmer ratios: Hα/Hβ = 2.86,
  Hγ/Hβ = 0.47, [NII] 0.9, [SII] 0.55 and [OIII] 1.47.
  - The lines are integrated through idealised top-hat B/G/R filters
    (400–500 / 500–600 / 600–700 nm), mixed with 10 % of a 20,000 K continuum,
    to give linear (1.0, 0.30, 0.51), which is pink.
  - This mimics broadband and narrowband composites (Hubble/JWST press images).
    The human-eye CIE colour of the same spectrum is a pale violet-teal.
  - The Seyfert narrow-line region uses [OIII]/Hβ = 10 through the same
    filters, desaturated 50 %.
- **Dust.** The transmission tint is (0.42, 0.27, 0.16) × U(0.85, 1.15), which
  reddens because blue is absorbed most. The opacity per sprite is
  0.55·(s̃_dust/size)², clipped to [0.03, 0.7]. This keeps column density
  independent of sampling density.
- **Luminosity weights per point.** Old stars get 0.35–0.75, disk 0.3–0.6,
  young stars 0.4–0.9 with a Salpeter-like (α = 2.35) power-law tail, and HII
  0.6–1.0.

### Sprite sizes and flux (rendering-motivated)

With only 40,000 points, fixed-size sprites look like confetti. As in SPH
rendering, each point gets a smoothing length h_i, the distance to its 32nd
nearest neighbour (mathutils KD-tree, 3D).

- size = clip(h_i·(0.5 + jitter) / S, floor, 1), where
  S = the 99.5th percentile of that quantity (stored as `sizeScale` = S/radius)
  and floor = the 3rd percentile.
- To keep sprite flux (peak × area) proportional to luminosity, emitter colour
  is multiplied by (s̃/size)^1.8, where s̃ is the median emitter size.
  Exact conservation would use an exponent of 2. The 1.8 is an artistic choice
  that lifts faint outer disks.
- Colours are then normalised so the 99.7th percentile maximum channel is 1.

### Deep field

- **Distant galaxies (6,000).**
  - Redshift proxy z ~ Gamma(3, 0.55), limited to 0.08 < z < 8.
  - 40 % sit in 70 angular groups (σ ≈ 2°) that share a group redshift.
  - The sub-type mix evolves with z: irregulars 0.08 + 0.1z (≤ 0.5),
    ellipticals 0.28 − 0.04z (≥ 0.08), lenticulars 8 %, and the rest spirals.
  - Half-light size is Re ~ LogNormal(4 kpc, 0.45)·(1 + z)^−0.9. Apparent size
    ∝ Re / D_A(z), with D_A from numerical flat ΛCDM (Ω_m = 0.3). The size byte
    is log-scaled between the 1st and 99.8th percentiles.
  - Brightness is a log-compressed proxy of Re²/D_L².
  - Spirals and S0s have axis ratio q = √(q₀² + (1 − q₀²) cos² i), with cos i
    uniform and q₀ = 0.18 or 0.3. Ellipticals use q ~ U(0.55, 1).
  - Colour is a blackbody at T_rest/(1 + z)^0.55. A true redshifted blackbody
    would follow T/(1 + z); the softer exponent is an artistic compromise with
    IR false-colour palettes, so high-z galaxies read redder and smaller.
- **Foreground stars (2,500).**
  - 55 % lie in a Galactic band (sin b ~ Laplace(0.16)), tilted 62° on the sky;
    the rest are isotropic.
  - Counts follow N(>F) ∝ F^−0.9, flatter than Euclidean −1.5 because the
    Galactic disk is finite.
  - Temperatures: 70 % 3,300–5,300 K, 25 % 5,300–7,500 K, and 5 %
    7,500–22,000 K.
  - The 14 brightest stars are flagged for diffraction spikes.

## Determinism

The same seed, numpy build and Blender version give byte-identical output.
Blender stores float32, so the exported bytes are what the mesh attributes hold.
`--check` verifies all 11 binaries and the manifest (which includes the script
SHA-256, so editing the script without regenerating fails the check).

Transcendental functions in numpy (exp, log, sin) can differ by 1 ulp between
CPU/SIMD builds. That can flip a rare quantised value on another machine, so
regenerate and commit from one pinned environment.

## Known preview quirks (Cycles)

- Point clouds render as spheres. Soft sprites are emulated with a
  (1 − facing)³ emission falloff, and a sphere contributes twice (front and
  back surfaces).
- Additive overdraw needs deep transparency. Too few transparent bounces
  silently terminate rays in dense cores, which showed up as dark bulges and a
  black starburst core. The rig uses `transparent_max_bounces = 256`, which
  makes the elliptical slow (about 2 min).
- Deep-field galaxies render as round sprites in the preview; the ellipse
  (axis ratio / PA) data is only used by the runtime.
- The previews are review aids (≤ 75 KB JPEG each, about 0.35 MB in total) and
  are not shipped with the app.
