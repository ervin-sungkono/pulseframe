# Visual styles engineering report

## Summary

Pulseframe has five first-class styles: Pulse Ring, Spectrum, Edge Bars, Radial
Spectrum and Spectral Terrain. A typed registry shares one pipeline for preview,
PNG capture and video export. Each style has exactly one built-in Quick Look:
Contour, After Hours, Counterflow, Orbit and Neon Horizon. Each enables 24–40
particles. Personal Quick Looks remain intact.

Edge Bars retains its smooth per-bar gradient and uses a 3:1 primary/accent
balance. A soft transition spans 65–85% of each bar, centered at the 75% split;
the integrated primary/accent color coverage is 75%/25%. One normalized gradient is reused per frame, preserving rounded path
geometry and keeping the color range independent of loudness.

Only Radial Spectrum and Spectral Terrain are added as new styles. Retired
preview projects/presets map to a supported mode during import; obsolete option
and logo keys are discarded. Project version 2 and preset-storage version 1 do
not change. The Rust/WASM DSP engine, encoder, resolution/FPS and compression
choices stay intact. No production dependency is added.

## Architecture and rendering

The shared canvas pipeline owns backgrounds, atmosphere, lighting, particles,
primary-style dispatch, logo fitting, metadata and subtitles. React views present
controls; hooks own orchestration and cleanup. Style modules contain independent
geometry and Canvas painting, with no media player, React or encoder ownership.

- **Radial Spectrum:** 32–160 distinct bars sample calibrated logarithmic bands.
  Clockwise/mirrored ordering and outward/inward/both variants share bounded
  polar geometry. Glow and size fit within a 44% short-edge radius, preserving
  a central logo aperture. Rotation uses absolute source seconds; reduced motion
  freezes it.
- **Spectral Terrain:** a 32×24, 48×40 or 64×64 frequency/history mesh samples
  two-to-ten seconds of measured source time. Interior heights stay anchored as
  depths advance. Bounded monotone curves are shared by fills, wires and the
  traveling highlight. Continuous distance/boundary fading avoids rollover
  flashes. Seeking reconstructs the correct history; reduced motion removes the
  decorative travel cue.
- **Edge Bars:** layout and audio response are unchanged. Canvas paths retain
  their coordinates while the paint transform scales a shared unit gradient
  from each bar's anchor toward its tip. The 75% primary/accent boundary stays proportional to actual length,
  even on quiet bars.

Terrain's source-time release adapter preserves causal attacks and uses roughly
180/125/75 ms bass/mid/treble settling. Its finite 900 ms kernel fades to zero.
Unavailable history is not invented. Two 384-frame caches hold about 288 KiB of
band payload, are weakly owned and invalidate with mutable history revisions.
Prepared raw history holds 384 converted frames; live history holds 304 and
resets on discontinuities. Maximum-depth clipped exports include 900 ms response
lookback and 250 ms filter support before the visible terrain history. All other
style timing profiles and shared export lifecycle behavior are retained.

## Files and removal

The active renderers are `app/lib/visual/styles/{pulse-ring,spectrum,edge-bars,
radial-spectrum,spectral-terrain}.ts`, selected through `types.ts` and
`registry.ts`. Shared geometry/frequency/history helpers remain only where used.
Typed `radialOptions` and `terrainOptions` groups provide defaults, validation,
reset and serialization. `CustomizerPanel.tsx` and the Quick Look definitions
expose five styles and their relevant controls.

The removed visual's renderer, geometry helper and dedicated test file are
physically deleted. Its types, defaults, validation group, controls, thumbnails,
Quick Look, logo defaults, export-cost branch, screenshot cases, benchmark probes
and obsolete planning document are removed. Only the retired identifier needed
for compatibility remains in the generic migration map and migration test.

## Performance regression

The current follow-up compares the exact previous PR tree (`6f9d6ad`) with the
five-style build. The three-round paired test covers 80 combinations across all
five styles. There are no isolated-style budget failures and no browser errors.
Worst isolated p95 across the selected audio cases (milliseconds):

| Style            | Desktop before → after | 4× CPU before → after |
| ---------------- | ---------------------- | --------------------- |
| Pulse Ring       | 0.585 → 0.500          | 3.300 → 2.345         |
| Spectrum         | 1.230 → 1.040          | 6.430 → 7.375         |
| Edge Bars        | 1.390 → 1.045          | 5.105 → 4.180         |
| Radial Spectrum  | 2.000 → 0.760          | 4.300 → 3.695         |
| Spectral Terrain | 1.895 → 2.275          | 14.925 → 9.565        |

