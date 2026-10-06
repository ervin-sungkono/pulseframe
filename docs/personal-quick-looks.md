# Personal Quick Looks and customization

Quick Looks are reusable visual settings. Built-in looks have stable identifiers
and complete settings snapshots; their result does not depend on the last look
or on unrelated adjustments made earlier in the session.

## Saving and applying

- Save Quick Look opens a confirmation dialog and pins the new preset to My
  Quick Looks. Nothing is sent before confirmation.
- My presets and My Quick Looks share the same account-backed records. Pinning
  adds a shortcut; unpinning keeps the saved preset in the library.
- Applying a look preserves the current title, artist, song/video, uploaded
  images, subtitle content, output format, and export range.
- Presets include visual mode, colors, motion, effects, sound response, logo
  layouts and opacity, and track-overlay styling/visibility. Images and media
  are never part of a preset.
- Relevant changes mark an applied look Modified. Update replaces its saved
  settings after confirmation; Save a copy creates a separate record.
- Settings are captured when the save dialog opens. Creation uses a stable UUID
  across retries. Updates carry the expected revision; conflicts keep the draft
  available so the user can review the latest saved version or save a copy.

## Customization controls

Controls are grouped into Visual, Colors & background, Motion & effects, Audio
response, Logo, and Track details. Sections can be collapsed without losing their
settings. Numeric slider fields and HEX fields allow precise editing.

Reset appearance restores defaults while preserving track text and uploaded
assets. Reset section restores that group's values from the applied look, or
application defaults if no look is active. Undo and redo support settings edits,
look application, and resets. Consecutive changes to one slider are grouped;
opening another project or replacing media clears the settings history.

Appearance and asset controls are disabled during export. Preview, still export,
and video export continue to use the same existing Canvas renderer. The project
file format is unchanged because it already stores the resulting visual settings.

## Database migration

Apply `drizzle/0001_personal_quick_look.sql` to the deployed D1 database before
deploying the new preset routes. It adds `pinned`, `quick_look_order`, and
`revision` columns and a user/pin/order index. Existing presets start unpinned,
with revision 1, and remain accessible through My presets.

The regular library retains timestamp/id pagination. Pinned records have separate
order/id pagination. Every read and mutation remains scoped to the authenticated
user. Settings updates, renames, pinning, and ordering increment the revision;
PATCH requires `expectedRevision`. A conflict responds with status 409 and the
current record. Invalid stored records are skipped without breaking other pages.

Moving a pinned preset up or down swaps two records through
`POST /api/presets/reorder`. Both records must still belong to the user, remain
pinned, and match their expected revisions. A single database statement updates
both records so a failed move cannot leave half of the swap applied.

## Runtime requirements

The app still relies on trusted ChatGPT Sites authentication and Cloudflare D1.
GitHub contains the source; it does not provide these runtime services.

The required Sites Vite plugin and its license live in `scripts/vendor/` so a
fresh checkout can resolve them while `/build/` remains ignored. Dependencies
and generated build output must not be committed.
