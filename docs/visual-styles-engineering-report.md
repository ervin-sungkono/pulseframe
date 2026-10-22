# Visual styles engineering report

## Summary

Pulseframe has six first-class visual styles and one built-in Quick Look per
style: Contour, After Hours, Counterflow, Orbit, Fluid Dreams and Neon Horizon.
The three new styles share preview, still capture and video export rendering.
New settings are validated and persist in existing project version 2 and
preset-storage version 1. Personal looks are retained.

This follow-up fits Edge Bars gradients to each visible bar, making the accent
visible even at low amplitude. All six curated looks enable particles, with
24–40 particles per look. Fluid Dreams now uses a connected 2D fluid field
instead of a circular radius deformation. Radial object-motion controls remain
deferred until PR #17 merges. No Rust/WASM, encoder, resolution/FPS, compression,
server, production dependency or project-format change accompanies these fixes.

See [the implementation plan](visual-polish-plan.md) for scope and acceptance.

## Architecture and algorithms

The shared canvas pipeline owns media backgrounds, atmosphere, beat lighting,
particles, style dispatch, overlays, logos, titles and subtitles. A static typed
registry delegates geometry and painting to React-independent style modules.
Settings and geometry remain UI-independent; hooks retain media/export lifecycle
ownership. There is no second rendering algorithm for stills or exported video.

- **Radial Spectrum:** 32–160 distinct bars sample calibrated logarithmic bands.
  Polar geometry supports clockwise/mirrored ordering and outward/inward/both
  variants. Size and glow fit inside a 44% short-edge radius and retain a central
  logo aperture. Rotation uses source seconds; reduced motion freezes it.
- **Liquid Blob:** a core and three overlapping anisotropic masses define a
  smooth implicit 2D field. Relative regional power, spectral centroids/spread,
  current features and a short measured lookback redistribute the masses.
  Their independently audio-driven directions avoid a fixed rotating clover.
  Weaker regions can recede into the core while stronger regions elongate it.
  Overlap bounds keep lobes connected. Deterministic marching squares and
  arc-length resampling produce 96/128/160 control points; a closed quadratic
  curve paints the silhouette. Geometry and scratch storage are bounded, with
  no per-frame fluid simulation or FFT. Whole-shape normalization bounds size
  and center displacement inside a 43% short-edge radius. Silence returns to a
  circle, and optional idle motion only breathes its radius. Clipped gradients,
  restrained directional/edge shading and soft highlights follow the contour;
  Internal Glow controls its interior wash and rim. This is fluid-like graphics,
  not a physically accurate ferrofluid solver.
- **Spectral Terrain:** a bounded 32×24, 48×40 or 64×64 history mesh samples
  two-to-ten seconds of measured source-time frequencies. Interior heights stay
  anchored while projected depths advance. Bounded monotone curves are shared
  by fills, wires and the traveling highlight. Continuous distance and boundary
  fading prevent rollover flashes; restrained surface shading gives depth.
  Seeking reconstructs history immediately. Travel speed changes a decorative
  cue while preserving historical timing; reduced motion removes that cue.
- **Edge Bars:** audio mapping and layout are retained. Each bar receives a
  gradient from its anchored canvas edge to its actual tip; the accent reaches
  full strength at 55% of that visible length rather than at maximum amplitude.

Blob and Terrain share a measured-history peak-release adapter. Attacks retain
existing causal interpolation; bass/mids/treble settle at roughly 180/125/75 ms.
The finite 900 ms kernel fades continuously to zero. Current unavailable audio
stays unavailable; earlier missing history is not fabricated. The source is
weakly owned, two caches are bounded to 384 frames each (about 288 KiB of band
payload), and mutable history revisions invalidate cached measurements.
Prepared raw history holds at most 384 converted frames; live fallback holds
304 and clears on discontinuities. Maximum-depth clipped terrain exports include
900 ms response lookback plus 250 ms filter support before the visible history.
Blob's new workload key prevents reuse of timings from the cheaper polar model.

## Files

- Rendering: `app/lib/visual/visualizer.ts` and
  `app/lib/visual/styles/{types,registry,shared,legacy-common,frequency-mapping,
  frequency-history,audio-response,pulse-ring,spectrum,edge-bars,radial-spectrum,
  liquid-blob,fluid-geometry,spectral-terrain}.ts`.
- Settings/persistence: `app/lib/visual/{style-options,visual-settings-model,
  visual-settings,customizer-config,presets}.ts` and
  `app/lib/persistence/project-file.ts`.
- Controllers/export: `app/hooks/{use-visualizer-preview,use-export-controller}.ts`
  and `app/lib/export/{export-video,export-timeline,export-time-estimate}.ts`.