These maxima summarize different cases; they do not replace the paired rows in
`docs/visual-performance-regression.csv`. Six paired regression flags remain:
Edge Bars impulse isolated (4× CPU, 2.800 → 3.600 ms), Spectrum high-intensity
isolated (4× CPU, 5.730 → 7.375 ms), and four composited Ring/Spectrum/Radial cases.
Several flags occur in unchanged renderers. This mixed result does not establish
a general speedup or prove every flagged change is noise. All isolated candidate
cases meet the targets. Fully composited drawing is outside that isolated budget; its worst candidate
p95 is 14.695 ms in the throttled simulation.

The main production JavaScript bundle shrinks from 638,102 to 624,189 bytes
before HTTP compression (13,913 bytes, about 2.2%). No encoding or audio-analysis
speedup is claimed.

The reusable scripts are `scripts/verify-visual-styles.py` and
`scripts/compare-visual-performance.py`. Native checks cover all five current
styles, seven synthetic audio conditions and landscape/portrait/square formats.
Before/after confirmation alternates exact old/new checkouts on one managed
Debian Linux host with Chromium 151 and Node 24.19. Analysis completes before
renderer timing. Each run has 30 warm-up and 120 timed 1280×720 frames. Three
paired rounds measure default isolated drawing, default compositing and actual
Quick Looks on selected stress cases. Explicit GC between groups and tab
activation happen outside timing.

The comparison retains flags above both 25% and 0.3 ms p95, including unchanged
control styles. The 6 ms desktop / 12 ms four-times-throttled targets apply to
isolated styles; full compositing is reported separately. These are synchronous
Canvas submission timings without forced GPU readback, rather than physical
mobile FPS, GPU raster or encoding throughput measurements. Existing caching
still allocates on new measurements; bounded retention is not zero allocation.

## Verification

- All 31 Node test files, TypeScript, ESLint, Prettier, production build,
  Python script compilation and diff checks pass.
- Native Canvas captures cover five styles, seven audio conditions and three
  aspect ratios (105 frames), plus 12 curated/maximum-control captures. Only the
  21 Edge Bars references change; the other 84 PNGs are byte-identical to the
  exact previous tree. The Edge Bars gradient is visually reviewed at quiet and
  high intensity, with its proportional color split tested across four levels.
- Desktop/mobile control ranges, live parameter edits without playback resets,
  play/pause/seek, all aspect ratios, PNG captures, project reopen and saved
  personal Quick Look reload pass for Radial and Terrain. All five built-in
  looks select the correct style and enable particles.
- Cancellation produces no late download, releases the lock and permits a new
  Edge Bars export through the JavaScript DSP fallback; that file contains
  video/audio and decodes successfully.
- An older project using the retired mode imports as Pulse Ring with its audio
  intact, plays normally and exposes no removed controls. Generic migration
  tests also check project/preset parsing, selected logo layout and option
  stripping.
- Full six-second and 1.0–2.5-second exports for Radial and Terrain contain
  video/audio and decode with FFmpeg. A 60–65-second Edge Bars export from the
  supplied 237.48-second Amnesia MP3 also decodes, with WASM active. Its playback,
  pause, PNG and mobile layout checks pass. These browser checks produced no
  page or unexpected request errors on their completed runs.
- Initial local export checks hit browser crashes with old test servers still
  retaining several gigabytes of host memory. After stopping those obsolete
  servers, the same checks pass. This is a managed-host test limitation, not a
  cross-device memory guarantee.

The final native harness passes all 105 reference comparisons and 12 additional
captures with no page errors. After 3,600 draws per new style, measured source
history retains 180 frames (limit 384), rolling history 304 (limit 304), and the
Terrain response cache 396 (limit 768). This confirms bounded retained caches in
this probe, not zero allocation or a universal leak guarantee.

Hosted preview verification is recorded on the pull request for its exact final
commit. Local checks above use the production build.

Reproduce the renderer checks with Python Playwright and Chromium installed:

```sh
pnpm dev --host 127.0.0.1 --port 5180
python3 scripts/verify-visual-styles.py --base-url http://127.0.0.1:5180/ --output /tmp/pulseframe-visual-check
# Serve the previous checkout on 5185, then compare the candidate:
python3 scripts/compare-visual-performance.py --before-url http://127.0.0.1:5185/ --after-url http://127.0.0.1:5180/ --rounds 3 --cases high_intensity,low_intensity,impulse
```

Restart Vite after edits so direct instrumentation and renderer imports share
one module instance. Reference updates require review; run the formatter after
updating generated signatures. Media and raw measurements remain outside the
repository. The committed comparison CSV retains per-case results for reviewers.

## Limits

Physical iOS/Android and Firefox/Safari performance remain unmeasured. Canvas
shadows, compositing and encoding can dominate device costs; isolated budgets
are not whole-frame FPS promises. Short managed-host heap probes do not establish
GPU memory behavior or exclude every browser leak. Terrain is a projected Canvas
landscape with natural ridge occlusion, rather than a depth-buffered 3D scene.
If device profiling finds a concrete issue, simplify excessive glow/painting
passes first. No automatic export quality downgrade is introduced.
