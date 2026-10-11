# Automatic song subtitles

The Subtitles dialog generates cues for the complete active track. Video export
trims and rebases the applied source-time cues through the existing
subtitle/export contract.

## Methods and presets

On device is the default. A separate, lazily created worker performs processing;
it does not share the visualizer's DSP worker. Fast uses multilingual Whisper
tiny (q8) directly. Auto uses tiny and adds Kim Vocal 2 isolation only when the
worker's GPU and estimated memory capabilities admit it. Quality keeps Whisper
base (q8) and vocal isolation at 50% overlap; a backend failure must not silently
turn it into Fast. Language detection is automatic. No method change starts work
or uploads media automatically.

Gemini is optional. Prepared mono PCM16 WAV chunks are sent to the same-origin
`/api/lyrics/transcribe` Vercel Function. **The browser never calls Google
directly.** The Function uses a supplied client session key first. Only an absent
client key permits `GEMINI_API_KEY` fallback; a rejected client key does not
trigger a second request billed to the server key. Fast and Auto use one pass;
Quality can recheck uncertain chunks within a bounded extra-request budget.

The client key exists only in React/session memory and request headers. Disconnect
clears it. It is excluded from project files, Quick Looks, local/session storage,
URLs and logs. The server key is never returned to the browser. Cloud consent
states that audio goes to Google and API usage may incur charges. Cancel stops
future uploads and requests where possible; it cannot reverse a provider charge
for an already accepted request.

## Vercel setup

Keep the existing Vite deployment and `dist/` output. The new Node.js Function is
declared under `api/lyrics/transcribe.ts`; it does not need a database, account
service, container or durable queue. Each request contains at most 60 seconds of
24 kHz mono PCM16 audio: 2.88 MB WAV payload, approximately 3.84 MB after base64,
with bounded JSON overhead below Vercel's 4.5 MB request limit. The next chunk
waits for the previous one. There is no server-side full-song/video encoding.