- Views: `app/components/CustomizerPanel.tsx`, `app/Home.tsx`, `app/globals.css`,
  `app/quick-looks.css`; QuickLookStrip consumes the shared definitions.
- Tests: radial/blob/terrain/edge, frequency-history, style-audio-response,
  visual-style-pipeline and visual-style-settings suites; export estimates,
  source loader and `app/tests/fixtures/visual-style-reference.json`.
- Reproducible browser tooling: `scripts/verify-visual-styles.py` and
  `scripts/compare-visual-performance.py`; architecture and plan in `docs/`.

## Performance regression method and results

The comparison uses the exact previous PR tree (remote commit
`cea3ad67b94bf8078a35d77f3fe7c54bc92c9710`) and the candidate on separate fresh
Vite servers on the same managed Debian Linux/Chromium 151 host, Node 24.19.
No concurrent builds, unit tests or export jobs run during the final benchmark.

Seven stereo 48 kHz synthetic cases cover silence, bass, mids, treble, impulses,
and high/low intensity. PCM analysis finishes before timing. Each run uses 30
warm-up and 120 timed 1280×720 native Canvas frames. An initial broad seven-case
comparison exposed timing spikes in unchanged controls as well as the expected
new workload costs. The final confirmation alternates short before/after pairs,
activates each tab before timing and explicitly collects garbage between mode/
profile groups. It uses three rounds on high intensity, low intensity and
impulses, plus the curated looks on high intensity/impulses. The final standalone
visual/memory harness also measures all seven cases on the candidate.

The table shows the worst median per-case p95 in milliseconds across the final
confirmation cases; it does not establish identical performance for all inputs.
Each cell is **before → after**.

| Style | Desktop isolated | Desktop composited | 4× isolated | 4× composited |
| --- | ---: | ---: | ---: | ---: |
| Pulse Ring | 0.415 → 0.455 | 0.950 → 1.000 | 2.270 → 2.490 | 5.300 → 5.600 |
| Spectrum | 1.045 → 1.085 | 2.430 → 1.860 | 6.950 → 6.395 | 12.660 → 14.835 |
| Edge Bars | 0.525 → 0.930 | 1.030 → 1.505 | 2.455 → 4.895 | 5.535 → 11.675 |
| Radial Spectrum | 0.745 → 0.980 | 1.395 → 1.580 | 3.640 → 3.730 | 7.295 → 8.870 |
| Liquid Blob | 1.100 → 1.055 | 1.710 → 1.755 | 5.015 → 6.735 | 7.920 → 10.410 |
| Spectral Terrain | 1.490 → 1.855 | 2.010 → 1.940 | 10.980 → 9.570 | 14.895 → 13.680 |

This is **not a performance-neutral change**. The 96 paired comparisons include
27 flags above both 25% and 0.3 ms in p95. The complete
[comparison CSV](visual-performance-regression.csv) retains every case and flag,
including the actual Quick Looks with their newly enabled particles. The new
fluid field and visible gradients cost more in several cases. Gradient reuse
reduces Edge Bars from up to 144 gradient objects to one per frame, but does not
eliminate the cost of painting a gradient over every moving bar.

All six isolated styles remain inside the suggested 6 ms desktop / 12 ms
CPU-throttled targets. Fully composited frames include background, particles
and lighting, so they are reported separately from that primary-style budget.
Spectrum reaches 14.835 ms and Terrain 13.680 ms in the throttled composite
confirmation. Two flagged default-control cases use unchanged Spectrum/Terrain
renderer code; the original broad run also showed variable control spikes.
Those measurements are retained rather than claimed as proven code-attributable
regressions or discarded as noise. Physical-device validation remains necessary.

The final standalone seven-case desktop sweep measured isolated Blob at
0.165–0.485 ms p95 and Edge Bars at 0.370–1.240 ms. Different grouping, cache/JIT
warmth and host scheduling affect these samples, so they are not mixed into the
paired comparison to claim a speedup.

A separate real-song trace at seconds 60–62.5 sets every Blob/Terrain control,
shared size and glow to maximum, with effects disabled to isolate the style.
After 30 warm-up frames, 120 samples give Blob 1.715 ms desktop / 4.145 ms at
4× CPU; Terrain 2.480 / 8.920 ms. Cold first draws are 13.415 / 25.325 ms on
desktop and 12.215 / 46.490 ms in the later throttled pass. These cold/cache/JIT
observations are not FPS guarantees or evidence that maximum controls are
cheaper than defaults.

After 3,600 frames and explicit GC, response caches contain 359 Blob / 396
Terrain frames, below the combined 768-frame ceiling. Final 1,200-frame retained
heap deltas are −84 / −136 bytes; raw fixture history contains 180 frames and
rolling history remains at 304. The new fixed field/edge/loop typed-array scratch
uses approximately 355 KiB, shared within the renderer module. Flat retained
growth does not mean zero allocation: existing bounded response/history caches
still allocate on new measurements. Raw local results are under
`/tmp/pulseframe-fluid-final/`, `/tmp/pulseframe-fluid-performance-confirmed.json`
and `/tmp/pulseframe-fluid-max-performance.json`.

