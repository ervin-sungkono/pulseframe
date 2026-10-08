# Vercel migration and YAGNI review

The migration is based on the WASM/export-estimate branch (PR #9). It preserves
the browser editor and uses a plain Vite/React static build on Vercel.

## Removed responsibilities

| Removed code | Reason |
| --- | --- |
| Sites manifest, vendored Sites Vite plugin, mock identity and ChatGPT auth helper | Vercel does not supply Sites dispatch or its identity headers. |
| Preset API routes, D1 adapter/schema/migrations and Drizzle tooling | Approved browser-local Quick Looks replace this server persistence path. |
| Vinext, Next/RSC integration, Cloudflare Vite plugin, Wrangler and Worker types | The editor is client React; the Vercel target needs no server rendering or Workers runtime. |
| Sites execution profiles, cache/install wrappers and bounded Vinext build wrapper | Standard locked pnpm installation and Vite build replace them. |
| Optional D1 notes example, R2 placeholder configuration, unused starter SVGs | No Pulseframe runtime consumer requires them. |
| Tracked TypeScript build cache | Generated, checkout-specific data is now ignored. |
| Sign-in/recovery UI, network fetch/abort/pagination state for preset requests | Local storage removes those requests; local search and incremental display remain. |

The existing Tailwind/shadcn styles and UI primitives are reachable and retained.
The Rust source, generated engine, JavaScript fallback, diagnostic/parity tests,
worker cancellation, live audio, demo, project files, canvas renderer, encoder and
ETA history are also retained. Test helpers and the explicitly requested DSP
capabilities are not classified as Sites-only infrastructure merely because they
lack a UI control. No new playlist, container, global state framework or generic
persistence-provider abstraction is introduced.

## Replacement boundaries

- `index.html` owns static metadata; `app/main.tsx` mounts the existing editor.
- `vite.config.ts` configures React, aliases and the existing module worker.
- `lib/preset-store.ts` validates and persists a versioned local library.
- `hooks/use-presets.ts` coordinates mutations, cross-tab refresh and presentation
  state. Views retain explicit save/delete confirmation and metadata behavior.
- `vercel.json` selects Vite with frozen pnpm installation and `dist/` output.

There are no backend credentials, auth providers or database services to provision.
Local preset storage is an approved behavior change: no cross-device sync, and
no automatic D1 transfer. See `personal-quick-looks.md` for the transfer path.

## Release and validation

Merge PR #9 first, then retarget this stacked PR to `main`. Vercel Git integration
can deploy the migration branch as a preview before either merge. Do not merge
or delete the old site as part of preview verification.

Required checks: locked installation, application tests, lint, type checking,
Vite build, DSP asset reproducibility, browser-local save/reload/search/pin/order/
rename/delete, actual WASM worker activation, JavaScript fallback, successful and
canceled short video exports, and decoding the exported artifact. Preview and
production origins intentionally have separate local libraries.
