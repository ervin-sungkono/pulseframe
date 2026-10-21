# Visual styles engineering report

## Summary

Pulseframe now has six first-class visual styles: Pulse Ring, Spectrum, Edge
Bars, Radial Spectrum, Liquid Blob and Spectral Terrain. The new styles have
validated, persisted option groups, focused controls, distinct selection artwork,
and one built-in Quick Look per style: Contour, After Hours, Counterflow, Orbit,
Fluid Dreams and Neon Horizon. Duplicate built-in style variations were removed;
saved personal Quick Looks are preserved. Contour has fewer particles and softer
lighting; After Hours keeps warm reflected bars with softer beams; Counterflow
removes distracting comets/trails; Fluid Dreams uses sparse stardust; Neon Horizon
keeps attention on its luminous mesh rather than background beams. Existing
project version 2 and preset-storage version 1 remain unchanged.

The Rust/WASM DSP implementation, encoder, resolution/FPS choices and optional
video-compression behavior are unchanged. Rendering stays local to the device.
No production dependency was added.

## Architecture decisions

The shared canvas pipeline still owns background images/video, atmosphere,
lighting, particles, primary-style dispatch, overlays, logo fitting, metadata and
subtitles. A static exhaustive registry delegates only primary geometry/painting
to six React-independent modules through `VisualStyleRenderer<Options>` and
`VisualFrameContext`. This is a small extraction, rather than a graphics engine
or plugin system. Existing public geometry helpers remain available.

New style settings use `radialOptions`, `blobOptions` and `terrainOptions`.
Defaults and validation cover missing/partial groups in old files. Retired IDs
continue to migrate explicitly; none is revived. Each style retains independent
logo placement. Visual reset, undo/redo, project transfer and personal Quick Look
serialization use the existing workflows; separate nested-control undo keys
prevent unrelated sliders from merging into one change.

Prepared history references existing 30 Hz analysis envelopes and caches at most
384 converted frames (144 KiB of band payload). Stereo combines by power. A
causal weighted three-frame response interpolates at absolute source time,
without a new FFT or dependence on previous drawing calls. Live fallback retains
at most 304 measured frames, clears on seeks/discontinuities and leaves unknown
past rows empty. Terrain buffers top out at 64×64 samples, about 50 KiB per canvas
context including projected geometry. Weak caches follow canvas/prepared-audio
ownership; they retain no media or encoder resources.

Clipped new-style exports align decode start to the analysis grid. At the maximum
ten-second terrain history they include an extra 250 ms of filter warm-up, so the
oldest row is initialized correctly. Preparation estimates share this calculation.
New complexity buckets distinguish bar counts, blob detail and terrain workloads
without discarding existing timing profiles.

## Rendering algorithms

- **Radial Spectrum:** 32–160 individual bars sample the existing logarithmic
  frequency axis. Clockwise/mirrored frequency ordering and outward/inward/both
  variants share bounded polar geometry. Inner radius and bar length are short-edge
  percentages before automatic fitting, with glow clearance and a logo aperture.
  Primary/secondary colors form a gradient. Rotation uses source seconds, with
  100% equal to one revolution per minute; reduced motion freezes rotation.
- **Liquid Blob:** 96/128/160 angular samples combine broad bass lobes, midrange
  asymmetry, smaller treble ripples and a bounded transient expansion. A circular
  five-tap filter and closed quadratic spline produce a smooth positive-radius
  silhouette. A few gradient/highlight passes provide depth. Fluidity changes
  deterministic harmonic speed. Reduced motion freezes harmonics and idle motion
  while preserving audio response; this is not a physical fluid simulation.
- **Spectral Terrain:** a 32×24, 48×40 or 64×64 grid samples a two-to-ten-second
  source-time window, smooths neighboring frequency samples and projects stable
  perspective wire lines with optional translucent row fills. Seeking reconstructs
  history immediately. Travel speed moves a decorative illuminated contour; it
  does not speed up or fabricate historical audio. Pause holds source time and
  reduced motion removes that contour. No full 3D engine or pixel simulation is used.

## Files

- Shared pipeline/controllers: `app/lib/visual/visualizer.ts`,
  `app/hooks/use-visualizer-preview.ts`, `app/hooks/use-export-controller.ts`,
  `app/lib/export/export-video.ts`, `export-timeline.ts`, `export-time-estimate.ts`.
- New renderer modules: `app/lib/visual/styles/{types,registry,shared,legacy-common,
  frequency-mapping,frequency-history,pulse-ring,spectrum,edge-bars,
  radial-spectrum,liquid-blob,spectral-terrain}.ts`.
- Settings/persistence: `app/lib/visual/{style-options,visual-settings-model,
  visual-settings,customizer-config,presets}.ts`,
  `app/lib/persistence/project-file.ts`.
- Views: `app/Home.tsx`, `app/components/CustomizerPanel.tsx`, `app/globals.css`,
  `app/quick-looks.css`. Existing QuickLookStrip consumes the shared look definitions.
