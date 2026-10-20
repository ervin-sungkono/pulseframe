# Pulseframe codebase review — 20 October 2026

Reviewed baseline `564ba43` from `ervin-sungkono/audio-visualizer`, on a clean
checkout. Work is on `refactor/architecture-simplification`. Six independent
Luna 6 agents at maximum reasoning reviewed architecture, React, audio/DSP,
rendering/export, dead code, and validation. Implementation used nonoverlapping
file assignments. A reviewer who implemented none of the changes independently
checked the final production diff and found no substantiated regression.

## A. Architecture assessment

The original architecture already has appropriate ownership boundaries:

- `main.tsx` mounts `Home`, which composes views and orchestration hooks.
- Settings, presets, projects and subtitle contracts are independent of React.
- `MediaSessionOwner` owns media, audio graphs, decoded PCM and image resources.
- Preview owns animation scheduling and causal seek replay; preview and video
  export share the canvas renderer and response equations.
- Export separates immutable input capture, job/lock/download ownership,
  encoding and measured timing history.
- DSP uses bounded worker transfers, versioned Rust/WASM bindings, and a
  JavaScript fallback. Local subtitle inference has its own worker; consented
  Gemini requests use a same-origin server adapter.
- Quick Looks use validated, revision-aware browser-local persistence.

The [dependency map](architecture.md) now includes both workers, subtitle
orchestration, persistence, external API boundaries and build-time runtime assets.
Arrows follow actual consumer-to-dependency imports or calls.

The most significant problems were localized: cancellation could wait forever
on a stalled cached model stream; development and production request limits
disagreed; persisted export validation repeated option lists; subtitle views
depended on an export view for time formatting; and unused UI/CSS scaffolding
obscured the active surface. No P0 or P1 production defect was substantiated.

The changes keep the existing ownership architecture. They consolidate shared
contracts and repeated helpers, remove confirmed unused code, and close the
cached-stream abort gap. No state library, service layer, event bus, worker
layer, plugin system or new runtime dependency was introduced.

## B. Implemented refactoring

| Priority / area                       | Original problem                                                                                                                | Change                                                                                                                   | Benefit                                                                            | Risk                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P2 — `lib/lyrics/model-cache.ts`      | A Cache API `reader.read()` was not signal-aware; awaiting `cancel()` could also stall cleanup.                                 | Race reads with the existing abort signal, request cancellation without awaiting it, and release the reader best effort. | Parent cancellation and timeout settle even for an uncooperative cached stream.    | Medium: asynchronous cleanup; covered by stalled-read and cache-integrity tests. |
| P2 — `scripts/lyrics-dev-api.ts`      | The 4.1 MB local cap rejected valid 100-second requests below the shared 4.5 MB cap; errors used a flat body.                   | Use the existing shared byte limit and canonical nested error responses.                                                 | Development accepts the same request sizes and error contract as the API.          | Low                                                                              |
| P2 — export/project contracts         | Frame-rate types belonged to timeline code; project schemas repeated resolution, rate and subtitle limits.                      | Keep export choices/defaults in `lib/export-settings.ts`; validate from shared values and subtitle constants.            | One source of supported options; persistence no longer depends on a timeline type. | Low: existing values, defaults and legacy 480p mapping preserved.                |
| P3 — time helpers / React composition | Three timestamp formatters, two equivalent parsers, and repeated desktop/mobile Customizer wiring.                              | Use `lib/time.ts` and one Customizer props object; serialize cue revisions only when cues change.                        | Removes view-to-view formatting dependencies and repeated wiring/work.             | Low                                                                              |
| P3 — `lib/media-audio.ts`             | Range decoding fetched the start buffer separately before an iterator that already includes it.                                 | Consume the iterator directly.                                                                                           | Removes duplicate leading decode/copy work while retaining exact PCM.              | Low: nonzero-start sample equality test.                                         |
| P2 — unused code and documentation    | Uncalled wrappers/exports, an unused vendor stylesheet, obsolete release/roadmap text and an overly absolute privacy statement. | Remove unreachable source; qualify optional Gemini uploads and mark historical guidance.                                 | Smaller active API surface and clearer setup/privacy guidance.                     | Low: reference tracing, CSS equivalence and browser checks.                      |

