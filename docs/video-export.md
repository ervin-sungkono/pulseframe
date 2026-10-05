# Video export settings

Choose 480p, 720p, 1080p or 1440p. New sessions default to 720p. Resolution sets the short edge for landscape/portrait and the edge for square video. Dimensions use even pixels for codec compatibility (480p landscape is 854 × 480). Preview rendering stays lightweight; export uses the chosen output dimensions.

**Video compression** is optional and off by default. It downloads a normal MP4 or WebM, depending on device encoder support. It replaces ZIP compression entirely.

The option adjusts video encoding from Mediabunny's high quality (0.75) to a conservative 0.68 quality target. The encoder uses constant-quality quantizers where supported and variable bitrate otherwise. Frames are encoded directly once to avoid an additional lossy transcode. Resolution, frame rate, audio quality, duration and subtitles remain unchanged by this option.

This is lossy encoding designed for minimal visible change, not guaranteed perceptual identity. Fine detail, particles, gradients and rapid motion can show differences. File-size savings depend on the codec, device and clip; no fixed percentage is promised. Disable compression when maximum detail matters.

Project files retain resolution and video compression, with backward-compatible defaults. Old ZIP settings are ignored rather than silently enabling lossy encoding. Old Standard/Smaller choices map to the new resolution presets. Export controls remain locked during rendering, and cancellation prevents a download. A device without a compatible encoder for the selected dimensions reports an error; the app does not silently lower the resolution.
