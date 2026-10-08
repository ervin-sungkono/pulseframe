# Pulseframe

A browser-based music visualizer built with React, TypeScript and Vite, deployed
as a static site on Vercel. Audio/video decoding, Rust/WASM analysis, canvas
rendering and video export run on your device. Media is never uploaded.

## Development

Use Node.js >=22.13.0 and pnpm 11.25.0 (pinned in `package.json`).

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

```sh
pnpm test
pnpm lint
pnpm build
pnpm preview
```

The build type-checks the project and writes the static site to `dist/`.
`pnpm preview` serves that production build locally. Both development and
preview accept Vite's `--host` and `--port` arguments. No database, authentication
provider, execution profile or runtime environment variables are required.

## Deployment to Vercel

Import `ervin-sungkono/audio-visualizer` in Vercel and select the Vite framework.
`vercel.json` configures a frozen pnpm install, `pnpm build` and `dist/` output.
Use the repository root as the project root. Git integration builds PR branches
as previews and deploys `main` to production after merge. This migration PR is
stacked on the WASM PR; merge that prerequisite before retargeting the migration
PR to `main`.

Vercel serves generated files in `public/dsp/` at `/dsp/`. A deployment needs
only Node/pnpm, not Rust. Rust is needed only to regenerate the checked-in engine
assets; see [DSP engine](docs/dsp-engine.md).

## Quick Looks and projects

Personal Quick Looks are saved in this browser and site origin. They survive
reloads, support search, pinning, ordering, renaming and deletion, and do not
require sign-in. They are not synchronized across devices, browsers, preview
URLs or the production domain. Browser storage limits apply; clearing site data
removes the saved library. Media, images, subtitles and track text remain outside
presets. See [Personal Quick Looks](docs/personal-quick-looks.md).

Project files still store the full editor state and source media on your device.
They are the portable way to move a project between installations. Existing
ChatGPT Sites account presets do not transfer automatically: apply a saved look
on the old site, save a project with media, open that project here, then save its
appearance as a new local Quick Look. Repeat for additional looks you want to
keep. The migration does not delete the old site's D1 data.

Export supports 480p, 720p, 1080p and 1440p, 24/30/60 fps, optional video
compression off by default, and device-specific duration estimates. See
[export settings](docs/video-export.md).

## Architecture and checks

See [architecture](docs/architecture.md), [migration review](docs/vercel-migration.md)
and [AGENTS.md](AGENTS.md). React views present the editor, controller hooks own
its lifecycle, and shared models define settings, file contracts and DSP.

CI verifies Rust tests, generated WASM reproducibility, application regressions,
lint, type checks and the Vite build. Browser verification must also confirm the
emitted worker activates WASM and a short exported video decodes successfully.
