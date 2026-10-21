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

The follow-up music-video polish plan is recorded in [visual-polish-plan.md](visual-polish-plan.md).

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
  asymmetry, finer treble detail and bounded beat expansion. Fixed-angle measured
  frequency windows add local bulges. The shared peak-release adapter supplies
  frequency-dependent settling; Fluidity blends at most 55% response and controls
  spatial softness. A circular five-tap filter and closed quadratic spline keep
  the positive-radius silhouette smooth. Clipped directional/edge shading and a
  small soft highlight add volume; Internal Glow controls the interior wash and
  directional inset rim. Idle movement fades in near silence and respects reduced
  motion. No physical fluid simulation or autonomous active rotation is used.
- **Spectral Terrain:** a 32×24, 48×40 or 64×64 grid samples two-to-ten seconds
  of source-time response history. Interior heights stay anchored while depths
  advance. Bounded monotone cubic contours smooth frequency ridges without
  overshoot; fill and wire share those curves. Continuous depth opacity and
  energy-dependent ribbon shading create distance cues. The traveling highlight
  follows the same curve and depth fade. Both wire and glow edge rows fade at
  rollover. Seeking reconstructs history immediately. Travel speed changes the
  decorative contour, preserving historical timing. Pause holds source time;
  reduced motion removes the contour. No 3D engine or pixel simulation is used.

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
These initial measurements precede the audio-response and terrain continuity corrections
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

## Initial audio response and terrain continuity corrections

This section records the initial corrections; the music-video polish below
replaces the short delayed blend and extends the surface treatment.

Follow-up checks used the supplied 3:57 stereo 44.1 kHz MP3 and the actual
Fluid Dreams and Neon Horizon built-in looks. WASM analysis produced 7,125
envelopes with no browser errors. The media and generated videos remain local.

An earlier blob correction removed duplicate gain/limiting and fitted the entire
silhouette uniformly, but still drove active lobes with clock phases. That made
motion noticeable without making it reliably follow the song. The current
renderer instead maps measured frequency windows to broad local bulges at fixed
angles. Bass expansion, midrange lobes and finer treble response are separate;
beat impact remains a bounded additional expansion. Holding active audio features
constant holds the contour even at different source times. Different frequency
profiles change it with identical broad features and zero beat impact.

Fluidity now softens neighboring frequency windows and blends at most 40% of a
measured history sample at most 80 ms earlier. Unavailable history uses the current
measured spectrum. Idle motion remains optional and respects reduced motion.
The existing circular filter, closed curve and uniform 43%-radius bound retain
smooth, finite, nonintersecting geometry at maximum controls. Reusable buffers
avoid per-frame spectrum allocations. A full-track 6 Hz probe recorded clearly
changing contours (mean relative radius spread 33.6%); displacement alone is not
used as proof of audio following because clock animation can also displace points.

Terrain previously resampled every row at a fixed screen depth each frame. This
reshaped historical ridges instead of moving those ridges, producing a jittering
appearance. Interior rows now retain source-time samples while their projected
depths move continuously through the requested history window. At row rollover,
only boundary samples enter/leave; retained ridges keep their heights. The travel
highlight interpolates using the actual moving depths, avoiding an additional
jump from indexing a nonuniform grid as if it were uniform. The two entering/
leaving horizontal lines fade across one row interval, avoiding a brightness
flash when they coincide with fixed boundary lines. Buffers stay bounded,
seeking reconstructs the same mesh, and pause holds all geometry.

The repeated seven-case 720p benchmark on the managed Linux/Chromium host gave
these p95 ranges (milliseconds, 30 warm-up/120 measured submissions per case):

| Corrected style | Desktop isolated | Desktop composited | 4× simulated isolated | 4× simulated composited |
| --- | ---: | ---: | ---: | ---: |
| Liquid Blob | 0.210–0.290 | 0.510–0.585 | 1.285–1.400 | 2.835–4.080 |
| Spectral Terrain | 0.820–0.915 | 1.125–1.225 | 3.830–5.170 | 5.495–7.620 |

These measure Canvas submission, not physical mobile FPS or export throughput.
After warm-up, explicit-GC heap deltas over the final 1,200-frame intervals were
−52 bytes for Blob and −44 bytes for Terrain; this observation does not replace
a cross-device memory profile. The full results are in the local
`/tmp/pulseframe-audio-travel-verified/` artifacts.

Regression tests cover fixed-audio contours, distinct frequency distributions
without beat changes, causal smoothing/fallback, stable terrain samples between
frames, retained vertex continuity and travel-highlight continuity across row
rollovers at all densities, plus fading of entering/leaving wire lines. A native
Canvas comparison around rollover using the supplied song found zero change in
retained frequency samples. Composited-black pixel differences at the boundaries
were below 0.045/255 mean per channel across all densities; remaining differences
are concentrated in antialiasing at the window edges. All 30 Node test files pass.
Visual references cover
126 cases; only the 42 blob/terrain cases were refreshed after visual review.
All 84 reference PNGs for Ring, Spectrum, Edge Bars and Radial remain byte-identical.

The production-build browser checks passed both built-in looks with the supplied
song: playback, seek, pause/hold, PNG capture, and a 60–65-second export at 480p/30
FPS. Both resulting 854×480 WebMs contain audio/video and decode successfully;
WASM was active and the 390-pixel mobile viewport had no horizontal overflow.
Radial object-motion controls remain deferred until PR #17 is merged. No DSP,
encoder, format-version, camera or object-motion changes accompany these fixes.

