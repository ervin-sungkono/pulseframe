# Release studio

All media processing stays in the browser. Vercel serves the static application;
there are no accounts, upload APIs, paid rendering services or cloud queues.

## Workflow

1. Import audio/video or try the sample. Help opens the guided music → look →
   identity → export flow. Quick Look cards use the production canvas renderer
   with small representative synthetic inputs; they do not analyze the uploaded
   track or start another audio player. Animation is limited to visible,
   hovered/focused cards and respects reduced motion.
2. Choose **Edit canvas**. Select an element directly or with the element buttons,
   drag/resize, use arrow keys, or enter precise bounds. Escape cancels a gesture;
   a completed drag is one undo operation. Layouts are independent per aspect.
3. Upload cover artwork separately from the logo/background. Palette suggestions
   sample a bounded image and change colors only after explicit selection.
4. Save artist branding locally, or export/import `.pfartist`. Profiles omit
   songs, track titles, cue data and release-specific promo copy/visibility.
5. Import SRT/plain-text VTT, review before replacing cues, offset timing and
   export sidecars. Cue times remain source-local. Range exports clip and rebase.
6. Add tracks under Playlist. Select a row to edit metadata; activate it to load
   its preview. Reorder and trim tracks, with optional per-track cover artwork.
   Playlist export is one continuous video. Zero-length trims are skipped.
7. Create a release package: full video, editable portrait teaser, selected-time
   PNG. Inspect each output before queuing. Recipes persist in v3 projects and
   reset when track order/trims change so old ranges are not applied silently.
8. Add independent output snapshots to Batch. Rename, reorder or remove requests.
   Choose a directory when supported, or download one file at a time. Pause acts
   between files; Stop cancels current work. Retry skips completed items.

## Persistence and support boundaries

- Up to 20 tracks per project, 500 cues per track and a 2 MiB v3 manifest.
- Up to 20 export requests in one in-tab batch. Excess additions are rejected
  visibly. Queues do not survive reload and have no automatic background resume.
- Image byte/dimension budgets and audio-memory admission checks apply. A long
  playlist processes one source at a time; this does not guarantee any duration
  or resolution on every device. Surround audio is rejected rather than mixed
  silently. Five-minute mono/stereo tracks are the verification target.
- V1/v2 project files still open. New features save v3; older app versions cannot
  read that format. Project files embed original media bytes through Blob
  composition, without reading entire videos into JavaScript arrays.
- Artist profiles and Quick Looks belong to this browser/origin. Site-data
  deletion, quota limits and private browsing can remove or prevent local saves.
  Export profile/project files for portability and backup.
- File System Access is optional and browser-specific. Manual downloads remain
  available for bounded workloads. Keep the tab open during encoding.

## Verification

Behavioral tests cover project migration/round trips, composition bounds,
selected-time still isolation, normalized audio/sample counts, frame boundaries,
destination commit/abort, batch cancellation/retry, caption imports/timing/undo,
profile validation and clip scoring. Existing WASM/JavaScript parity and preset
metadata tests remain in the suite.

Local Chromium checks are recorded in `docs/release-studio-validation.md`.
Physical touch-device checks and native file-picker permissions require a real
user device. Headless emulation or an OPFS writer does not establish those results.
