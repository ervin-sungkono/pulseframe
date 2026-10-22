# Music-video polish: Liquid Blob and Spectral Terrain

## Goal and scope

Improve musical phrasing, shape continuity and visual depth in the existing
Canvas 2D styles. The desired direction is a soft, shaded gel silhouette for
Fluid Dreams and an atmospheric neon landscape for Neon Horizon. Keep enough
negative space for artwork, track text and subtitles. Success is perceptual
quality plus reliable playback/export, not an inflated production-readiness score.

Implement on PR #18. Preserve the six mode IDs, one built-in look per style,
personal looks, option schemas and project/preset versions. No DSP rewrite,
graphics dependency, 3D engine, camera controls, autonomous active blob rotation,
new customization panel, or encoding changes are required.

## 1. Shared musical response

Files: `app/lib/visual/styles/audio-response.ts`, `types.ts`,
`frequency-history.ts`, `app/lib/export/export-timeline.ts`.

- Wrap the existing calibrated frequency history for Blob and Terrain only.
  Ring, Spectrum, Edges and Radial retain their current audio mapping.
- Preserve the current causal attack interpolation; do not add another slow
  attack filter. Use a bounded peak-release envelope so bass has weight after
  a hit, mids settle sooner, and treble remains articulate. Initial release
  constants are approximately 180/125/75 ms, with a smooth frequency transition.
- Reconstruct release from measured source history over at most 900 ms. Use a
  continuous finite decay kernel that reaches zero at the window boundary,
  avoiding a new stepping artifact when an old sample leaves the window.
- Query only at or before the requested source timestamp. Missing current
  measurements return unavailable; missing earlier history adds no invented
  signal. Silent input remains silent, while a real preceding hit can settle.
- Bound converted and response caches; reuse scratch arrays and weakly own the
  source. Invalidate after live-history replacement/discontinuities and quiet
  threshold changes. Never make the result depend on draw order or FPS.
- Add the response lookback to maximum-depth terrain export preroll, retaining
  the existing analysis-grid alignment and original-style export behavior.

Acceptance: prompt rising response, slower bass than treble release, no negative
or nonfinite amplitudes, continuous window boundaries, silence/unknown handling,
bounded caches across five-minute input, live reset, and full-vs-clipped equality.

## 2. Connected Liquid Blob

Files: `app/lib/visual/styles/liquid-blob.ts`, `fluid-geometry.ts`,
`app/tests/blob-style.test.mjs`.

- Use a 2D implicit field built from a core and three overlapping anisotropic
  masses. Allow concavity, necks, elongation and independent lobe directions;
  avoid a circular-radius constraint or a rigid rotating three-arm template.
- Drive mass placement/size from current relative regional power, centroids,
  spread and contrast, with shared response settling and at most 180 ms of raw
  measured lookback. Bass/impact provide bounded expansion. Do not introduce
  autonomous active clock motion, another FFT or previous-frame-only simulation.
- Keep a bounded reusable 48/64/80-cell grid, deterministic marching-squares
  ambiguity resolution and center-connected outer contour. Fit the field bounds
  around the actual masses so minimum-size/low-detail necks remain resolved.
  Keep each mass overlapping the core, including single-tone extremes.
- Resample by arc length into the existing 96/128/160-point contract and use the
  shared closed curve. Normalize the whole silhouette inside a 43% short-edge
  radius with bounded center movement. Silence and zero deformation are circles;
  quiet asymmetric audio must join that limit continuously. Idle motion only
  breathes the circle and respects reduced motion.
- Preserve all existing controls. Use a safe expressive deformation mapping so
  the shipped default responds to broad music, rather than only high-control
  narrow tones. Shade and highlight inside the actual contour; Internal Glow
  controls the optional wash/rim. Avoid detached highlights and opaque patches.
- Reuse geometry/field/edge buffers. Do not add a physical fluid solver, graphics
  dependency, camera controller or separate export rendering path.

Acceptance: broad and narrow spectra reshape the connected mass with beat held
constant; sustained music produces visibly different forms; silence settles;
fixed input holds its active pose. Test finite/nonintersecting bounds, independent
contour-distance descriptors, near-zero continuity, the reproduced low-detail
frequency sweep, source-time/FPS equality and preview/clipped-export agreement.

## 3. Atmospheric Spectral Terrain

