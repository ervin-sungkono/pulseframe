# Visual styles engineering report

Pulseframe has five styles: Pulse Ring, Spectrum, Edge Bars, Radial Spectrum and
Spectral Terrain. Preview, PNG capture and video export use the same renderer.
Each style has one built-in Quick Look with particles enabled. Radial Spectrum
uses distinct polar frequency bars; Terrain projects measured frequency history.
Edge Bars blends across the latter half of each bar with 3:1 integrated
primary/accent coverage. See [architecture.md](architecture.md#style-rendering-and-source-time-history)
for algorithms, module ownership, controls and compatibility contracts.

## DRY, KISS and YAGNI review

Each significant change was checked for necessary complexity and a simpler way
to preserve the existing flow. The review uses upstream main as the PR baseline;
cleanup measurements compare the previous PR head (`e399f1c`) with this revision.

| Change                                 | Is the complexity necessary?                                                                | Simplest implementation retained or applied                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Style registry and extracted renderers | Yes: five primary styles share composition and export.                                      | Keep one typed dispatch and the original style calculations; add no renderer lifecycle framework.                                                                       |
| Radial geometry and logo aperture      | Yes: both must use the same bounded layout.                                                 | Reuse the layout calculation; remove repeated per-frame option defaulting.                                                                                              |
| Terrain history, release and caches    | Yes: arbitrary seeking, clipped exports and stable ridges need source-time reconstruction.  | Keep bounded buffers, revision invalidation and smooth contours; avoid a frame-clock simulation or graphics dependency.                                                 |
| New-style audio context                | Some fields had no consumers after the removed visual was retired.                          | Remove the prior-history read, its buffer, unused impact/feature fields and an extra object copy; keep the same band-derived opacity.                                   |
| Settings validation and migration      | Yes: old projects and Quick Looks need defaults and selected logo layouts.                  | Normalize at the schema/settings boundary; remove duplicate renderer defaults and no-op look overrides. Keep project v2 and preset-storage v1.                          |
| Style controls                         | Distinct controls and nested undo groups are needed.                                        | Share Spectrum/Edge Bars roundness; keep the existing sliders and small local update helpers instead of introducing a configuration language.                           |
| Export preroll and timing profiles     | Yes: history needs earlier measurements and different workloads need separate estimates.    | Share the analysis-start calculation between estimation and export. Preserve the encoder and DSP pipeline.                                                              |
| Tests and native Canvas harness        | Yes: determinism, rollover jitter, bounds and persistence have meaningful regression cases. | Keep those cases, tolerant image signatures and PNG SHA-256; remove unused fixture fields, history objects, statistics, geometry calculations and the extra pixel hash. |

Terrain's diagnostic timestamps and availability flags remain useful for testing
seeks and rollover behavior. Existing and new clamp/color helpers intentionally
handle invalid values differently; merging them would change older styles.
No generic control engine, cache framework or replacement media pipeline is added.
The retired visual identifier remains only in import migration; its implementation
and dedicated tests stay deleted. No production dependency is added.

## Verification

- All 31 Node test files, TypeScript, ESLint, production build and Python script
  compilation pass. Formatting and diff checks are clean.
- All 105 tolerant Canvas references pass. All 117 captured PNGs (five styles,
  seven audio conditions, three aspects, plus curated/maximum controls) are
  byte-identical to the exact pre-review build. The cleanup needs no new visual
  baselines and removes no meaningful regression cases.
- Desktop/mobile checks pass for shared Spectrum/Edge Bars roundness, conditional
  reflection/hints, Radial/Terrain controls, play/pause/seek, live edits, aspect
  changes, PNG capture, project reopen and personal Quick Look reload. A retired
  project still imports as Pulse Ring with playable audio.
- Four full/clipped Radial/Terrain exports include video/audio and decode with
  FFmpeg, with WASM active. Cancellation produces no late download and releases
  the lock; the subsequent Edge Bars export through JavaScript fallback decodes.
- After 3,600 draws per new style, prepared history retains 180/384 frames, live
  history 304/304, and Terrain response caches 396/768; no page errors occur.

The history bounds remain 384 prepared frames, 304 live frames and two 384-frame
release caches. These bounds limit retained data, not every temporary allocation
or browser/GPU memory use. Hosted verification is recorded on the pull request
against its deployed commit. Media and generated artifacts stay outside the repo.

## Performance regression

The refreshed comparison covers 80 cases across five styles and three paired
rounds. No isolated-style budget failures or browser errors occurred. Worst
isolated p95 across the selected audio cases (milliseconds):

| Style            | Desktop before → after | 4× CPU before → after |
| ---------------- | ---------------------- | --------------------- |
| Pulse Ring       | 0.485 → 0.465          | 2.660 → 2.415         |
| Spectrum         | 1.375 → 1.140          | 6.410 → 9.025         |
| Edge Bars        | 1.450 → 1.000          | 4.590 → 5.305         |
| Radial Spectrum  | 0.895 → 0.720          | 3.740 → 3.780         |
| Spectral Terrain | 1.485 → 1.430          | 10.485 → 7.740        |

Four paired regression flags remain in the 4× CPU simulation: curated Radial
impulse (4.430 → 5.830 ms), isolated Spectrum impulse (4.480 → 9.025 ms),
composited Edge Bars high intensity (6.895 → 10.635 ms), and composited Ring high
intensity (5.380 → 7.645 ms). Maxima summarize different cases; the CSV retains
every pair. Several flags involve unchanged style algorithms. These mixed
results do not establish a general speedup or prove the flags are noise.
Fully composited candidate drawing reaches 12.825 ms p95.

[visual-performance-regression.csv](visual-performance-regression.csv) retains
all paired cases and flags above both 25% and 0.3 ms p95. Measurements use three
alternating rounds, 30 warm-up and 120 timed 1280×720 frames per case, on one
managed Debian host with Chromium 151 and Node 24.19. Isolated drawing, full
compositing and actual Quick Looks are reported separately. Audio analysis
finishes before timing; encoding is excluded. GC and tab activation are untimed.

The 6 ms desktop / 12 ms 4× CPU-throttled targets apply only to isolated drawing.
These are Canvas command-submission timings without forced GPU readback.
CPU throttling is a desktop simulation, not a physical-mobile FPS claim.

## Reproduce

With Python Playwright and Chromium installed, serve the previous checkout on
5185 and this checkout on 5180, then run:

```sh
pnpm dev --host 127.0.0.1 --port 5180
python3 scripts/verify-visual-styles.py --base-url http://127.0.0.1:5180/ --output /tmp/pulseframe-visual-check
python3 scripts/compare-visual-performance.py --before-url http://127.0.0.1:5185/ --after-url http://127.0.0.1:5180/ --rounds 3 --cases high_intensity,low_intensity,impulse
```

Restart Vite after source edits to keep direct probe imports and rendering on one
module instance. Review reference changes before updating fixtures, then format
the generated JSON. Keep raw captures and timings outside the repository.

## Limits

Physical iOS/Android and Firefox/Safari performance remain unmeasured. Shadows,
compositing and encoding can dominate device costs; short JS heap probes cannot
establish GPU memory behavior or exclude every leak. Terrain uses projected
Canvas geometry with ridge occlusion. A graphics backend or automatic quality
scaling should be added only after device measurements justify it.
