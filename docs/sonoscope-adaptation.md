# Sonoscope improvements in Pulseframe

Reviewed the Sonoscope source at `cd2ee721c3dbbb8eeb07add7abca7475ec21f057` and its 2026-09-30 handoff. The Pulseframe baseline is retained as the pushed `v1Pulseframe` tag and saved hosting version 14.

## Implemented

- A shared, causal 4096-point calibrated PCM analysis path for preview and offline export. Stereo power averaging retains opposite-phase audio; 20 ms DC-removed RMS gates quiet noise. Audio measurements stay independent of playback volume and artistic sensitivity.
- Pulse Ring: a smooth circular contour with independent stereo texture and an always-visible resting shape. The six original modes, halo directions and per-mode logo fitting remain available.
- Local background images, cover-cropped for every canvas ratio, starting at 25% opacity. Optional drop accents add brief glow and image blur; images are sharp between events. Reduced-motion preferences disable the drop accents and decorative movement.
- A clickable, keyboard-accessible track waveform; restart, loop, volume, mute, playback shortcuts, focus view and an original 32-second sample.
- Validated media/image replacement with race protection, old project compatibility, and background assets included in project saves. Paused sound settings rebuild the held response.
- Deterministic full-track drop events, source-history warm-up and exact selected-range timing for export. Audio is encoded in five-second pieces to limit extra PCM memory. Long files can use native live analysis and bounded range decoding.

## Verification and limits

35 automated checks cover FFT calibration at 44.1/48 kHz, stereo phase, low/mid/high tones, kicks, DC, quiet audio, future-transient rejection, waveform peaks, detector resets, fractional range starts, trailing silence, actual WAV range decoding, live fallback, all seven silent styles at three aspect ratios, image compositing and v1/v2 project files. TypeScript and changed-source lint checks passed.

Drop detection is a conservative bass-return heuristic, not a trained musical-section classifier. Cached analysis budgets PCM and retained features together at 300 MiB. Live-only fallback has no full-track waveform; unsupported codecs may still prevent offline export. No device/browser export or mobile touch session was available during this pass, and representative user tracks were not supplied. Those remain useful follow-up validation alongside the synthetic tests and original demo.

Automatic subtitles remain a future API-backed feature in `roadmap.md`. No audio upload or API key integration was added.
