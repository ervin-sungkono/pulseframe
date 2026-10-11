import {
  GEMINI_AUDIO_CHUNK_MS,
  GEMINI_AUDIO_STRIDE_MS,
  GEMINI_MAX_BASE64_CHARS,
  GEMINI_MAX_CHUNK_COUNT,
  GEMINI_MAX_REQUEST_BYTES,
  GEMINI_MAX_SEGMENTS_PER_CHUNK,
  GEMINI_MAX_SEGMENT_TEXT_LENGTH,
  GEMINI_MAX_SOURCE_DURATION_MS,
  GEMINI_MAX_WAV_BYTES,
  GEMINI_SAMPLE_RATE,
  GEMINI_TIMING_BOUNDARY_TOLERANCE_MS,
  geminiProviderContentSchema,
  geminiSuccessResponseSchema,
  geminiTranscriptionRequestSchema,
  type GeminiTranscriptionRequest,
} from "./gemini-contract.js";

const PROVIDER_TIMEOUT_MS = 100_000;
const DEFAULT_MODEL = "gemini-3.5-transcribe";
const PROVIDER_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PROVIDER_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta/files";
type ServerConfig = {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  now?: () => number;
};

type KeyAdmission = { active: number; starts: number[]; touchedAt: number };
type ProviderAdmission =
  { acquired: false; retryAfterMs: number } | { acquired: true; release: () => void };
const keyAdmissions = new Map<string, KeyAdmission>();
const MAX_ACTIVE_PER_KEY = 2;
const MAX_REQUESTS_PER_KEY_PER_MINUTE = 24;

function keyFingerprint(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function acquireProviderSlot(key: string, now: number): ProviderAdmission {
  const id = keyFingerprint(key);
  for (const [knownId, admission] of keyAdmissions) {
    if (now - admission.touchedAt > 10 * 60_000 && admission.active === 0)
      keyAdmissions.delete(knownId);
  }
  let admission = keyAdmissions.get(id);
  if (!admission) {
    admission = { active: 0, starts: [], touchedAt: now };
    keyAdmissions.set(id, admission);
  }
  admission.touchedAt = now;
  admission.starts = admission.starts.filter((startedAt) => now - startedAt < 60_000);
  if (admission.active >= MAX_ACTIVE_PER_KEY) return { acquired: false, retryAfterMs: 1_000 };
  if (admission.starts.length >= MAX_REQUESTS_PER_KEY_PER_MINUTE) {
    return {
      acquired: false,
      retryAfterMs: Math.max(1_000, admission.starts[0] + 60_000 - now),
    };
  }
  admission.active += 1;
  admission.starts.push(now);
  if (keyAdmissions.size > 512) {
    const oldest = [...keyAdmissions.entries()]
      .filter(([, value]) => value.active === 0)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
    if (oldest) keyAdmissions.delete(oldest[0]);
  }
  return {
    acquired: true,
    release: () => {
      admission!.active = Math.max(0, admission!.active - 1);
    },
  };
}

type ApiErrorCode =
  | "invalid_request"
  | "invalid_audio"
  | "missing_api_key"
  | "invalid_api_key"
  | "permission_denied"
  | "account_precondition"
  | "billing_required"
  | "unsupported_model"
  | "rate_limit_or_quota"
  | "provider_unavailable"
  | "provider_timeout"
  | "blocked_response"
  | "invalid_json"
  | "invalid_response"
  | "server_configuration";

type TranscriptionResponseIssue =
  | "invalid_interaction_shape"
  | "interaction_not_completed"
  | "missing_word_annotations"
  | "missing_word_text"
  | "invalid_word_text_indices"
  | "missing_or_invalid_word_timing"
  | "word_timing_out_of_bounds"
  | "no_positive_phrase_timing"
  | "segment_limit_exceeded"
  | "invalid_subtitle_contract";

class TranscriptionResponseError extends Error {
  constructor(readonly issue: TranscriptionResponseIssue) {
    super(issue);
  }
}

function json(status: number, body: unknown, headers?: HeadersInit) {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("content-type", "application/json; charset=utf-8");
  resultHeaders.set("cache-control", "no-store, max-age=0");
  resultHeaders.set("pragma", "no-cache");
  return new Response(JSON.stringify(body), { status, headers: resultHeaders });
}

function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  details: {
    retryable?: boolean;
    retryAfterMs?: number;
    providerAttempts?: number;
    responseIssue?: TranscriptionResponseIssue;
  } = {},
) {
  return json(status, {
    error: { code, message, retryable: details.retryable ?? false },
    ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
    providerAttempts: details.providerAttempts ?? 0,
    ...(details.responseIssue ? { responseIssue: details.responseIssue } : {}),
  });
}

