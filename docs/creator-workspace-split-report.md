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

Final browser checks are recorded below after the desktop/mobile walkthrough.

## Limits

Physical phone keyboards, native OS save-picker UI and real Gemini transcription
have not been tested in this split. The existing lazy inference chunks still
produce Vite's large-chunk warning. No production deployment is promoted by this
change. See [architecture.md](architecture.md) and the separate
[performance/QoL report](refactor-and-pr-split-report.md) for resource limits.
