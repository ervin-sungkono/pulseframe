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

## 2. Coherent Liquid Blob

Files: `app/lib/visual/styles/liquid-blob.ts`, `app/tests/blob-style.test.mjs`.

- Replace the isolated delayed-history blend with shared musical response.
  Fluidity blends the measured current response with settled response and
  controls spatial softness. Do not reapply sensitivity to normalized features.
- Keep broad bass expansion, midrange asymmetry, finer treble detail and bounded
  beat expansion separate. Couple neighboring angular samples into broad lobes
  instead of allowing high-frequency measurements to create isolated spikes.
- Retain a fixed center, positive radii, closed smooth contour and uniform fit
  inside the existing 43%-of-short-edge limit. Active shape changes must come
  from audio, with no rotating time phase. Optional idle motion remains subtle
  and respects reduced motion.
- Shade inside the actual silhouette: soft directional volume, gentle edge/rim
  lighting and a small number of inset contours that follow deformation.
  Internal Glow controls the extra treatment. Avoid opaque white patches,
  detached highlights, a large bloom halo or a separate pixel simulation.
- Reuse geometry/scratch buffers and a small, fixed number of drawing passes.

Acceptance: distinct frequencies reshape the contour without a beat change;
impulses expand and relax; silence settles; fixed input holds its active pose;
high intensity stays smooth and bounded; all existing controls remain meaningful.

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

- Tune only Fluid Dreams and Neon Horizon. Keep stable preset IDs and six total
  built-in looks so saved workflows do not break.
- For Fluid Dreams, balance size/deformation, generous surface detail and low
  distraction around the silhouette. For Neon Horizon, let depth cues carry the
  scene and avoid a competing background grid or aggressive beat lighting.
- Preserve the current option ranges and reset/undo/serialization contracts.
  Reuse Fluidity, Internal Glow, Surface Fill, Wireframe Opacity and Glow rather
  than adding new low-level mathematical controls.

## 5. Verification and release gates

1. Unit/behavior checks: envelope causality and releases, reset/cache bounds,
   geometry bounds/closure, control behavior, source-time equality across
   24/30/60 FPS, source seeks and maximum-history clipped-export warmup.
2. Native Canvas: silence, bass, mids, treble, transients, low/high intensity in
   16:9, 9:16 and 1:1. Review intended Blob/Terrain changes before updating their
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
6. Performance: compare geometry/history work and Canvas submission separately,
   record desktop 720p p95 and 4× CPU-throttled simulation, plus bounded memory.
   Aim for ≤6 ms desktop and ≤12 ms simulated mobile style drawing; these are
   workload targets, not universal GPU/FPS or physical-device guarantees.
7. Run the full Node suite, TypeScript, ESLint, Prettier, production build and
   diff checks. Independently review delegated work, commit conventionally,
   update PR #18/report, and verify the exact Vercel preview commit and exports.

If material/shadow passes exceed the budget, simplify those passes first. Keep
the source-time response and geometry invariants. Document remaining Canvas
occlusion and physical-device verification limits rather than introduce WebGL.

## Implementation record

Implemented with two Luna 6 max-effort renderer tasks and independent parent
review. Shared response, export integration and lifecycle checks remain in
UI-independent models/controllers. The engineering report records measured
results, validation scope and remaining physical-device/Canvas limitations.