async function readBodyLimited(
  input: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
) {
  const declared = Number(input.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("body_too_large");
  if (!input.body) return new Uint8Array();
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonBytes(bytes: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
}

function decodeCanonicalBase64(value: string) {
  if (
    value.length > GEMINI_MAX_BASE64_CHARS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("invalid_audio");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength > GEMINI_MAX_WAV_BYTES)
    throw new Error("invalid_audio");
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function validateWav(bytes: Uint8Array, expectedDurationMs: number) {
  if (bytes.byteLength < 44 || bytes.byteLength > GEMINI_MAX_WAV_BYTES)
    throw new Error("invalid_audio");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE") throw new Error("invalid_audio");
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) throw new Error("invalid_audio");

  let cursor = 12;
  let format: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let dataBytes: number | undefined;
  while (cursor + 8 <= bytes.byteLength) {
    const id = ascii(cursor, cursor + 4);
    const length = view.getUint32(cursor + 4, true);
    const payload = cursor + 8;
    if (payload + length > bytes.byteLength) throw new Error("invalid_audio");
    if (id === "fmt ") {
      if (length < 16 || format !== undefined) throw new Error("invalid_audio");
      format = view.getUint16(payload, true);
      channels = view.getUint16(payload + 2, true);
      sampleRate = view.getUint32(payload + 4, true);
      byteRate = view.getUint32(payload + 8, true);
      blockAlign = view.getUint16(payload + 12, true);
      bitsPerSample = view.getUint16(payload + 14, true);
    } else if (id === "data") {
      if (dataBytes !== undefined) throw new Error("invalid_audio");
      dataBytes = length;
    }
    cursor = payload + length + (length % 2);
  }
  if (
    cursor !== bytes.byteLength ||
    format !== 1 ||
    channels !== 1 ||
    sampleRate !== GEMINI_SAMPLE_RATE ||
    byteRate !== GEMINI_SAMPLE_RATE * 2 ||
    blockAlign !== 2 ||
    bitsPerSample !== 16 ||
    dataBytes === undefined ||
    dataBytes <= 0 ||
    dataBytes % 2 !== 0
  ) {
    throw new Error("invalid_audio");
  }
  const actualDurationMs = (dataBytes / 2 / sampleRate) * 1000;
  if (Math.abs(actualDurationMs - expectedDurationMs) > 1000 / sampleRate + 0.001)
    throw new Error("invalid_audio");
  return bytes;
}

function validateChunkPlan(input: GeminiTranscriptionRequest, actualDurationMs: number) {
  const expectedCount =
    1 +
    Math.ceil(Math.max(0, input.sourceDurationMs - GEMINI_AUDIO_CHUNK_MS) / GEMINI_AUDIO_STRIDE_MS);
  const expectedStart = input.chunkIndex * GEMINI_AUDIO_STRIDE_MS;
  const expectedDuration = Math.min(GEMINI_AUDIO_CHUNK_MS, input.sourceDurationMs - expectedStart);
  if (
    input.totalChunks !== expectedCount ||
    input.chunkIndex >= input.totalChunks ||
    Math.abs(input.chunkStartMs - expectedStart) > 1 ||
    expectedDuration <= 0 ||
    Math.abs(input.chunkDurationMs - expectedDuration) > 1 ||
    Math.abs(actualDurationMs - input.chunkDurationMs) > 1000 / GEMINI_SAMPLE_RATE + 0.001
  ) {
    throw new Error("invalid_audio");
  }
}

function resolveModel(env: Record<string, string | undefined>) {
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^[a-z0-9][a-z0-9.-]{0,95}$/i.test(model)) throw new Error("server_configuration");
  return model;
}

function retryAfterMs(headers: Headers, now: number) {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  const target = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(raw);
  if (!Number.isFinite(target)) return undefined;
  return Math.max(0, Math.min(60_000, Math.round(target - now)));
}

function providerErrorStatus(body: unknown) {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: { status?: unknown; message?: unknown } }).error;
    const statusText =
      typeof error?.status === "string" && /^[A-Z_]{2,40}$/.test(error.status)
        ? error.status.toLowerCase()
        : "";
    const safeForMatch = typeof error?.message === "string" ? error.message.toLowerCase() : "";
    return { statusText, safeForMatch };
  }
  return { statusText: "", safeForMatch: "" };
}