These are synchronous Canvas submission times, including history/geometry and
painting commands, without forced GPU readback. They are not GPU raster time,
display FPS, physical-mobile performance, encoding throughput or total-export
claims. Four-times CPU throttling is a desktop simulation. Separate maximum-
control and memory/cache probes complement the default paired comparison.

## Verification

- All 32 Node test files pass; the optimized Edge Bars path also passes focused
  gradient/legacy/pipeline checks. TypeScript, ESLint, Prettier, Python script
  compilation, production build and diff checks pass. The build retains its
  existing large-chunk advisory.
- Native Chromium passes 126 visual-reference comparisons and 18 curated/max
  captures in landscape, portrait and square. Only the 42 Blob/Edge signatures
  are refreshed after review. The other 84 PNGs are byte-identical to the exact
  previous tree. Geometry assertions cover finite/bounded shapes, real concavity,
  closure/nonintersection, silence, reduced motion, tone redistribution,
  source-time/FPS/seek equality, history availability and the low-detail fix.
- All six actual built-in Quick Looks select the intended style and enable
  particles. Desktop 1280×1000 and mobile 390×844 checks pass for live controls,
  playback/pause/seek, aspect changes, PNG capture, saved/reopened projects and
  saved/reloaded personal Quick Looks. No horizontal overflow or page errors.
- The actual Fluid Dreams look with the supplied song passes playback, seek,
  pause/hold, PNG capture and a 60–65-second 480p/30 FPS export. WASM activation
  is observed. The 854×480 video includes audio, lasts 5.02 seconds including
  the codec tail and decodes without errors.
- All three new styles export both the full six-second synthetic track and
  seconds 1.0–2.5 at 480p/30 FPS. All six WebMs contain 854×480 video and audio,
  report 6.02/1.52 seconds and decode with ffmpeg. Cancellation at 1440p/60 FPS
  produces no late download and releases the lock; the following 1.5-second
  Liquid Blob export succeeds and decodes through the JavaScript DSP fallback.
- Hosted exact-commit validation is recorded in PR #18 after deployment. The
  results above use the local production build, rather than assuming hosting
  behaves identically.

The supplied 237.48-second stereo 44.1 kHz Amnesia MP3 remains local. Full-track
shape probes use WASM analysis and sample at 6 Hz. Shape comparisons use contour
distance, area, convex-hull solidity and circularity rather than interpreting
point-index changes as actual motion. Fixed audio holds its pose; synthetic
frequency changes distinguish audio following from a beat-only expansion.
An independent Luna 6 max-effort review reproduced a low-detail/minimum-size
neck-sampling discontinuity; that exact trajectory is part of the regression
checks. Delegated code is independently reviewed before publication.

Reproduce native checks with Python Playwright and Chromium installed:

```sh
pnpm dev --host 127.0.0.1 --port 5180
python3 scripts/verify-visual-styles.py --base-url http://127.0.0.1:5180/ --output /tmp/pulseframe-visual-check
# Serve the previous checkout on 5185 and the candidate on 5180, then:
python3 scripts/compare-visual-performance.py --before-url http://127.0.0.1:5185/ --after-url http://127.0.0.1:5180/ --rounds 3 --cases high_intensity,low_intensity,impulse
```

Restart Vite after edits so instrumentation and renderer imports share one module
instance. The visual harness rejects inactive/unbounded response-cache probes.
It writes media, PNGs, raw timings and heap observations outside the repository.
Committed reference signatures cover six styles × seven cases × three aspects;
reference updates require visual review and an explicit flag. Only Blob/Edge
Bars reference changes are intended in this follow-up; the other 84 frames must
remain exact. Coarse portable signatures supplement finer geometry assertions.

## Known limits and future work

Physical iOS/Android and Firefox/Safari performance remain unmeasured. Canvas
shadows/compositing and encoding can dominate device costs. Small managed-host
heap probes do not establish GPU memory behavior or exclude every browser leak.
Terrain is a projected Canvas landscape with natural ridge occlusion, rather
than a depth-buffered 3D scene. The fluid field has a few connected masses and
material gradients, rather than physical surface tension, fragmentation or
pixel simulation. Validation with one supplied song and synthetic inputs is not
a listening study across all genres.

If physical-device profiling identifies a bottleneck, simplify excessive glow or
painting passes first. Consider WebGL2 only if measured Canvas costs justify it.
No automatic export resolution/FPS downgrade is introduced.
