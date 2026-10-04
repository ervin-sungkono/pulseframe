# Pulse Ring and glitch review — 2026-09-30

Reviewed the supplied “Punched up chorus with beat cut drop.mp3” using decoded stereo PCM at 48 kHz (162.923 seconds). The uploaded media is not included in the repository or deployed app.

## Findings and changes

- The global movement response hit its hard ceiling in 69.62% of analyzed frames at default settings. Soft saturation now preserves differences between loud sections: no frames reach that old ceiling. Smoothed energy p05/median/p95 is 0.687/0.806/0.837, with an observed maximum of 0.852.
- Raw audio measurements are unchanged: peak −0.258 dBFS, whole-track RMS −16.323 dBFS, and frame RMS p05/median/p95 −28.902/−17.222/−12.419 dBFS. The change affects artistic movement, not PCM analysis, audio playback or the minimum sound threshold.
- Ring contours now interpolate neighboring frequency bands and blend stereo boundaries at the poles. Mirrored waves combine channel power, so one-sided or opposite-phase audio remains represented. The same contour calculation applies to all ring layers.
- Rear rings use 30% opacity by default, with successively quieter rear layers; the primary ring remains fully opaque. Users can adjust rear opacity from 0–100%.
- Optional glitch bursts use source timestamps and audio activity. Strength is adjustable. The effect is skipped below the sound threshold and when reduced motion is active. Logos, labels and subtitles are drawn after the distortion.

## Verification and limits

Rendered actual Canvas output at eight points spanning the uploaded track, including its quiet ending, and compared clean/glitch frames during active sound. The baseline ring remains visible in silence. Tests cover calibrated tones, causal analysis, opposite-phase stereo, synthetic kicks, quiet noise, mirror symmetry, contour seams, transparency, repeatable glitch timing, reduced motion, project compatibility and all export ratios. TypeScript and the production build are checked before publication.

The existing cut-to-impact detector reports zero events for this track; its analysis was not changed. The file name alone does not provide reliable annotations for musical drops, and this review does not claim beat-by-beat ground-truth accuracy. Native Canvas verification does not replace physical mobile or browser codec/export testing.