- Tests: new radial/blob/terrain, frequency-history, visual-style-pipeline and
  visual-style-settings test files; updated source loader, legacy logo-map and
  export-estimate assertions; `app/tests/fixtures/visual-style-reference.json`.
- Verification/documentation: `scripts/verify-visual-styles.py`,
  `docs/architecture.md` and this report.

## Performance environment and method

Managed Debian 13/Linux 6.18 host, AMD EPYC 7763 with three available logical
CPUs, Node 24.19 and headless Chromium 151.0.7922.173 through Python Playwright.
Canvas size: 1280×720, device scale 1. Seven deterministic stereo 48 kHz audio
cases cover silence, bass, midrange, treble, impulses, high and low intensity.
Each measurement uses 30 warm-up and 120 timed calls.

PCM synthesis and JavaScript reference analysis happen before renderer timing;
no FFT occurs in the timed style calls. The harness also records analysis,
geometry/history sampling and projection separately. These are synchronous Canvas
API submission timings, without forced GPU readback: they are not end-to-end FPS,
GPU raster, real-device mobile, encoding throughput or total-export claims.
The isolated run disables particles, trails, lighting, drops and glitch; the
composited run retains the normal defaults. The mobile simulation adds 390×844
mobile/touch metrics and 4× CPU throttling on the same desktop host, still drawing
720p. Physical mobile hardware has not been benchmarked.

The initial implementation benchmark-only repeat ran after concurrent test/build/browser work
stopped. The table gives the range of per-case p95 values across seven audio
cases, in milliseconds; it does not average away the different workloads.
These initial measurements precede the Liquid Blob responsiveness correction
documented below.

| Style | Desktop isolated | Desktop composited | 4× simulated isolated | 4× simulated composited |
| --- | ---: | ---: | ---: | ---: |
| Radial Spectrum | 0.445–1.495 | 0.550–2.165 | 1.575–6.410 | 3.930–5.445 |
| Liquid Blob | 0.355–0.445 | 0.605–0.675 | 1.440–2.115 | 2.860–3.510 |
| Spectral Terrain | 0.750–1.285 | 1.145–2.000 | 3.470–5.595 | 5.005–7.230 |

These default-style CPU submission measurements fit the suggested 6/12 ms style
budgets in this environment. Occasional simulated-mobile outliers remain:
2/840 isolated Radial frames exceeded 16.7 ms (maximum 43.915 ms), and 3/840
composited Radial frames exceeded it (maximum 63.305 ms). No desktop sample
exceeded 16.7 ms. An earlier run alongside other work produced terrain/spectrum
p95 spikes near 40 ms; those spikes did not reproduce in the isolated repeat.
This variability is a reason to measure physical devices before promising FPS.

For context, the same repeat's desktop isolated p95 ranges were 0.175–0.475 ms
for Ring, 0.870–1.210 ms for Spectrum and 0.250–0.515 ms for Edges. The initial
pre-extraction baseline was 0.170–0.190, 0.620–1.365 and 0.255–0.300 ms
respectively. Different runs/load make these unsuitable for claiming a speedup;
63/63 original reference frames instead establish unchanged visual behavior.

The separate geometry probe measured Radial geometry around 0.010–0.015 ms p95
and Blob 0.150–0.235 ms; terrain sampling and projection are recorded separately
by the harness. Encoding is exercised as a workflow check, not benchmarked as a
throughput improvement. PCM analysis is unchanged and timed independently in
harness preparation.

After explicit Chromium GC at 1,200, 2,400 and 3,600 rendered frames, retained
heap deltas for the final interval were Radial +6,244 bytes, Blob +696 bytes and
Terrain −68 bytes. Initial retention/JIT growth flattened after warm-up; this
short probe is evidence of bounded caches, not proof against every browser leak.
Prepared cache counts held at 180 for the six-second fixture and rolling counts
at 304; the five-minute/9,000-frame unit workload separately exercises the
384-frame prepared-cache ceiling.

Workspace measurements: `/tmp/pulseframe-styles-quiet-repeat/` contains raw
samples, source SHA-256s and per-case p50/p95/p99/max/outlier counts. The final
126-frame comparison, PNGs, geometry and memory probe are under
`/tmp/pulseframe-visual-styles-final-confirmed/`. These paths are local artifacts;
the committed harness reproduces the measurements.

## Verification

Automated checks passed: all 30 Node test files, TypeScript, ESLint, Prettier,
`git diff --check` and the production Vite build. The build retains its existing
large-chunk advisory. Tests cover real low/high-frequency PCM distributions,
bounded radial geometry, closed/nonintersecting blob contours, terrain frequency
positions/projection, silence and invalid values, reduced motion, source-time/FPS
independence, history-cache bounds, discontinuities, maximum-history clipped
exports, defaults/ranges, retired migrations, projects and Quick Looks. Shared
pipeline traces compare new-style geometry and opacity for preview warm-up,
first clipped frame and still capture. Existing export snapshot/cancellation and
WASM parity tests also pass.

Native Chromium visual verification passed 126/126 tolerant signatures with
zero signature error and exact occupied bounds, plus 18 maximum-control/built-in
look captures. The original 63 legacy frames also matched exact pixel hashes
before and after modularization. The new reference frames cover seven audio
conditions and 16:9, 9:16 and square layouts.