function getProviderErrorCode(body: unknown, status: number): ApiErrorCode {
  const { statusText, safeForMatch } = providerErrorStatus(body);
  if (status === 401) return "invalid_api_key";
  if (status === 402) return "billing_required";
  if (status === 403) return "permission_denied";
  if (status === 404) return "unsupported_model";
  if (status === 429) return "rate_limit_or_quota";
  if (status >= 500) return "provider_unavailable";
  if (status === 400) {
    if (
      statusText.includes("unauthenticated") ||
      /api[ _-]?key.{0,24}(invalid|not valid)/.test(safeForMatch)
    )
      return "invalid_api_key";
    if (statusText.includes("failed_precondition")) return "account_precondition";
    if (
      statusText.includes("not_found") ||
      /model.{0,24}(not found|unsupported)/.test(safeForMatch)
    )
      return "unsupported_model";
    if (statusText.includes("resource_exhausted")) return "rate_limit_or_quota";
  }
  return "invalid_request";
}

function publicErrorMessage(code: ApiErrorCode) {
  switch (code) {
    case "invalid_api_key":
      return "Gemini rejected this API key. Check the key or enter a different one.";
    case "permission_denied":
      return "This Gemini key does not have permission to use the configured model.";
    case "account_precondition":
      return "Gemini rejected this project's setup. Check free-tier regional availability and billing in Google AI Studio.";
    case "billing_required":
      return "Gemini billing or prepaid credits need attention in Google AI Studio.";
    case "unsupported_model":
      return "The configured Gemini model is unavailable for this project.";
    case "rate_limit_or_quota":
      return "Gemini rate limit or quota reached. Wait and try again.";
    case "provider_timeout":
      return "Gemini did not finish before the request timed out.";
    case "provider_unavailable":
      return "Gemini could not complete this request. Check the connection and retry.";
    case "blocked_response":
      return "Gemini blocked this audio response. Try another chunk or use On device.";
    case "invalid_json":
      return "Gemini returned an unreadable response. Retry this chunk.";
    case "invalid_response":
      return "Gemini returned an incomplete or invalid timestamped response.";
    case "missing_api_key":
      return "Enter a Gemini API key or configure GEMINI_API_KEY on the server.";
    case "server_configuration":
      return "Gemini is not configured correctly on the server.";
    case "invalid_request":
      return "Gemini rejected the audio request. Check the configured model and request format.";
    case "invalid_audio":
      return "This audio chunk is not a supported mono PCM16 WAV at 16 kHz.";
    default:
      return "This Gemini audio request is invalid.";
  }
}

async function readProviderJson(response: Response) {
  const bytes = await readBodyLimited(response, 1_000_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid_json");
  }
  return parsed;
}

function tokenUsage(body: unknown) {
  if (typeof body !== "object" || body === null || !("usageMetadata" in body)) return null;
  const metadata = (body as { usageMetadata?: Record<string, unknown> }).usageMetadata;
  const input = metadata?.promptTokenCount;
  const output = metadata?.candidatesTokenCount;
  const thoughts = metadata?.thoughtsTokenCount;
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    typeof output !== "number" ||
    !Number.isSafeInteger(output) ||
    output < 0
  ) {
    return null;
  }
  return {
    input,
    output:
      output +
      (typeof thoughts === "number" && Number.isSafeInteger(thoughts) && thoughts > 0
        ? thoughts
        : 0),
  };
}

