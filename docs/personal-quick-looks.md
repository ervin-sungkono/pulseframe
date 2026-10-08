# Personal Quick Looks and customization

Quick Looks are reusable visual settings. Built-in looks have stable identifiers
and complete settings snapshots; their result does not depend on the previous
look or unrelated adjustments.

## Saving and applying

- Save Quick Look opens a confirmation dialog and pins the new preset. Nothing
  is stored before confirmation.
- My presets and My Quick Looks share the same browser-local records. Unpinning
  removes a shortcut, not its saved look.
- Applying a look preserves title, artist, media, images, subtitles, output
  format and export range. Presets contain appearance and audio-response settings.
- An edited applied look is marked Modified. Updating or saving a copy requires
  confirmation. The dialog captures settings when it opens and reuses a stable
  UUID on retry, preventing duplicate saves.
- Revisions reject stale updates and stale order swaps. Web Locks serialize
  mutations across same-origin tabs when supported. Without Web Locks, each
  read/modify/write is synchronous within its tab; simultaneous writes from
  different tabs are not guaranteed to be serialized.
- A pinned pair's positions are swapped in one storage write. Other tabs refresh
  on storage events. Name search and incremental library display remain local;
  the complete pinned collection is available independently of search.

## Storage and portability

The library uses the versioned `pulseframe.presets.v1` localStorage key. Stored
records are validated against shared settings/metadata contracts before use.
Unreadable data is reported without silently replacing it. A failed write does
not show a successful save or replace the previously stored library.

The library belongs to the current browser and origin. It survives reloads but
has no account sign-in or cross-device synchronization. Storage limits apply;
clearing browser site data removes it. Private browsing may have limited or
short-lived storage. Different preview URLs and production domains have separate
libraries.

Project files remain portable. To bring over a look saved on the old ChatGPT
site, apply it there, save a project containing media, open that project on
Vercel, and confirm saving the appearance as a local Quick Look. Existing D1
presets are not automatically transferred or deleted.

## Customization controls

Controls are grouped into Visual, Colors & background, Motion & effects, Audio
response, Logo and Track details. Sections collapse without losing their settings.
Numeric fields and HEX fields allow precise editing.

Reset appearance preserves track text and assets. Reset section uses the applied
look's baseline, or defaults if none is active. Undo/redo groups slider edits;
opening another project or replacing media clears settings history.

Appearance and asset controls are locked during export. Preview, still export and
video export use the existing Canvas renderer. Project-file compatibility is
unchanged.
