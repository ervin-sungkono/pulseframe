# Creator workspace split verification

PR #19 targets the performance/QoL foundation in PR #20. Merge #20 first.
The split keeps composition and responsive editing in #19; DSP preparation,
provider security, export capabilities, preview quality and Radial motion controls
are inherited from #20 without a second implementation.

## Architecture

- The history-managed `EditorDocument` groups appearance, composition, subtitles
  and output aspect. Composition validation and geometry remain React-independent.
- `Home/index.tsx` composes the workspace. Component folders own views, types and
  native nested CSS; controller hooks remain under `app/lib/hooks`.
- The interaction hook owns selection and canvas gestures. The image asset owner
  stages and releases browser resources; undo history stores document data.
- Preview, PNG capture and video export use the same composition renderer and
  absolute source time. Export snapshots clone document data and the image Map
  while retaining the actual image objects until the shared activity lock settles.
- Version-3 projects include composition image assets; v1/v2 readers still create
  a default composition. Quick Looks remain appearance-only. Creator templates
  configure composition and aspect separately from those Quick Looks.
- Instance palettes change colors only. Attached logos and circular visualizers
  share the smoothed motion envelope; a transformed-frame regression verifies
  matching rendered centers.

## Verification

The normal locked installation and production build pass in the independent
worktree. All **43 Node test files**, TypeScript, ESLint, Stylelint and Prettier
checks pass. Coverage includes legacy projects, version-3 asset round trips,
concurrent canvas edits, preview warming, motion synchronization, and export
snapshots remaining stable after the original composition and image Map change.

Luna user-style Chromium checks covered 1440/1100/1024/768/390/320 px. They
passed SRT import and cue-preview autoplay, text/shape/image editing, numeric
positions, bounded canvas dragging, undo/redo, and project save/reopen with
restored image pixels, text, Spectrum, square aspect and subtitles. No horizontal
overflow, page errors or external/model/cloud requests were observed.

The walkthrough caught a split regression: compact Subtitles used the old modal
and covered the preview. It now renders inline in the workspace at every size.
Retests at 1100/1024/768/390/320 px verified zero dialogs, visible preview centers,
and scrolling to the final cue without covering the preview. Design/Layers/
Subtitles navigation and Import/Generate tabs remain usable. Mocked generation
left Home and CustomizerPanel render counts unchanged across five progress ticks.
The primary agent reviewed the phone capture and widened the Done action to
match its editor panel.

A separate browser check confirmed WASM temporal analysis, saved a PNG containing
an edited text layer, and exported seconds 3–5 to an 854×480, 30 FPS VP9/Opus
WebM (816,875 bytes). FFmpeg decoded it completely; cancellation unlocked the
controls. JavaScript fallback playback reported temporal analysis unavailable,
as expected.

## Limits

Physical phone keyboards, native OS save-picker UI and real Gemini transcription
have not been tested in this split. The existing lazy inference chunks still
produce Vite's large-chunk warning. No production deployment is promoted by this
change. See [architecture.md](architecture.md) and the separate
[performance/QoL report](refactor-and-pr-split-report.md) for resource limits.
