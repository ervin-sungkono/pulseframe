# Release studio validation

Performed on 9–10 October 2026 against the implementation branch. Browser checks
used local Vite servers and headless Chromium 151.0.7922.173 on Linux. Mobile
checks used a 390 × 844 viewport; they were emulation, not a physical device.
Media remained local. These results do not establish hosted Vercel behavior.

## Automated checks

- All 30 Node test files passed. The behavioral suite covers DSP parity, project compatibility,
  composition bounds, captions, profile contracts, normalized audio, playlist
  frame/sample boundaries, export transactions and queue lifecycle.
- The real project-track hook is exercised with delayed activations: selecting
  another row does not cancel activation, while starting a competing activation
  prevents the earlier request from committing.
- TypeScript production build, ESLint, Prettier and whitespace checks passed.
  No Rust source or generated WASM assets were changed.

## Browser and exported-file checks

| Flow | Performed check | Result |
| --- | --- | --- |
| Continuous playlist | Export 2.137 s at 44.1 kHz mono followed by 1.953 s at 48 kHz stereo, using WASM | WebM contains VP9 854 × 480 at 30 FPS and Opus 48 kHz stereo. FFmpeg decodes the complete output; frequency windows confirm 440 Hz then 660 Hz audio across the cut. Container duration is 4.100 s, including frame rounding. |
| File destination | Write the playlist to a real origin-private filesystem writer | Successful finalization commits; cancellation during frame production aborts without a commit. This bypasses native picker permissions. |
| Folder retry | Abort positioned writes to a new OPFS entry and retry the same name | Canceled entry is removed; retry commits successfully. Automated tests also preserve existing, committed and externally changed entries. |
| Short source audio | Export a 14 s source video with 1 s audio, selecting an overlapping range and ranges after audio, including after analysis preroll | Single-track and playlist outputs decode with FFmpeg; overlap retains sound and the unavailable tail is silent. |
| JavaScript fallback | Disable WASM through `?dsp=js` and export one second at 480p / 24 FPS | WebM decodes completely with FFmpeg. |
| Release package | Inspect a rendered PNG, queue full video / portrait teaser / thumbnail, download serially | All three requests complete. FFprobe reports 854 × 480 and 480 × 854 at 30 FPS; both videos decode completely. PNG is 854 × 480. |
| Composition | Select and edit canvas elements and promo text before release export | Browser interaction and selected-time preview complete without uncaught page errors. |
| Artist branding | Save an uploaded PNG in IndexedDB, reload, export `.pfartist`, import into a fresh context, apply | Blob survives reload and portable transfer; stored profile excludes track/caption/release content. |
| Captions | Import Unicode/multiline SRT, review three cues, offset by 0.5 s, undo, export SRT/VTT and selected-range sidecar | Full exports preserve cues; range export clips and rebases timing. |
| Palette and clips | Sample a PNG palette, explicitly apply a color, preview and use a 15 s sample-track suggestion | Controls complete without uncaught page errors. Suggestions use existing analysis; they do not claim chorus detection. |
| Responsive editor | Exercise caption/editing flows at desktop and 390 px mobile viewport | No horizontal page overflow at 390 px. |

Cold short-export and release-package browser runs produced no uncaught page
errors. Audio checks used deterministic generated WAVs so frequency and duration
could be independently checked. Tests exercise WebM because this Chromium build
does not provide an AAC encoder for the MP4 path.

## Five-minute workload

A generated 300-second, 44.1 kHz mono track was decoded, analyzed with WASM and
exported at 854 × 480 / 24 FPS through a physical origin-private filesystem
writer. The completed export contains 7,200 submitted frames and approximately
64.7 MB of encoded data in nine positioned writes. After the physical writer
committed, Chromium read the finalized file metadata and decoded a frame by
seeking to 299.5 seconds; the reported container duration was 300.020 seconds. The analysis
produced 9,000 envelopes. This run measured approximately 663 ms for initial
decoding, 4.9 s for initial analysis, and 156 s for export using the prepared
input. These measurements concern this generated input in this environment,
not a general device estimate or an export speed guarantee. The cold browser
run produced no uncaught page errors.

## Remaining verification limits

- Native save/directory picker permission prompts, disk-full behavior and
  physical mobile/touch interaction require a real supported user device.
- Stop waits for an in-flight codec or filesystem operation to settle. A stop
  during mux finalization can take longer than a stop between rendered frames;
  the export lock remains held through settlement.
- MP4/AAC output and Safari/Firefox need their own browser/device checks. Codec
  preflight selects available formats; successful WebM checks do not prove MP4.
- Vercel serves a static build. These local checks do not claim a hosted preview
  was tested or that production was deployed.
- In-memory output admission is an estimate, not an exact upper bound on codec
  output. A five-minute 480p test does not establish longer playlists or higher
  resolutions on low-memory devices.
- Vite reports large-chunk warnings and notes dynamic imports of modules that
  are also statically imported. The build succeeds; no bundle-size improvement
  is claimed in this change.