function normalizeInteraction(body: unknown, chunkDurationMs: number) {
  if (!body || typeof body !== "object")
    throw new TranscriptionResponseError("invalid_interaction_shape");
  const interaction = body as { status?: unknown; steps?: unknown };
  if (interaction.status !== "completed")
    throw new TranscriptionResponseError("interaction_not_completed");
  if (!Array.isArray(interaction.steps))
    throw new TranscriptionResponseError("invalid_interaction_shape");

  const words: Array<{ startMs: number; endMs: number; text: string }> = [];
  let transcript = "";
  let timingAdjusted = false;
  const offsetMs = (value: unknown) => {
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?s$/.test(value))
      throw new TranscriptionResponseError("missing_or_invalid_word_timing");
    // Preserve sub-millisecond intervals; rounding individual words can turn a
    // valid positive interval into a zero-duration word.
    const milliseconds = Number(value.slice(0, -1)) * 1000;
    if (!Number.isFinite(milliseconds))
      throw new TranscriptionResponseError("missing_or_invalid_word_timing");
    return milliseconds;
  };

  for (const step of interaction.steps) {
    if (!step || typeof step !== "object" || !Array.isArray(step.content)) continue;
    for (const content of step.content) {
      if (!content || typeof content !== "object" || content.type !== "text") continue;
      if (typeof content.text === "string") transcript += content.text;
      if (!Array.isArray(content.annotations)) continue;
      let contentBytes: Uint8Array | undefined;
      for (const annotation of content.annotations) {
        if (!annotation || typeof annotation !== "object" || annotation.type !== "word_info")
          continue;
        let text = typeof annotation.text === "string" ? annotation.text.trim() : undefined;
        if (text === undefined) {
          // WordInfo.text is optional. The REST schema's indices address UTF-8
          // bytes in this content block, not JavaScript string positions.
          if (typeof content.text !== "string")
            throw new TranscriptionResponseError("missing_word_text");
          contentBytes ??= new TextEncoder().encode(content.text);
          const start = annotation.start_index;
          const end = annotation.end_index;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end <= start ||
            end > contentBytes.length
          )
            throw new TranscriptionResponseError("invalid_word_text_indices");
          try {
            text = new TextDecoder("utf-8", { fatal: true })
              .decode(contentBytes.subarray(start, end))
              .trim();
          } catch {
            throw new TranscriptionResponseError("invalid_word_text_indices");
          }
        }
        // Whitespace annotations do not contribute any subtitle text.
        if (!text) continue;
        const startMs = offsetMs(annotation.start_offset);
        const endMs = offsetMs(annotation.end_offset);
        if (
          endMs < startMs ||
          startMs < 0 ||
          endMs > chunkDurationMs + GEMINI_TIMING_BOUNDARY_TOLERANCE_MS
        )
          throw new TranscriptionResponseError("word_timing_out_of_bounds");
        const boundedStart = Math.min(startMs, chunkDurationMs);
        const boundedEnd = Math.min(endMs, chunkDurationMs);
        if ((boundedStart === boundedEnd && /[\p{L}\p{N}]/u.test(text)) || endMs > chunkDurationMs)
          timingAdjusted = true;
        words.push({ text, startMs: boundedStart, endMs: boundedEnd });
      }
    }
  }
  if (!words.length && transcript.trim())
    throw new TranscriptionResponseError("missing_word_annotations");

  // WordInfo's schema does not promise chronological annotation ordering.
  words.sort((left, right) => left.startMs - right.startMs);
  const segments: Array<{ startMs: number; endMs: number; text: string }> = [];
  let phrase: typeof words = [];
  const flush = () => {
    if (!phrase.length) return;
    const endMs = Math.max(...phrase.map((word) => word.endMs));
    // Point-timed tokens (including punctuation) belong to a neighbouring timed
    // phrase; they must never become fabricated positive-duration subtitles.
    if (endMs <= phrase[0].startMs) return;
    segments.push({
      startMs: phrase[0].startMs,
      endMs,
      text: phrase
        .map((word) => word.text)
        .join(" ")
        .replace(/\s+([,.!?;:，。！？；：])/gu, "$1"),
    });
    phrase = [];
  };
  let previousEnd = 0;
  for (const word of words) {
    if (word.text.length > GEMINI_MAX_SEGMENT_TEXT_LENGTH)
      throw new TranscriptionResponseError("invalid_subtitle_contract");
    if (
      phrase.length &&
      (word.startMs - previousEnd > 800 ||
        word.endMs - phrase[0].startMs > 4_000 ||
        phrase.length >= 8 ||
        phrase.map((part) => part.text.length + 1).reduce((a, b) => a + b, word.text.length) >
          GEMINI_MAX_SEGMENT_TEXT_LENGTH)
    )
      flush();
    phrase.push(word);
    previousEnd = Math.max(previousEnd, word.endMs);
    if (/[.!?。！？]$/.test(word.text)) flush();
  }
  flush();
  if (phrase.length) throw new TranscriptionResponseError("no_positive_phrase_timing");
  if (segments.length > GEMINI_MAX_SEGMENTS_PER_CHUNK)
    throw new TranscriptionResponseError("segment_limit_exceeded");
  const result = geminiProviderContentSchema.safeParse({
    segments,
    flags: { uncertain: false, timing: timingAdjusted },
  });
  if (!result.success) throw new TranscriptionResponseError("invalid_subtitle_contract");
  return result.data;
}

