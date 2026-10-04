# Trap Nation-style response review — 2026-09-30

## References and scope

Reviewed the public [Trap Nation-style After Effects template](https://github.com/xanpj/trapnationscript/blob/master/Trap%20Nation%20Visualizer.jsx) and [js.nation](https://github.com/caseif/js.nation), plus representative visual reference images. These are community implementations, not access to Trap Nation's production settings or a same-song reference export. Pulseframe's renderer remains its own implementation.

The After Effects template concentrates its contour below 250 Hz, mirrors the spectrum, and gives its colored layers different audio durations. js.nation focuses on a subset of low FFT bins, draws curved mirrored contours, and trails colored spectra. Those traits explain the useful comparison: the classic appearance emphasizes bass shape and transient movement rather than a uniformly expanded full-range circle.

| Aspect | Pulseframe before this adjustment | Updated Pulse Ring |
| --- | --- | --- |
| Wave focus | 35 Hz–16 kHz log buckets around the circle | Default 35–450 Hz bass focus; optional Full sound |
| Contour amplitude | Compressed dB display values, softened again | Restore relative linear amplitudes, then bound displacement |
| Bass motion | Absolute bass level, with 170 ms release | Separate recent bass-rise response, with 85 ms release |
| Impact timing | 4096-sample spectrum window | Additional causal 1024-sample impact window; existing spectrum unchanged |
| Layer motion | Shifted versions of the current contour | Slower rear envelopes create transparent color echoes |
| Shape | Broad permanent ribbon, straight segments, heavy glow | Thin idle ribbon, curved peaks, lighter glow |
| Lighting | Rays saturated on most active frames | Ring lighting follows the impact response with a wider brightness range |

The bass focus extends above the reference template's range to include useful upper-bass texture in funk and pop. Full sound remains available for vocals and brighter arrangements. New sessions default to mirrored waves; saved mirror preferences are preserved. Logo aperture fitting, rear opacity controls, minimum sound threshold, visible idle shapes, glitch, and existing other modes remain available.

## Diagnosis and verification

The supplied 162.923-second stereo track showed limited contour contrast rather than widespread FFT clipping: only 0.08% of raw log-band samples reached 1. The previous ring mapping reduced median contour range by about 20%, then used a small radial displacement. In 25–90 seconds, the old bass response median was 0.871 and p95 was 0.977, holding motion near its upper range. This motivated separate contour and impact changes.

Afterward, the new impact response median/p95 over that same section is 0.198/0.686. Around the 74.3-second bass hit it peaks at 0.746, then falls to 0.360 after 100 ms and 0.064 after 300 ms. Ring beat rays now reach full brightness in 7.23% of that section, compared with 84.56% previously. All 4,887 analyzed frames retained finite response values and ring bands within 0–1; the quiet gate and existing bass envelope are unchanged.

Checked the actual Canvas renderer across eight positions in the supplied audio, its quiet ending, and glitch bursts. Automated checks include short kicks at 44.1/48 kHz, causal impact windows, phase-inverted stereo, sustained bass settling, trailing layers, bass/treble focus, mirrored seams, source-time warm-up, saved project defaults, quiet noise, fitted logos and all export ratios. The same analysis and response functions feed preview and selected-range exports.

The impact envelope measures local bass rises; it is not a trained beat classifier. The spectrum retains its 4096-point resolution, so nearby low frequencies cannot acquire extra detail merely through interpolation. The shorter impact FFT trades low-frequency resolution for timing, particularly below its first 46.875 Hz bin at 48 kHz. Device/browser codec export and direct synchronized comparison against Trap Nation's own version of the uploaded song are not covered by this offline review.