## Music-video polish

The detailed scope and acceptance criteria are in
[the implementation plan](visual-polish-plan.md). This pass adds the shared
`app/lib/visual/styles/audio-response.ts` model and
`app/tests/style-audio-response.test.mjs`, and updates the two renderers, their
focused tests, live-history revision contract, export preroll/workload signatures,
Fluid Dreams/Neon Horizon defaults, the Fluidity hint and native Canvas harness.
It adds no production dependency or option/schema version.

The response uses measured current audio plus a finite exponential peak-release
kernel, with roughly 180/125/75 ms bass/mid/treble releases and smooth frequency
transitions. It introduces no extra attack interpolation. The 900 ms history
kernel reaches zero continuously at its boundary. Raw/response caches each hold
at most 384 96-band frames (about 288 KiB total float payload); a weak owner avoids
retaining released sources. Mutable live history revisions invalidate cached
measurements, including seeks, replacement and expiry. Unknown current times
remain unavailable, rather than replaying a cached response. Tests cover five
minutes of queries, cold/warm seek equality, reset, finite invalid inputs,
frequency-dependent decay and current-only availability.

Maximum-depth terrain export now includes the 900 ms response lookback plus
250 ms source-filter support before the visible ten-second window. The same
response adapter feeds preview and export; clipped/full prepared envelopes and
24/30/60 FPS poses are tested for equivalent source-time geometry. Blob and
Terrain export timing workload keys change to avoid learning from the cheaper
previous renderer, while original-style timing keys stay intact.

Fluid Dreams now uses a smaller, more expressive silhouette, stronger spatial
softness, restrained aura and fewer particles; aggressive beat/drop accents are
disabled. Neon Horizon uses a clean background, gently shaded surface and low
ambient beat lighting so a second grid does not compete with the terrain.
Both retain their stable IDs and existing reset, project and personal-look flows.

Validation for this pass:

- All 31 Node test files pass, including the new response model tests. TypeScript,
  ESLint, Prettier, production build and diff checks pass.
- Native Canvas captures cover six styles × seven audio cases × three aspects;
  only the 42 Blob/Terrain reference signatures change. All 84 PNG hashes for the
  other four styles remain identical. Maximum controls and both curated looks
  were visually reviewed in landscape, portrait and square.
- Desktop/mobile controls, live parameter changes during playback, pause/seek,
  PNG capture, project reopening and personal Quick Look persistence pass for all
  three new styles. Six full/clipped short-track exports contain audio/video and
  decode; the actual Amnesia track also passes 60–65-second exports using the
  two curated looks. WAV/MP3 media remain local; WASM activation is observed.
- Cancellation produces no late download and releases the export lock. A
  subsequent JavaScript-backend terrain export contains audio/video and decodes.
- The real-song and synthetic cases separate current pitch response from beat
  response and exercise sustained notes, silence and transients. This is not a
  listening study across multiple genres or physical mobile hardware.

A separate maximum-controls trace used the supplied 237.48-second song, source
seconds 60–62.5, 1280×720 native Canvas, 30 warm-up and 120 measured frames. Every
style-specific control, shared scale and glow was set to its supported maximum;
particles/trails/beat lighting were disabled to isolate the primary style.
Blob measured 1.700 ms p95 and Terrain 2.625 ms on the desktop host; 4× CPU
throttling measured 2.145 and 8.815 ms respectively. The first cold draw was
11.08/28.53 ms on desktop and 9.95/46.98 ms in the later throttled pass; JIT/cache
warm-up and host variation make these single observations unsuitable for FPS
claims. Default-control seven-case results and retained-memory observations are
reported separately. Timings include history/geometry and Canvas submission,
with analysis completed beforehand, and exclude GPU readback and encoding.

The final seven-case repeat used Node 24.19.0 and headless Chromium
151.0.7922.173 on the managed Debian Linux host. A fresh Vite process was used
so direct probe imports and renderer imports share the same module instance;
hot reload can otherwise duplicate the probe's response-cache instrumentation.
The harness now rejects an inactive or unbounded response-cache probe.

| Polished style | Desktop isolated p95 | Desktop composited p95 | 4× simulated isolated p95 | 4× simulated composited p95 |
| --- | ---: | ---: | ---: | ---: |
| Liquid Blob | 0.250–0.295 ms | 0.560–0.680 ms | 1.660–2.075 ms | 3.090–5.795 ms |
| Spectral Terrain | 0.885–0.940 ms | 1.175–1.500 ms | 4.900–6.120 ms | 5.745–6.575 ms |

These ranges fit the stated submission-time budgets on this host, without
establishing universal display FPS. The geometry probe includes the response
adapter in terrain sampling, rather than timing only raw history access. After
3,600 frames and explicit GC, response caches held 359 frames for Blob and 396
for Terrain, below the combined 768-frame bound. The final 1,200-frame retained
heap changes were −60 and +48 bytes; raw source history held 180 test frames and
live history stayed at its 304-frame bound. These are observational JS-heap
results, not GPU/physical-device memory guarantees. Default/full results are in
`/tmp/pulseframe-polish-verified/`; the separate real-song maximum-controls
trace is `/tmp/pulseframe-polish-max-performance.json`.



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