## C. Cleanup and quantitative comparison

Removed files:

- `vendor/shadcn-tailwind-4.13.0.css` (16,041 bytes).
- Its paired `vendor/shadcn-tailwind-4.13.0.LICENSE.md` (1,063 bytes).

Removed implementations/declarations: `activeSubtitle`, `createMdxSTFT`,
`geminiServerLimits`, `GeminiProviderContent`, `WhisperAudioSegment`, the unused
model-license notice constant, and the two unused DSP scan-count aliases.
Removed unused AlertDialog action/media/trigger, Dialog trigger/close/footer,
and Drawer trigger/close/footer wrappers. Internal portal/overlay wrappers and
button variants remain private where needed by active components.

No dependencies were removed: all 12 runtime and 15 development dependencies
have active source, configuration, test or build consumers. Dynamic imports,
worker entry points, benchmark/diagnostic APIs, legacy project migrations,
JavaScript fallbacks and the optional temporal DSP capability were retained.
Generated DSP assets remain tracked and unchanged.

| Metric                                |  Before |   After |
| ------------------------------------- | ------: | ------: |
| Hand-authored production source files |      86 |      87 |
| Production source lines               |  21,175 |  21,069 |
| Node regression test files            |      20 |      24 |
| Runtime / development dependencies    | 12 / 15 | 12 / 15 |
| Tracked files, including this report  |     151 |     155 |

Production counts cover `.ts`, `.tsx`, `.mjs` and `.rs` under `app`,
`components`, `hooks`, `lib`, `api`, `scripts` and the Rust crate's `src`.
They exclude tests, styles, generated bindings and documentation. The new time
module and four regression files explain the increased file count. Line counts
are descriptive, not a quality measure.

The stylesheet deletion is source cleanup, not a claimed runtime speedup.
Compiling current CSS and the same CSS with the original vendor definitions
restored produced byte-identical Tailwind/PostCSS output: 102,185 bytes,
SHA-256 `e0067df58c850a2f85dd0438dc2e56177ab902b5e3491264e694640a0d4ae1c7`.

## D. Validation

Environment: Linux cloud executor, Node 24.19.0, pnpm 11.25.0; pinned Rust
1.85.1 with wasm-bindgen CLI 0.2.100 installed into temporary directories.

| Exact check                                                            | Baseline              | Final                            |
| ---------------------------------------------------------------------- | --------------------- | -------------------------------- |
| `pnpm install --frozen-lockfile`                                       | Passed                | Lockfile/dependencies unchanged  |
| `pnpm lint`                                                            | Passed                | Passed                           |
| `pnpm exec tsc --noEmit --incremental false`                           | Passed                | Passed                           |
| `pnpm test`                                                            | Passed: 20 test files | Passed: 24 test files            |
| `pnpm build`                                                           | Passed                | Passed                           |
| `pnpm format:check`                                                    | Passed                | Passed                           |
| `cargo test --locked --manifest-path crates/pulseframe-dsp/Cargo.toml` | Not run before edits  | Passed: 11 tests                 |
| `pnpm format:rust:check`                                               | Not run before edits  | Passed                           |
| `pnpm dsp:build`                                                       | Not run before edits  | Passed                           |
| `git diff --exit-code -- public/dsp` after regeneration                | Not applicable        | Passed: all four files identical |
| `git diff --check 564ba43`                                             | Clean checkout        | Passed                           |

New regressions cover successful/corrupt cached model reads, timeout and parent
abort with stalled reads/cancellation, exact nonzero-start decoded PCM, valid
100-second development requests, over-limit/error responses, and timestamp
behavior. Existing tests verify project migrations, preset metadata/reset,
export snapshots/cancellation, preview seek replay and compiled WASM parity.

The production build retains the existing warning about a chunk over 500 kB.
No general export-throughput or memory-reduction claim is made.

Two temporary Python Playwright scripts exercised the local Vite development
server with system Chromium. Results, scripts, check logs and output artifacts
are retained locally in ignored `outputs/review/`; they are not new project
dependencies or a committed browser test suite.

