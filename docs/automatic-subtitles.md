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
trigger a second request billed to the server key. Fast and Auto transcribe the
original mix. Quality first isolates vocals on device through the existing
subtitle worker's isolation-only mode; it does not load Whisper for this path.
Isolation failure stops Quality rather than uploading the original mix silently.
Song language defaults to Auto, with optional hints from Google's supported
language table. Local language detection remains automatic.

The client key exists only in React/session memory and request headers. Disconnect
clears it. It is excluded from project files, Quick Looks, local/session storage,
URLs and logs. The server key is never returned to the browser. Cloud consent
states that audio goes to Google and API usage may incur charges. Cancel stops
future uploads and requests where possible; it cannot reverse a provider charge
for an already accepted request.

## Vercel setup

Keep the existing Vite deployment and `dist/` output. The new Node.js Function is
declared under `api/lyrics/transcribe.ts`; it does not need a database, account
service, container or durable queue. Each request contains at most 100 seconds of
16 kHz mono PCM16 audio: 3.20 MB WAV payload, approximately 4.27 MB after base64,
with bounded JSON overhead below Vercel's 4.5 MB request limit. The next chunk
waits for the previous one. There is no server-side full-song/video encoding.

The default model is `gemini-3.5-transcribe`, using the documented
[transcription API](https://ai.google.dev/gemini-api/docs/transcribe). The Function
uploads each WAV through Google's Files API, then calls Interactions with that
file URI, an optional language hint, and verbatim word timestamps. It deletes
the uploaded file after the attempt; if deletion fails, Google may retain it for
up to 48 hours. Timed word annotations are grouped into bounded subtitle phrases
and validated before returning Pulseframe's existing JSON contract.
Word annotations may provide text directly or UTF-8 byte indices into their
containing text block. The parser handles both, preserves sub-millisecond
intervals, orders words by time, and keeps point-timed tokens inside a timed
phrase without inventing a new cue duration. Phrase limits scale with chunk
duration.

Google permits up to 30 minutes with word timestamps, but the Vercel request
size limit bounds each upload to 100 seconds here. A five-minute track uses four
requests with two-second overlap. Mono WAV avoids an extra browser encoder and
supplies exact sample-duration checks. Reducing upload bytes does not guarantee
lower provider cost or faster inference. Successful chunks are reused on retry;
changing the selected language invalidates incompatible cached results.

In Vercel Project Settings → Environment Variables, optionally configure
`GEMINI_API_KEY` as a sensitive server environment variable for the environments
that should offer the fallback. Redeploy after changing it. Never name this key
`VITE_GEMINI_API_KEY`: Vite-prefixed values are public. A deployment without the
server key still supports client session keys. Do not paste keys into issues or
pull requests. `GEMINI_MODEL` can override the model with a transcription-compatible model;
general text-generation models do not support this request format. No model
picker is exposed in the UI.

For local development, put the same server variables in an ignored `.env.local`
and run `pnpm dev`. Vite's development-only middleware invokes the same Web
handler used by the Function. It is not included in the browser bundle.
`pnpm preview` serves static production assets; use Vercel development or a
Vercel preview to exercise a real deployed API.

If Gemini rejects a session-key request, inspect the returned error code.
`account_precondition` means the Google project needs attention; free-tier
regional availability or billing can be the cause. `rate_limit_or_quota` means
the key reached a Google limit, while `invalid_request` points to a rejected
model/request shape. Only `provider_unavailable` indicates a temporary provider
failure. The Function logs Google's HTTP status and status name, but never the
key, audio, or provider message. Vercel Hobby runtime logs have short retention,
so inspect them soon after reproducing an issue.
Timestamp-response validation errors include a fixed `responseIssue` code,
such as `missing_word_annotations` or `word_timing_out_of_bounds`. The Function
logs that code and the chunk index. For invalid intervals, `responseTiming`
includes only numeric start/end/chunk duration and a fixed reason (reversed
interval or word starting outside the chunk), never lyric text or keys.
Word endings beyond the uploaded WAV are clipped to its exact duration when
that word starts within the chunk. These adjustments flag the chunk for the
existing bounded Quality recheck and show a timing-review notice if still
present in the final result. Fast and Auto keep their existing request budgets.
Minor reversed intervals of up to 100 ms are repaired by ordering the two
supplied endpoints, preserving the word without inventing a duration. This
flags the chunk for the same bounded Quality recheck and timing-review notice.
Larger reversals and words entirely beyond the upload remain invalid.

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

## Historical validation note

Earlier validation was performed while this feature was stacked on a separate
editor branch. That work did not verify the later standalone port. This note
records the limits of that earlier validation and does not report test or browser
results for the current checkout.

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

## Song language for on-device transcription

The same Song language control is available for on-device and Gemini generation,
with Auto as the default. Whisper Tiny and Base use 99 language tokens in their
pinned model configurations; this is not the expanded vocabulary of newer
Whisper models. Their sources are the [Tiny configuration](https://huggingface.co/onnx-community/whisper-tiny/blob/ff4177021cc41f7db950912b73ea4fdf7d01d8e7/generation_config.json),
[Base configuration](https://huggingface.co/onnx-community/whisper-base/blob/1846881b6b3a3024392c1eea3ad983695bc23925/generation_config.json),
and [OpenAI language names](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py).

`lib/lyrics/languages.ts` owns shared display names, provider-specific choices,
validation sets and method-switch conversion. Gemini retains its region/script
choices; Whisper uses its supported language tokens (including `jw` for
Javanese). Switching providers preserves exact supported selections, maps shared
languages and aliases (Mandarin/Chinese, Filipino/Tagalog, Norwegian), and resets
unsupported choices to Auto. Switching back to Gemini chooses its first listed
locale when a general Whisper language has multiple regional choices.

The controller snapshots the selected language for generation and retry. The
existing worker receives it and validates it before transcription. Each Whisper
window receives the same `language` hint, including when WebGPU falls back to
WASM. Auto omits the hint for model detection; `task: "transcribe"` keeps output
in the original language. Language changes invalidate the previous retry request
without discarding reusable audio preparation or reloading the same model.

## Editing while previewing

On desktop (861 px and wider), subtitles open in the right-hand controls column
in place of customization controls. The panel has independent scrolling, no
modal backdrop or focus trap, and works in focus view. The block action
**Play from here** seeks to its start and starts playback
without closing the editor; playback and live caption edits remain available.
Done, Close, or Escape from inside the panel restores customization controls
and returns keyboard focus to the subtitle button.

Narrower screens retain the modal editor; Play from here starts playback and
closes it to show the video. Both layouts share the same editor content and
generation controller;
resizing between them preserves subtitle blocks and the active generation job.

## Importing existing subtitles

The editor has a separate **Import** tab for SRT (`.srt`), WebVTT (`.vtt`),
LRC (`.lrc`) and subtitle JSON (`.json`). Import runs locally and never invokes
a transcription provider. Load the track first, choose a file, inspect the
block count, sample text and timing notices, then explicitly apply it. If blocks
already exist, the apply button states that it replaces all of them. Cancel,
invalid files, stale file reads and changed track/cue revisions leave the
current blocks untouched. Import is unavailable during generation or export.

SRT and VTT retain multiline text and overlapping cues, with supported caption
markup converted to plain text. VTT cue identifiers/settings and NOTE, STYLE
and REGION blocks do not become caption text. LRC supports repeated timestamps,
metadata, enhanced word tags and signed offsets: positive offsets move lyrics
earlier. LRC ends follow the next distinct timestamp (including blank clearing
markers), with the last line ending at the track boundary.

JSON accepts Pulseframe's downloaded `{ cues: [{ startMs, endMs, text }] }`
format or second-based `{ start, end, text }` cue arrays (also wrapped in
`{ cues: [...] }`). Imported IDs are replaced with fresh editor IDs. Timing
units cannot be mixed within a cue.

UTF-8 and BOM-marked UTF-16 files are supported, up to 2 MiB; existing editor
limits of 500 blocks and 600 characters per block apply. Track boundaries clip
partially overlapping cues and exclude wholly out-of-track cues, with notices.
Malformed active intervals and oversized results fail rather than silently
truncating content. Untimed text and ASS/SSA styling are not supported.

The editor opens on **Edit**, with the caption list directly accessible. **Import**
and **Generate** have separate tabs; switching tabs retains an import preview
and generation settings/results. Opening the editor during generation selects
Generate so progress and cancellation remain easy to find. Applying an import
or generated result returns to Edit and focuses its tab.

Play/Pause and the playhead time remain above the scrolling content. Add block
is always reachable in Edit and focuses the new caption field. Current blocks
are highlighted, Start/End labels remain compact, and tabs support arrow keys
and Home/End. Playback uses the existing media owner: seek followed by play,
rather than a toggle that would pause an already playing track.