The [Gemini audio documentation](https://ai.google.dev/gemini-api/docs/generate-content/audio)
states 32 audio tokens per second: five minutes is about 9,600 input audio tokens
before chunk overlap, prompts and output. Compressing the codec or reducing its
bitrate does not itself reduce those duration-based tokens. Each two-second
overlap repeats about 64 audio tokens. Mono WAV avoids another browser encoding
dependency and supplies exact sample-duration checks; it can be larger than an
original compressed MP3. Smaller Opus uploads could help a measured transport
bottleneck, but require additional codec/timestamp validation and do not promise
faster provider inference. The current response asks only for timestamped text
and bounded uncertainty flags; Pulseframe assigns block IDs and converts times
to the existing seconds contract locally. Successful chunks are reused on retry.

In Vercel Project Settings → Environment Variables, optionally configure
`GEMINI_API_KEY` as a sensitive server environment variable for the environments
that should offer the fallback. Redeploy after changing it. Never name this key
`VITE_GEMINI_API_KEY`: Vite-prefixed values are public. A deployment without the
server key still supports client session keys. Do not paste keys into issues or
pull requests. `GEMINI_MODEL` can override the internal provider model without
adding a model picker to the UI.

For local development, put the same server variables in an ignored `.env.local`
and run `pnpm dev`. Vite's development-only middleware invokes the same Web
handler used by the Function. It is not included in the browser bundle.
`pnpm preview` serves static production assets; use Vercel development or a
Vercel preview to exercise a real deployed API.

The server validates origin, request size, WAV format and response structure, and
applies bounded execution/retry limits. Process-local admission limits are only
best-effort protection for one warm Function instance; they are not a global
spending limit. If enabling the shared server key on a public deployment, set
Google project quotas/billing alerts and the appropriate Vercel Firewall request
limits. An anonymous same-origin endpoint does not authenticate a person.

## Runtime assets and media ownership

Pinned browser dependencies are `@huggingface/transformers@3.8.1` and direct
`onnxruntime-web@1.22.0`. Transformers has its own runtime build. The preparation
script copies their respective WASM/module assets to separate `whisper-ort/`
and `mdx-ort/` directories before development/build. These generated directories
are ignored by Git. Model weights are pinned remote artifacts, not repository or
deployment assets; first use requires downloading them, and browser caching is
optional. See the model constants for exact revisions and Kim's expected size
and SHA-256.

The pnpm build policy explicitly disables scripts for the transitive Node-only
`onnxruntime-node` and `sharp` packages and the optional `protobufjs` version
warning. Browser audio inference uses the packaged Web runtimes, so these scripts
are unnecessary. Keep strict dependency-build checks enabled for new packages.

COOP `same-origin` and COEP `credentialless` are configured in development and
Vercel. Worker thread policy also checks browser capabilities; an environment
that cannot provide shared memory uses one thread. Cross-origin resources must
work without credentials or explicitly support the isolation policy. Embedding
this editor into another site's iframe may require different headers.

Generation admits sources up to 100 MiB and ten minutes, subject to an additional
estimated memory budget. It reuses retained full-track PCM when available;
otherwise it decodes only audio. Worker transfers contain owned copies and never
detach the media session's arrays. Resampling and vocal isolation do not alter
playback audio. Model/session resources are released before advancing stages or
on worker teardown. Successful local jobs terminate their worker so the runtime's
WASM heap can be reclaimed; recoverable failures retain compatible work for
retry. Performance varies substantially with browser, GPU, memory,
model cache and the source; the limit is not a guaranteed processing time.

## Results and recovery

Generation holds the editor/export lock until its job settles. Closing the dialog
does not hide the running job: the Subtitles button reopens its status. Existing
cues remain untouched on cancel/failure/empty output. With existing cues, a
successful result asks for replacement; declining still permits generated-file
downloads. Nonempty results apply automatically to an empty track. Source and
cue revisions guard asynchronous application. Generated results are not new
project metadata: applied cues use the existing IDs/seconds contract and round
trip through project files.

Preview and video export show every active nonblank subtitle block in start-time
order, with earlier starts above later ones. Equal starts retain their existing
order. End times are exclusive: `[1, 3)` and `[2, 4)` show both blocks from
second two until second three. The shared canvas renderer wraps each block and
fits the stack to its caption area; dense overlaps or a small custom area can
reduce readability. Stored cue times and downloaded files are unchanged.

SRT, VTT, LRC and JSON downloads contain complete normalized generated cues, even
when they exceed the editor's 500-cue / 600-character application limits. Review
machine-generated words and timings. Singing, accompaniment, repeated passages
and multilingual material can reduce recognition accuracy. Gemini timestamps
are estimates rather than an audio aligner's measurements.

Successful cloud chunks and compatible local intermediate work may be retained
only in bounded session memory for retry. Changing the source, method, key or
processing policy invalidates incompatible work. Retries after an unknown cloud
outcome may incur another charge and must disclose that uncertainty.

## Validation status

The feature was originally exercised while stacked on a separate editor branch.
This standalone port is based on main and removes that branch's playlist,
composition and release code. Re-run the relevant automated checks and browser
flows against the main-based preview before merging; prior stacked-branch results
do not verify this port.

## Model provenance

Whisper Tiny is pinned to
`ff4177021cc41f7db950912b73ea4fdf7d01d8e7`; Base is pinned to
`1846881b6b3a3024392c1eea3ad983695bc23925`. Both use the converted q8
`encoder_model_quantized.onnx` and `decoder_model_merged_quantized.onnx`
artifacts, not unpinned aliases.

Kim Vocal 2 is pinned to UVR resources revision
`83719e1e624d07842f914d856722af6f463e88cb`, with 66,759,214 expected
bytes and SHA-256
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
Its upstream UVR settings use a tail-file MD5, rather than a whole-file hash;
the matching settings specify compensation `1.009`. The implementation keeps
that numerical contract separate from the download integrity check.

The pinned [Kim repository README](https://huggingface.co/Politrees/UVR_resources/blob/83719e1e624d07842f914d856722af6f463e88cb/README.md)
declares MIT, but a separate per-weight provenance/license statement was not
found. The converted [Whisper Tiny](https://huggingface.co/onnx-community/whisper-tiny/tree/ff4177021cc41f7db950912b73ea4fdf7d01d8e7)
and [Base](https://huggingface.co/onnx-community/whisper-base/tree/1846881b6b3a3024392c1eea3ad983695bc23925)
cards do not declare a license field; linked OpenAI model metadata declares
Apache 2.0 while the upstream source repository declares MIT. Those declarations
do not settle the converted-weight redistribution terms. No model weights are
bundled or committed; resolve those terms before redistributing weights.