Browser editor checks used a six-second stereo local WAV at desktop 1280×1000
and mobile 390×844. All six style cards select. Each new style passed play,
pause/hold, seek, resume and parameter editing without playback reset; aspect
changes preserved settings and produced the expected canvas dimensions. Each
saved a valid 1280×720 PNG, saved/reopened a project with customized settings,
and saved/reloaded/applied a personal Quick Look. Mobile checks found no
horizontal overflow. A final desktop/mobile check confirmed exactly six built-in
Quick Looks, each selecting its distinct visual style. Detailed evidence is in the workspace artifact
`/tmp/pulseframe-styles-browser/qa-report-final.json`.

Production-preview exports passed for all three new styles: a complete six-second
track and the 1.0–2.5-second range, at 480p/30 FPS. All six resulting WebM files
contain 854×480 video and audio; ffprobe durations were 6.02 and 1.52 seconds
(including the audio codec/container tail), and ffmpeg decoded every file without
errors. Actual worker messages confirmed WASM activation. A fresh `?dsp=js`
page also exported/decoded terrain successfully through the JavaScript backend.
Cancellation at 1440p/60 FPS produced no late download, released the export lock,
and allowed the next export to complete. The local Vite server's stale optimized
media dependency returned 504 during initial testing; final export checks used
the bundled production preview and had no page/network errors.

Reproduce the browser renderer checks with a local development server and Python
Playwright/Chromium installed:

```sh
pnpm dev --host 127.0.0.1 --port 5180
python3 scripts/verify-visual-styles.py --base-url http://127.0.0.1:5180/ --output /tmp/pulseframe-visual-check
```

The harness writes PNGs, timings CSV, comparison results and heap observations
outside the repository. Its committed fixture contains tolerant 8×8 RGB/bounds
signatures for six styles × three aspects × seven audio cases. The original
three styles' signatures were derived from pre-extraction captures. Updating
references requires the explicit `--update-references` flag and visual review;
the default command fails on missing/changed references or browser errors.
Unit geometry tests cover finer invariants that coarse image signatures cannot.

## Liquid Blob responsiveness correction

A follow-up check used the supplied 3:57 stereo 44.1 kHz MP3 and the actual
Fluid Dreams built-in look. WASM analysis completed with 7,125 envelopes and no
browser errors. The fault was in shape response: a second gain/limiter flattened
already-normalized bass/mid/treble levels, while the harmonic phases moved too
slowly to read clearly in the preview. Per-point radius clipping also suppressed
lobes at maximum size/deformation.

The renderer now consumes normalized features directly, uses stronger bounded
surface deformation and a visible fluidity range, and fits the complete shape
uniformly inside the existing 43% radius bound. A reusable 160-float radius buffer
lets the angular filter reuse each sample instead of evaluating it five times.
Source-time determinism, reduced motion, silence/idle choices, setting defaults
and persistence are preserved. Radial motion is deferred until PR #17 is merged;
this correction adds no object-motion or camera controls.

Across 1,395 audible samples from the full track, using 720p isolated blob
geometry sampled at 6 Hz, median contour displacement between samples rose from
0.45 to 2.34 pixels. Median relative radius spread rose from 8.7% to 15.8%.
These describe visible motion, not rendering speed or display FPS. The audio file
and generated videos are not committed.

The corrected renderer measured 0.155–0.250 ms p95 in the desktop isolated
seven-case harness and 0.460–0.645 ms with default compositing; geometry alone was
0.040–0.060 ms p95. This follow-up did not repeat physical-device or simulated
mobile timing. All 105 reference frames for the other five styles retained their
original pixel hashes; only the 21 blob reference cases were refreshed after
visual review. The actual Fluid Dreams UI passed playback, seeking, pause/hold,
PNG capture and a 60–65-second range export at 480p/30 FPS from the supplied
track. The resulting 854×480 WebM contains audio/video and decoded successfully;
WASM was active and the 390-pixel mobile viewport had no overflow.
Regression tests now cover sustained broadband music, distinct
high-level bass response, maximum-control shape preservation, and finite,
continuous source-time flow. Local full-track analysis and range-export evidence
live under `/tmp/pulseframe-amnesia/`.

## Limits and follow-up

Canvas shadows/compositing and encoding can dominate real-device costs; the
submission-time measurements do not establish universal 60 FPS or export speed.
Physical iOS/Android and Firefox/Safari remain follow-up validation. Terrain is a
Canvas 2D projected wire landscape, with natural ridge occlusion, rather than a
3D depth-buffered scene. Its travel cue deliberately preserves the time-frequency
history mapping. No automatic export quality downgrade was introduced.

If device measurements show a concrete problem, first reduce excessive glow or
batching costs. Consider optional WebGL2 only after profiling demonstrates that
Canvas painting is the limiting subsystem. More precise perceptual screenshot
checks and physical-device benchmarks can strengthen the current portable
signature checks without changing the rendering architecture.
