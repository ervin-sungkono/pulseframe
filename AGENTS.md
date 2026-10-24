# Pulseframe agent guide

These instructions apply to this repository and its subdirectories. Follow the
user's current instructions first. Inspect the active branch and working tree
before making changes; different worktrees may contain different feature sets.

## Project and scope

Pulseframe is a browser-based audio/video visualizer built with React,
TypeScript and Vite, hosted as a static site on Vercel. Personal Quick Looks use
validated browser-local storage. Audio analysis, canvas rendering and video
encoding run on the user's device; keep uploaded media local.

Read `docs/architecture.md` for the current architecture, feature contracts,
subtitle setup, export behavior and DSP requirements. Use the checked-out source
and `app/package.json` as the source of truth. The root package forwards commands
to the application package; shared build tools live in `scripts/`.

## Architecture and engineering principles

- Preserve the existing MVC arrangement: React components are views, hooks
  orchestrate controllers, and settings, validation, serialization and DSP
  calculations belong in UI-independent models.
- `app/components/Home/index.tsx` composes the editor; `app/components/` presents controls and dialogs.
  Keep audio analysis, persistence rules and export algorithms out of views.
- Components use PascalCase folders with their exported function in `index.tsx`;
  add `type.ts`, `const.ts` or `style.css` only for meaningful owned content.
  Use native nested CSS and kebab-case classes. Keep shared tokens global.
- `app/lib/hooks/` owns application orchestration, state transitions and cleanup.
  Delegate drawing to the canvas renderer rather than duplicating drawing code
  in controllers.
- `app/lib/` contains several roles, not just models. `audio/`, `media/`,
  `visual/`, `export/`, `persistence/`, `subtitles/` and `lyrics/` group the
  related modules; `dsp/` owns Rust/WASM adapters. Settings and file contracts
  must not depend on components or hooks. `visual/visualizer.ts` and its drawing
  helpers are canvas views. Media, encoding and persistence adapters own their
  concrete platform resources.
- Follow KISS, DRY, SOLID and YAGNI. Reuse existing defaults, contracts and
  configuration. Add abstractions only to solve a demonstrated responsibility
  or duplication problem. Remove obsolete code when replacing it.
- Preserve visual response, preset/project compatibility and exported output
  unless the task explicitly changes them. Keep speculative playlist support
  out of current single-track implementation; five-minute tracks are the
  present performance target.

## Media, DSP and export lifecycle

- Stage replacement media before committing it. Failed or canceled loads must
  retain the active project. Use existing generation/job checks to reject stale
  asynchronous work.
- Keep one owner for media elements, audio graphs, decoded audio, images,
  workers and object URLs. Release resources on replacement, cancellation and
  teardown. Do not copy entire tracks merely to hand work to an adapter.
- Snapshot export settings, subtitles and the selected range before asynchronous
  preparation. Retain source resources while the shared export lock is held;
  release that lock only after the job settles. Prevent late progress updates
  and downloads after cancellation.
- Keep automatic subtitle generation on the complete active track. Run local inference in its dedicated worker and route Gemini audio through the serverless endpoint only after explicit user consent.
- Keep video compression optional and off by default. It is video encoding
  compression, not ZIP packaging. Preserve the shared resolution and frame-rate
  contracts rather than introducing separate UI constants.
- Export estimates must reflect measured work on the current device. Separate
  preparation, rendering and finalization; learn rendering rates after warmup.
  Store only bounded, expiring successful-run timings and show uncertainty.

On branches containing `crates/pulseframe-dsp` and `app/lib/dsp`:

- Rust implements DSP calculations; browser/worker adapters manage WASM and
  application integration. Keep UI, canvas and encoding code outside Rust.
- Preserve the JavaScript fallback, initialization timeouts, version/schema
  checks, bounded worker chunks and cancellation behavior.
- Free WASM handles exactly once and refresh memory views after memory growth.
  Copy results that must outlive a WASM call; do not expose stale borrowed views.
- Regenerate `app/public/dsp/` through `pnpm dsp:build`; do not hand-edit bindings or
  binaries. Keep Rust and wasm-bindgen versions aligned with the checked-in
  toolchain, build script and lockfile.
- Benchmark analysis separately from decoding, rendering and encoding. Report
  device and workload limits; do not generalize a DSP speedup to total export.

## Development and validation

- Use Node >=22.13.0 and the pnpm version pinned in `package.json`. Keep installs
  locked and sequential. Preserve proxy/CA configuration and never disable TLS
  verification. The optional Gemini endpoint is the only server-side application feature.
- Common commands: `pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm build`,
  `pnpm preview`, `pnpm lint`, `pnpm typecheck`, and
  `pnpm test`.
- For Rust/DSP changes, also run
  `cargo test --locked --manifest-path crates/pulseframe-dsp/Cargo.toml` and
  `pnpm dsp:build`. Check regenerated assets against the intended source; the
  DSP CI workflow verifies reproducibility.
- Run checks appropriate to the change. Use behavioral tests for lifecycle,
  cancellation, DSP parity and file contracts. Documentation-only edits need
  content/diff review rather than application rebuilds.
- For browser changes, check relevant desktop/mobile flows. For DSP/export
  changes, verify actual WASM activation, a successful short export, exported
  file decoding, cancellation and JavaScript fallback. Exercise a five-minute
  track when changing analysis performance or memory ownership.
- Distinguish local, hosted, simulated and physical-device verification. Do not
  report a check as passed unless it was performed.

## Persistence, publishing and repository hygiene

- Use conventional commit subjects with `fix:`, `feat:`, `refactor:` or `chore:`
  followed by a clear description.

- Keep Quick Looks local to the browser and origin. Maintain validation, save
  confirmation, revision conflict handling and cross-tab refresh. Do not add
  account authentication or a persistence service without a concrete requirement.
- For Vercel deployment, use the Git-connected project and the reviewed commit.
  Use Vercel Root Directory `app`, allow source files outside that directory for
  shared scripts, and keep the Vite build and `dist/` output in `app/vercel.json`. Verify the
  hosted worker uses WASM and the exported video decodes, not just that assets load.
- Preserve project-file compatibility. Project files transfer media and appearance
  across browser origins; saved Quick Looks remain local to each origin.
- Do not expose tokens or bake secrets into source, logs or deployment archives.
  Respect `.gitignore`, including `build/`, `dist/`, dependencies, local runtime
  state, Rust target output and exported media. Generated DSP assets are an
  intentional tracked exception.
- Ask concise questions when material requirements are unclear; continue work
  that does not depend on the answer. For explicitly requested delegation, honor
  the user's model/effort selection (Luna 6 at max effort when requested), and
  independently verify delegated results before reporting completion.