export async function handleGeminiLyricsRequest(request: Request, config: ServerConfig = {}) {
  const env = config.env ?? process.env;
  try {
    if (new URL(request.url).search)
      return apiError(
        400,
        "invalid_request",
        "Do not send credentials or options in the request URL.",
      );
  } catch {
    return apiError(400, "invalid_request", "This request URL is invalid.");
  }
  if (request.method === "GET") {
    return json(200, {
      available: true,
      serverKeyConfigured: Boolean(env.GEMINI_API_KEY?.trim()),
    });
  }
  if (request.method !== "POST")
    return json(405, { error: { code: "method_not_allowed" } }, { allow: "GET, POST" });

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(request.url).origin)
        return apiError(403, "invalid_request", "This request must come from the same site.");
    } catch {
      return apiError(403, "invalid_request", "This request must come from the same site.");
    }
  }

  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
    return apiError(415, "invalid_request", "This request must use JSON.");

  let raw: unknown;
  try {
    raw = parseJsonBytes(await readBodyLimited(request, GEMINI_MAX_REQUEST_BYTES));
  } catch (error) {
    const code =
      error instanceof Error && error.message === "body_too_large"
        ? "invalid_request"
        : "invalid_json";
    return apiError(
      code === "invalid_request" ? 413 : 400,
      code,
      code === "invalid_request"
        ? "This audio request is too large."
        : "This request is not valid JSON.",
    );
  }
  const parsedInput = geminiTranscriptionRequestSchema.safeParse(raw);
  if (!parsedInput.success)
    return apiError(400, "invalid_request", publicErrorMessage("invalid_request"));
  const input = parsedInput.data;

  let audio: Uint8Array;
  try {
    audio = decodeCanonicalBase64(input.audioBase64);
    validateWav(audio, input.chunkDurationMs);
    validateChunkPlan(input, ((audio.byteLength - 44) / 2 / GEMINI_SAMPLE_RATE) * 1000);
  } catch {
    return apiError(400, "invalid_audio", publicErrorMessage("invalid_audio"));
  }

  const suppliedKey = request.headers.get("x-goog-api-key")?.trim();
  const clientHeaderPresent = request.headers.has("x-goog-api-key");
  const apiKey = clientHeaderPresent ? suppliedKey : env.GEMINI_API_KEY?.trim();
  if (!apiKey) return apiError(503, "missing_api_key", publicErrorMessage("missing_api_key"));
  if (apiKey.length > 4096)
    return apiError(400, "invalid_request", publicErrorMessage("invalid_request"));
  if (input.recheck && input.preset !== "quality")
    return apiError(
      400,
      "invalid_request",
      "Only the Quality preset can request an accuracy recheck.",
    );

  let model: string;
  try {
    model = resolveModel(env);
  } catch {
    return apiError(500, "server_configuration", publicErrorMessage("server_configuration"));
  }

  const controllerSignal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const signal = AbortSignal.any([request.signal, controllerSignal]);
  const admission = acquireProviderSlot(apiKey, (config.now ?? Date.now)());
  if (!admission.acquired) {
    return apiError(
      429,
      "rate_limit_or_quota",
      "Gemini requests for this key are temporarily limited on this server instance.",
      {
        retryable: true,
        retryAfterMs: admission.retryAfterMs,
        providerAttempts: 0,
      },
    );
  }
  let providerResponse: Response;
  let uploadedFileName: string | null = null;
  const fetcher = config.fetcher ?? fetch;
  try {
    const uploadStart = await fetcher(PROVIDER_UPLOAD_BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(audio.byteLength),
        "x-goog-upload-header-content-type": "audio/wav",
      },
      body: JSON.stringify({ file: { display_name: "pulseframe-audio.wav" } }),
      signal,
    });
    if (!uploadStart.ok) providerResponse = uploadStart;
    else {
      const uploadUrl = uploadStart.headers.get("x-goog-upload-url");
      if (!uploadUrl || !/^https:\/\/generativelanguage\.googleapis\.com\/upload\//.test(uploadUrl))
        throw new Error("invalid_upload_response");
      const uploaded = await fetcher(uploadUrl, {
        method: "POST",
        headers: {
          "content-type": "audio/wav",
          "x-goog-api-key": apiKey,
          "x-goog-upload-offset": "0",
          "x-goog-upload-command": "upload, finalize",
        },
        body: Buffer.from(audio),
        signal,
      });
      if (!uploaded.ok) providerResponse = uploaded;
      else {
        const file = (await readProviderJson(uploaded)) as {
          file?: { name?: unknown; uri?: unknown };
        };
        const name = file?.file?.name;
        const uri = file?.file?.uri;
        if (
          typeof name !== "string" ||
          !/^files\/[a-zA-Z0-9_-]+$/.test(name) ||
          typeof uri !== "string" ||
          uri !== `${PROVIDER_BASE}/${name}`
        )
          throw new Error("invalid_upload_response");
        uploadedFileName = name;
        providerResponse = await fetcher(`${PROVIDER_BASE}/interactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            model,
            input: [{ type: "audio", uri, mime_type: "audio/wav" }],
            generation_config: {
              transcription_config: {
                language_codes: input.languageCode ? [input.languageCode] : [],
                mode: { type: "verbatim", timestamp_granularities: ["word"] },
              },
            },
          }),
          signal,
        });
      }
    }
  } catch {
    const timeout = controllerSignal.aborted;
    const code: ApiErrorCode = timeout ? "provider_timeout" : "provider_unavailable";
    return apiError(timeout ? 504 : 502, code, publicErrorMessage(code), {
      retryable: false,
      providerAttempts: 1,
    });
  } finally {
    if (uploadedFileName) {
      await fetcher(`${PROVIDER_BASE}/${uploadedFileName}`, {
        method: "DELETE",
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }
    if (admission.acquired) admission.release();
  }

  let providerBody: unknown;
  try {
    providerBody = await readProviderJson(providerResponse);
  } catch (error) {
    if (!providerResponse.ok) providerBody = null;
    else {
      const code: ApiErrorCode =
        error instanceof Error && error.message === "invalid_json"
          ? "invalid_json"
          : "invalid_response";
      return apiError(502, code, publicErrorMessage(code), {
        providerAttempts: 1,
      });
    }
  }

  if (!providerResponse.ok) {
    const code = getProviderErrorCode(providerBody, providerResponse.status);
    const retryable = code === "rate_limit_or_quota" || code === "provider_unavailable";
    const status =
      code === "rate_limit_or_quota"
        ? 429
        : code === "provider_unavailable"
          ? 502
          : code === "billing_required"
            ? 402
            : code === "permission_denied"
              ? 403
              : code === "unsupported_model"
                ? 404
                : 400;
    // Log only status codes. Provider messages may echo user-supplied content.
    console.warn("Gemini provider request failed", {
      providerHttpStatus: providerResponse.status,
      providerStatus: providerErrorStatus(providerBody).statusText,
      classifiedAs: code,
    });
    return apiError(status, code, publicErrorMessage(code), {
      retryable,
      retryAfterMs: retryable
        ? retryAfterMs(providerResponse.headers, (config.now ?? Date.now)())
        : undefined,
      providerAttempts: 1,
    });
  }

  let result: ReturnType<typeof normalizeInteraction>;
  try {
    result = normalizeInteraction(providerBody, input.chunkDurationMs);
  } catch (error) {
    const responseIssue =
      error instanceof TranscriptionResponseError ? error.issue : "invalid_subtitle_contract";
    // Fixed diagnostic codes only: never log the response body, lyric text,
    // keys, or exception messages that could contain provider content.
    console.warn("Gemini transcription response rejected", {
      responseIssue,
      chunkIndex: input.chunkIndex,
    });
    return apiError(502, "invalid_response", publicErrorMessage("invalid_response"), {
      providerAttempts: 1,
      responseIssue,
    });
  }

  return json(
    200,
    geminiSuccessResponseSchema.parse({
      ...result,
      model,
      providerAttempts: 1,
      tokenUsage: tokenUsage(providerBody),
    }),
  );
}

export const geminiServerLimits = {
  maxRequestBytes: GEMINI_MAX_REQUEST_BYTES,
  maxBase64Chars: GEMINI_MAX_BASE64_CHARS,
  maxWavBytes: GEMINI_MAX_WAV_BYTES,
  maxSourceDurationMs: GEMINI_MAX_SOURCE_DURATION_MS,
  maxChunkDurationMs: GEMINI_AUDIO_CHUNK_MS,
  maxChunkCount: GEMINI_MAX_CHUNK_COUNT,
  maxSegmentsPerChunk: GEMINI_MAX_SEGMENTS_PER_CHUNK,
  boundaryToleranceMs: GEMINI_TIMING_BOUNDARY_TOLERANCE_MS,
};