Files: `app/lib/visual/styles/spectral-terrain.ts`,
`app/tests/terrain-style.test.mjs`.

- Feed measured height rows through the same response adapter. Keep source-time
  anchored rows, moving projected depths, exact seek reconstruction and the
  existing boundary-line fades and depth-aware travel highlight.
- Smooth visible frequency contours with bounded curves or filtering that
  retains distinguishable bass/mid/treble peaks and does not overshoot. Surface
  edges and wire contours must agree rather than draw competing silhouettes.
- Add distance cues: reduce distant contrast/detail, emphasize nearer ridges,
  and use restrained depth/height shading for the optional surface fill. Apply
  continuous fading rather than opacity buckets that pop as rows move.
- Keep the view stable. Do not change historical timing to make Travel Speed
  appear faster. Surface Fill zero must remove fills; Wireframe Opacity zero
  must remove wires. Grid density remains bounded at 32×24, 48×40 and 64×64.
- Batch painting where possible, avoid per-vertex gradients and limit shadow
  passes. Profile before accepting more draw calls.

Acceptance: readable depth without a wall of equally bright lines; rounded but
frequency-specific ridges; no returning jitter at rollover; stable pause/seek;
transparent backgrounds and portrait/square framing remain usable.

## 4. Art direction and existing controls

Files: `app/lib/visual/customizer-config.ts`, existing Customizer hints if needed.

- Keep six stable built-in IDs, one per style. Tune Fluid Dreams for expressive
  deformation, clipped shading and restrained lighting; keep Neon Horizon's
  clean background and readable depth.
- Enable particles in every built-in look, using deliberate counts of 24–40.
  Preserve personal-look snapshots and existing reset/undo/serialization rules.
- Fit Edge Bars gradients to each visible bar with the accent at 55% of its
  length, preserving audio/layout calculations. Reuse one unit-height gradient
  per frame through the paint transform, keeping path geometry in canvas units.
  Verify quiet/loud colors, rounded corners and performance rather than adding
  per-bar gradient allocation or an image cache.
- Reuse the existing controls; add no low-level mathematical settings.

## 5. Verification and release gates

1. Unit/behavior checks: envelope causality and releases, reset/cache bounds,
   geometry bounds/closure, control behavior, source-time equality across
   24/30/60 FPS, source seeks and maximum-history clipped-export warmup.
2. Native Canvas: silence, bass, mids, treble, transients, low/high intensity in
   16:9, 9:16 and 1:1. Review intended Blob/Edge Bars changes before updating their
   signatures. Preserve exact pixel hashes for the other 84 reference cases.
3. Full supplied Amnesia track: inspect quiet intro, vocals, dense passages and
   later sections. Also use synthetic held tones and impulses to separate
   frequency response from beat response. One song is not validation across
   every genre; do not claim broader listening tests without the recordings.
4. Desktop/mobile-width UI: style switching, live controls, playback/pause/seek,
   still image, project and personal-look round trips and overlays.
5. Export: full short test track and selected real-song range; compare logical
   geometry at equivalent source times, verify actual WASM use and decode files.
   Check cancellation/fallback where the shared history integration changes them.
6. Performance: compare the exact previous tree and candidate on one idle host,
   using three alternating rounds, explicit grouping/GC and all six styles.
   Separate isolated drawing, default compositing, actual Quick Looks, geometry,
   history, analysis and encoding. Screen seven audio cases and confirm noisy
   controls in shorter paired runs. Retain every regression flag; aim for ≤6 ms
   desktop / ≤12 ms throttled isolated styles, with full-frame costs reported
   separately. Measure maximum controls and bounded memory. These are CPU/Canvas
   submission targets, rather than GPU/FPS or physical-device guarantees.
7. Run the full Node suite, TypeScript, ESLint, Prettier, production build and
   diff checks. Independently review delegated work, commit conventionally,
   update PR #18/report, and verify the exact Vercel preview commit and exports.

If material/shadow passes exceed the budget, simplify those passes first. Keep
the source-time response and geometry invariants. Document remaining Canvas
occlusion and physical-device verification limits rather than introduce WebGL.

## Implementation record

Delegated renderer implementation and independent numerical review use Luna 6
at max effort. Parent review covers code, native real-song frames, performance,
UI/persistence, exports and exact-commit hosted verification. The engineering
report records measured regressions, validation scope and remaining limits.
