# Historical feature notes

The account-backed preset implementation described below was replaced during the Vercel migration. Current behavior is documented in [Personal Quick Looks](personal-quick-looks.md).

# Presets, Spectrum and track overlays

Spectrum has adjustable rounded caps and a separate fading reflection, defaulting to 45% opacity at its waterline. Upper glow is clipped away from the reflection. Its midpoint remains centered, with bounds that reserve room for fitted logos, subtitles and track overlays.

Edge Bars is a third visual style: the top row grows downward and runs bass to treble; the bottom row grows upward and runs treble to bass. Both use the shared causal audio analysis. Height limits leave a central gap, including clearance for a fitted logo. Edge-positioned track overlays intentionally paint above the bars, using the selected shade or card for contrast.

Title/artist overlays support top, middle and bottom placement; left, center and right alignment; shade, card, accent and plain styles; three font families; weight, text colors, opacity, background color/opacity and responsive card corners. Settings are included in project files and visual presets, with defaults for older projects.

The separate Presets button opens an account-backed library. Each save first opens a confirmation popup with a name, visual summary, Cancel and Confirm save. Only confirmation submits the save request. The library supports applying, searching, renaming and confirmed deletion. It has no application-imposed preset count limit and uses paginated queries rather than loading every preset at once.

Presets contain visual settings, including logo layout and text styling. They exclude media, uploaded images, subtitle blocks, title and artist text. Applying a preset preserves the current song labels and project assets. Existing project save/open remains separate. Signed-out users can edit normally and sign in with ChatGPT for their own library; the UI reminds them to save their current project before the sign-in reload.

Preset routes use trusted server-side identity, user-scoped D1 queries, validated bounded inputs and same-origin write checks. The generated migration adds the preset table and its user/time index. Repeated save requests with the same ID are idempotent.

## Validation

- 59 automated checks pass, including existing audio/export regressions, all three visible silent styles, Spectrum bounds, rounded reflection paths, opposing Edge Bars frequency directions and fitted-logo clearance, overlay options, legacy migration and project round trips.
- API tests execute the generated migration against real SQLite with a D1 adapter. They cover sign-in requirements, cross-site writes, input validation, save retries, rename/delete, isolation between accounts and pagination through 125 presets.
- TypeScript and ESLint on changed sources pass.
- Native Canvas renders were reviewed for both bar styles at landscape, portrait and square ratios, and for all four overlay styles. A white-bar pixel check confirms the reflection is dimmer than the corresponding upper bar.
- Browser touch interactions, the production sign-in redirect and device-specific video export were not re-tested in this pass.
