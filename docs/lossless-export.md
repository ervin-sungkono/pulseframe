# Lossless export compression

The export dialog has an optional **Lossless ZIP compression** setting, off by default and saved in project files. Existing projects default to off.

After MP4/WebM encoding finishes, the browser packages the exact encoded video bytes into a single-file DEFLATE ZIP. It does not resize, change frame rate, decode, re-encode, or modify audio/video quality. Extract the archive to play its MP4/WebM member.

MP4/WebM files are already compressed, so further savings may be small or absent. The app compares the final ZIP size, including headers, with the original and downloads the original video if no space is saved. The completion message reports the result and percentage saved.

Compression runs locally with the native gzip CompressionStream. Its DEFLATE payload and checksum are reused in a standard ZIP container. The app preserves cancellation and export locks until packaging finishes, reads streams in chunks, and stops retaining compressed output once it cannot save space. Unsupported browsers and files beyond the non-ZIP64 size limit retain the original output.

Tests extract the ZIP and check byte-for-byte identity, checksums, filenames and directory offsets. They also check incompressible input, tiny files, cancellation and unsupported browsers.
