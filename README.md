# Pulseframe

A browser-based audio and video visualizer built with React, TypeScript and Vite.
Audio analysis, canvas rendering and video encoding run on the user's device.
Automatic subtitles can run locally; the optional Gemini method uploads audio to
Google only after the user chooses it and confirms generation. Current behavior,
architecture, privacy and runtime details are in
[docs/architecture.md](docs/architecture.md).

## Development

Use Node.js 22.13 or later and pnpm 11.25.0, pinned in the root package.
Commands run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm preview
```

`pnpm build` type-checks and builds the static app. `pnpm preview` serves the
production build. Run `pnpm dsp:build` only when regenerating the checked-in
Rust/WASM analysis assets; see the architecture guide for the required toolchain.

## Deployment

After the branch is merged, set Vercel's project root to `app` and allow the
build to access repository-root workspace and tooling files. The deployed
static app uses the checked-in DSP assets and does not require Rust. Gemini
subtitle generation requires a user-supplied session key through the same-origin
serverless function. Only the non-secret `GEMINI_MODEL` override is optional.

`pnpm lint` runs ESLint and Stylelint; Prettier handles spacing and newlines.
Components use `ComponentName/index.tsx` with optional owned types, constants
and styles; controller hooks live under `app/lib/hooks/`.
