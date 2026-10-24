# PR20 refactor and split report

PR20 is based on `main`: upstream `d995389` corresponds to local commit `f4c828b`. PR19 is stacked on PR20; creator composition and layout remain in PR19. The main snapshot had 15 component files: nine domain components and six shared UI wrappers, plus the Home entry view. All had active callers, so the audit did not remove working views or invent replacement dependencies.

## Refactor

Components now live in folders with `index.tsx` exports; nearby `type.ts`, `const.ts` and CSS files are kept with a component when useful. Application hooks live under `app/lib/hooks/`, alongside the controllers and models they coordinate. The empty, unused `vendor/.gitkeep` placeholder was removed.

Shared visual helpers now use the existing `app/lib/visual/styles/shared.ts` RGBA and clamp functions. Track timing uses the existing `formatTimestamp` helper. The detailed architecture and compatibility contracts are in [architecture.md](architecture.md).

Tooling now applies ESLint's recommended JavaScript, TypeScript and React Hooks rules to UI code without the previous blanket exemptions. End-of-line checks and Prettier formatting are enabled. Stylelint 16.25 with configuration 39 checks the native CSS; it accounts for Tailwind `@theme` syntax and retains documented local specificity exceptions.

## Verification

All 39 Node test files pass. TypeScript, ESLint and Stylelint checks pass. Formatting checks pass.

The browser layout comparison matched main's measured geometry at 1440, 768, 390 and 320 pixels, with no horizontal overflow detected. In the mocked subtitle-generation progress check, Home and CustomizerPanel each had zero extra renders; the comparison baseline had five.

The DSP benchmark used a real Node worker with WASM for 300-second inputs, one paired run per signal after an excluded warmup. It shows the added temporal/onset analysis cost, not a speedup: prepared scans retained 504,000 bytes of temporal frames and up to 9,584 bytes across about 599 events. Cancellation was acknowledged in about 11 ms after a 10 ms artificial scheduling window. These are Node-host measurements, not browser or phone latency claims.

A browser check activated WASM with temporal analysis, saved a PNG, and exported
seconds 3–5 as a 480p WebM (803,266 bytes), which FFmpeg decoded successfully.
The check canceled a subsequent export, verified its controls unlocked, and
loaded/played the JavaScript fallback with temporal analysis unavailable.
It exposed two integration issues fixed here: forwarding a click event as a file
destination, and export controls exceeding the desktop viewport. The callback
has a behavioral regression assertion; the dialog now scrolls, keeps actions
reachable, and hides settings while encoding.

| Five-minute input | Existing scan | With temporal preparation |
| --- | ---: | ---: |
| Mono pulse/tone | 1.220 s | 3.615 s |
| Mono silence | 0.986 s | 2.338 s |
| Stereo pulse/tone | 2.292 s | 4.884 s |
| Stereo silence | 1.847 s | 3.295 s |

Environment: Linux x64, Node 24.19, AMD EPYC 7763 host, three visible logical CPUs.
These scans exclude decoding, drawing and encoding. They measure the extra
onset capability against the same worker without that capability, not the
entire original application. One pair does not establish a statistical p95.

Physical phones, real Gemini requests, and native file-picker UI were not tested.
File transaction commit/abort and byte limits have automated coverage; the
browser export above exercised buffered output. Large inference runtimes remain
lazy chunks and still produce Vite's existing large-chunk warning.