| Browser workflow                     | Observed result                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Media loading and failed replacement | An 8-second WAV loaded; invalid replacement retained the active source and playable track.                                                                                                             |
| Playback, pause and seek             | Playback advanced; pause stopped it; Home/End seeking reached 0 and 8 seconds.                                                                                                                         |
| Settings and Quick Looks             | Built-in look applied; a named local Quick Look saved and applied.                                                                                                                                     |
| Project save/restore                 | A 1,537,556-byte project restored media and the portrait canvas after settings changed.                                                                                                                |
| Canvas / PNG capture                 | Exported a valid 720 × 1280 PNG, 1,051,899 bytes.                                                                                                                                                      |
| Actual video encoding and decoding   | Selected 1.5 seconds at 480p/24 fps; produced a 515,328-byte WebM with VP9 video and Opus audio. `ffprobe` reported 1.52 seconds; `ffmpeg -v error -i <export.webm> -f null -` decoded it with exit 0. |
| Export cancellation                  | Canceled during Rendering frames; returned to idle and observed no subsequent download.                                                                                                                |
| WASM and JavaScript paths            | Instrumented worker `ready.backend` messages reported `wasm` normally and `js` with `?dsp=js`; the forced JS path made no WASM asset requests.                                                         |
| Video input                          | Generated 3-second MP4 with AAC audio imported as VIDEO and playback advanced.                                                                                                                         |
| Five-minute workload                 | A 57,600,078-byte stereo WAV loaded to 300 seconds and sought to the end.                                                                                                                              |
| Simulated mobile layout              | At 390 × 844, document/body widths remained 390 with visible canvas and playback controls.                                                                                                             |

The main workflow run recorded zero page errors, console errors or failed
requests. MP4 and five-minute import checks also recorded zero page errors.
These are local headless Chromium results, not hosted production or physical
mobile-device measurements. Cancellation cleanup and stale resource handling
also retain the existing simulated lifecycle regressions. The browser JS check
forces the supported fallback; it does not simulate every WASM failure mode.

## E. Remaining technical debt

- **Coverage follow-up:** the repository has no committed browser E2E suite.
  This review's browser checks exercise real Chromium but are temporary scripts;
  the Node tests primarily transpile source and simulate browser resources.
  Persist a small stable lifecycle/export smoke suite when browser CI is added.
- **Malformed PCM robustness:** equal-rate paths in `lib/lyrics/audio.ts`
  (around lines 125 and 221) copy or retain samples without the non-finite
  filtering used by the resampling path. NaN/Infinity input could reach local
  inference. A future fix should preserve source ownership and copy only when
  cleanup is necessary, with malformed-input regressions.
- **Profile before redesign:** position updates from `use-media-session.ts`
  still rerender the editor about every 150 ms during playback. Subtitle
  revision serialization is now cached, but relocating transport subscriptions
  or memoizing large views needs workload profiling first.
- **Measured responsiveness limit:** five-minute prepared export response
  warm-up took roughly 130–167 ms on this executor for 9,000 stereo envelope
  frames. It remains synchronous. Physical mobile measurements or an observed
  responsiveness problem should justify any asynchronous replay change.

The model/license provenance limitations documented in
`automatic-subtitles.md` are unchanged. Physical mobile devices, all browser
codecs and hosted Vercel behavior require separate validation. Live Gemini
provider calls and full local inference/model downloads are not claimed as
verified by this refactor.

Do not implement playlists, global state infrastructure, additional workers,
speculative caches or a Rust rewrite of stable TypeScript without a concrete
requirement and measured benefit.

## F. Overall assessment

**Original: 7.5/10. Refactored: 8/10.** These are engineering assessments of
ownership clarity, cohesion, contract consistency, lifecycle guarantees,
testability and active surface area, not objective measurements.

The baseline already protects sophisticated audio/export behavior well. The
improvement is deliberately incremental: fewer duplicated contracts and unused
entry points, reliable cached-stream cancellation, clearer documentation and
stronger behavioral tests. Remaining large modules are cohesive enough that
splitting them solely to reduce line counts would add risk without demonstrated
maintenance benefit.
