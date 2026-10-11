import { z } from "zod";
import { encodeCloudAudioChunk, planCloudAudioChunks } from "./audio";
import { normalizeGeneratedCues, normalizeWindowCues } from "./cues";
import {
  GEMINI_MAX_BASE64_CHARS,
  GEMINI_MAX_REQUEST_BYTES,
  GEMINI_MAX_SOURCE_DURATION_MS,
  geminiSuccessResponseSchema,
  type GeminiSuccessResponse,
  type GeminiTranscriptionRequest,
} from "./gemini-contract";
import { resolveGeminiPolicy } from "./policy";
import type {
  GeneratedCue,
  LyricsAdapter,
  LyricsAudio,
  LyricsResult,
  LyricsRunOptions,
} from "./types";

const API_PATH = "/api/lyrics/transcribe";
const MAX_RETRIES_PER_CHUNK = 2;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_CACHED_SCOPES = 6;

const availabilitySchema = z
  .object({ available: z.boolean(), serverKeyConfigured: z.boolean() })
  .strict();

const errorSchema = z
  .object({
    error: z
      .object({
        code: z.string().max(80),
        message: z.string().max(300),
        retryable: z.boolean().optional(),
      })
      .passthrough(),
    retryAfterMs: z.number().int().nonnegative().max(60_000).optional(),
    providerAttempts: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export type GeminiAvailability = {
  available: boolean;
  serverKeyConfigured: boolean;
};
type ApiChunkResult = GeminiSuccessResponse;
type ApiFailure = {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  providerAttempts: number;
};
type CachedChunk = {
  result: ApiChunkResult;
};
type RequestedChunk = CachedChunk & {
  attempts: number;
  rechecks: number;
  tokenUsage: { input: number; output: number };
  unknownAttempts: number;
  notices: string[];
};
type GeminiAccounting = {
  attempts: number;
  rechecks: number;
  unknownAttempts: number;
  tokenUsage: { input: number; output: number };
  notices: string[];
  model: string;
};
type GeminiCacheScope = {
  chunks: Map<string, CachedChunk>;
  accounting: GeminiAccounting;
};

export class GeminiLyricsError extends Error {
  readonly providerAttempts: number;
  readonly unknownAttempts: number;
  readonly tokenUsage: { input: number; output: number };
  readonly notices: string[];
  readonly code: string;

  constructor(
    message: string,
    details: {
      code?: string;
      providerAttempts?: number;
      unknownAttempts?: number;
      tokenUsage?: { input: number; output: number };
      notices?: string[];
    } = {},
  ) {
    super(message);
    this.name = "GeminiLyricsError";
    this.code = details.code ?? "provider_unavailable";
    this.providerAttempts = details.providerAttempts ?? 0;
    this.unknownAttempts = details.unknownAttempts ?? 0;
    this.tokenUsage = details.tokenUsage ?? { input: 0, output: 0 };
    this.notices = details.notices ?? [];
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function makeCombinedSignal(signal: AbortSignal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return { signal: AbortSignal.any([signal, timeout]), timeout };
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted)
    throw new DOMException("Gemini transcription canceled.", "AbortError");
}

function sleep(ms: number, signal: AbortSignal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Gemini transcription canceled.", "AbortError"));
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function encodeBase64(bytes: Uint8Array) {
  if (typeof btoa !== "function")
    throw new Error("This browser cannot encode audio for Gemini.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    const slice = bytes.subarray(
      offset,
      Math.min(bytes.length, offset + 24_576),
    );
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function fingerprintKey(key: string | null): Promise<string | null> {
  if (!key) return "server-key";
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
    return [...new Uint8Array(digest)]
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

function addUsage(
  current: { input: number; output: number },
  next: { input: number; output: number } | null,
) {
  if (!next) return current;
  return {
    input: current.input + next.input,
    output: current.output + next.output,
  };
}

function checkResponseSegments(result: ApiChunkResult, durationMs: number) {
  let previousStartMs = -1;
  for (const segment of result.segments) {
    if (
      !segment.text.trim() ||
      segment.startMs < 0 ||
      segment.endMs <= segment.startMs ||
      segment.endMs > durationMs ||
      segment.startMs < previousStartMs
    ) {
      throw new GeminiLyricsError(
        "Gemini returned invalid timestamped lyrics.",
        {
          code: "invalid_response",
        },
      );
    }
    previousStartMs = segment.startMs;
  }
}

async function fetchApiFailure(response: Response): Promise<ApiFailure> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new GeminiLyricsError(
      "The subtitle service returned an invalid response.",
      {
        code: "invalid_response",
        unknownAttempts: 1,
        notices: [
          "The request reached the subtitle service, but its outcome is unknown.",
        ],
      },
    );
  }
  const parsed = errorSchema.safeParse(value);
  if (!parsed.success) {
    throw new GeminiLyricsError(
      "The subtitle service returned an invalid response.",
      {
        code: "invalid_response",
        unknownAttempts: 1,
        notices: [
          "The request reached the subtitle service, but its outcome is unknown.",
        ],
      },
    );
  }
  return {
    status: response.status,
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    retryable: parsed.data.error.retryable ?? false,
    retryAfterMs: parsed.data.retryAfterMs,
    providerAttempts: parsed.data.providerAttempts ?? 0,
  };
}

async function requestChunk(input: {
  wav: Uint8Array;
  chunkIndex: number;
  totalChunks: number;
  chunkStartMs: number;
  chunkDurationMs: number;
  sourceDurationMs: number;
  preset: LyricsRunOptions["preset"];
  recheck: boolean;
  apiKey: string | null;
  signal: AbortSignal;
  fetcher: typeof fetch;
  onProgress: LyricsRunOptions["onProgress"];
}): Promise<RequestedChunk> {
  throwIfAborted(input.signal);
  const audioBase64 = encodeBase64(input.wav);
  if (audioBase64.length > GEMINI_MAX_BASE64_CHARS) {
    throw new GeminiLyricsError(
      "This audio chunk exceeds the Gemini upload size limit.",
      {
        code: "invalid_audio",
      },
    );
  }
  const requestValue: GeminiTranscriptionRequest = {
    chunkIndex: input.chunkIndex,
    totalChunks: input.totalChunks,
    chunkStartMs: input.chunkStartMs,
    chunkDurationMs: input.chunkDurationMs,
    sourceDurationMs: input.sourceDurationMs,
    preset: input.preset,
    recheck: input.recheck,
    audioBase64,
  };
  const requestBody = JSON.stringify(requestValue);
  if (
    new TextEncoder().encode(requestBody).byteLength > GEMINI_MAX_REQUEST_BYTES
  ) {
    throw new GeminiLyricsError(
      "This audio chunk exceeds the Gemini upload size limit.",
      {
        code: "invalid_audio",
      },
    );
  }

  let providerAttempts = 0;
  let unknownAttempts = 0;
  let tokenUsage = { input: 0, output: 0 };
  const notices: string[] = [];
  let retries = 0;
  while (true) {
    throwIfAborted(input.signal);
    input.onProgress({
      stage: "send",
      message: input.recheck
        ? `Rechecking flagged audio chunk ${input.chunkIndex + 1} of ${input.totalChunks}…`
        : `Sending audio chunk ${input.chunkIndex + 1} of ${input.totalChunks} to Google…`,
      completed: input.chunkIndex,
      total: input.totalChunks,
    });
    const headers = new Headers({ "content-type": "application/json" });
    if (input.apiKey) headers.set("x-goog-api-key", input.apiKey);
    let response: Response;
    const combined = makeCombinedSignal(input.signal);
    const fetcher = input.fetcher;
    try {
      response = await fetcher(API_PATH, {
        method: "POST",
        headers,
        body: requestBody,
        cache: "no-store",
        credentials: "same-origin",
        signal: combined.signal,
      });
    } catch (error) {
      if (
        input.signal.aborted ||
        (isAbortError(error) && !combined.timeout.aborted)
      ) {
        throw new DOMException("Gemini transcription canceled.", "AbortError");
      }
      unknownAttempts += 1;
      notices.push(
        "A timed-out or disconnected request may still finish and use API quota; automatic retry was stopped to avoid silently repeating it.",
      );
      throw new GeminiLyricsError(
        combined.timeout.aborted
          ? "The Gemini request timed out. Retry this track only after reviewing the usage notice."
          : "The connection ended before Gemini's response was received. Retry this track only after reviewing the usage notice.",
        {
          code: combined.timeout.aborted ? "provider_timeout" : "connectivity",
          providerAttempts,
          unknownAttempts,
          tokenUsage,
          notices,
        },
      );
    }

    if (!response.ok) {
      let failure: ApiFailure;
      try {
        failure = await fetchApiFailure(response);
      } catch (error) {
        if (error instanceof GeminiLyricsError) {
          throw new GeminiLyricsError(error.message, {
            code: error.code,
            providerAttempts,
            unknownAttempts: unknownAttempts + error.unknownAttempts,
            tokenUsage,
            notices: [...notices, ...error.notices],
          });
        }
        throw error;
      }
      providerAttempts += failure.providerAttempts;
      if (failure.code === "provider_timeout") {
        unknownAttempts += 1;
        notices.push(
          "The subtitle service timed out while waiting for Gemini. Its request may still use quota; the chunk was not replayed automatically.",
        );
        throw new GeminiLyricsError(failure.message, {
          code: failure.code,
          providerAttempts,
          unknownAttempts,
          tokenUsage,
          notices,
        });
      }
      if (
        failure.code === "provider_unavailable" &&
        failure.providerAttempts > 0 &&
        !failure.retryable
      ) {
        unknownAttempts += 1;
        notices.push(
          "Gemini disconnected after a provider attempt. The request may still use quota; automatic replay was stopped.",
        );
      }
      if (failure.retryable && retries < MAX_RETRIES_PER_CHUNK) {
        retries += 1;
        const delay =
          failure.retryAfterMs ?? Math.min(8_000, 500 * 2 ** (retries - 1));
        notices.push(
          failure.code === "rate_limit_or_quota"
            ? `Gemini requested a retry delay of ${Math.ceil(delay / 1000)} seconds.`
            : "Gemini returned a temporary service error; retrying this chunk may use additional quota.",
        );
        await sleep(delay, input.signal);
        continue;
      }
      throw new GeminiLyricsError(failure.message, {
        code: failure.code,
        providerAttempts,
        unknownAttempts,
        tokenUsage,
        notices,
      });
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new GeminiLyricsError(
        "The subtitle service returned an invalid response.",
        {
          code: "invalid_response",
          providerAttempts,
          unknownAttempts: unknownAttempts + 1,
          tokenUsage,
          notices: [
            ...notices,
            "The request reached the subtitle service, but its outcome is unknown.",
          ],
        },
      );
    }
    const parsed = geminiSuccessResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GeminiLyricsError(
        "The subtitle service returned an invalid response.",
        {
          code: "invalid_response",
          providerAttempts,
          unknownAttempts: unknownAttempts + 1,
          tokenUsage,
          notices: [
            ...notices,
            "The request reached the subtitle service, but its outcome is unknown.",
          ],
        },
      );
    }
    providerAttempts += parsed.data.providerAttempts;
    try {
      checkResponseSegments(parsed.data, input.chunkDurationMs);
    } catch (error) {
      throw new GeminiLyricsError(
        error instanceof Error
          ? error.message
          : "Gemini returned invalid timestamped lyrics.",
        {
          code: "invalid_response",
          providerAttempts,
          unknownAttempts,
          tokenUsage,
          notices,
        },
      );
    }
    const usage = parsed.data.tokenUsage;
    tokenUsage = addUsage(tokenUsage, usage);
    return {
      result: parsed.data,
      attempts: providerAttempts,
      rechecks: input.recheck ? 1 : 0,
      tokenUsage,
      unknownAttempts,
      notices,
    };
  }
}

function cueWindow(
  index: number,
  plans: ReturnType<typeof planCloudAudioChunks>,
  durationMs: number,
) {
  const current = plans[index];
  const previous = plans[index - 1];
  const next = plans[index + 1];
  return {
    startMs: current.startMs,
    endMs: Math.min(durationMs, current.endMs),
    ownsStartMs: previous ? (previous.endMs + current.startMs) / 2 : 0,
    ownsEndMs: next ? (current.endMs + next.startMs) / 2 : durationMs,
  };
}

function resultCues(
  result: ApiChunkResult,
  index: number,
  plans: ReturnType<typeof planCloudAudioChunks>,
  durationMs: number,
) {
  return normalizeWindowCues(
    result.segments,
    cueWindow(index, plans, durationMs),
    durationMs,
  );
}

function clampDuration(audio: LyricsAudio) {
  if (
    !Number.isFinite(audio.durationMs) ||
    audio.durationMs <= 0 ||
    audio.durationMs > GEMINI_MAX_SOURCE_DURATION_MS
  ) {
    throw new Error(
      "Gemini transcription supports tracks up to ten minutes long.",
    );
  }
  return audio.durationMs;
}

export async function getGeminiAvailability(
  signal?: AbortSignal,
  fetcher?: typeof fetch,
): Promise<GeminiAvailability> {
  const requestFetch = fetcher ?? globalThis.fetch.bind(globalThis);
  const response = await requestFetch(API_PATH, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    signal,
  }).catch((error: unknown) => {
    if (isAbortError(error)) throw error;
    return null;
  });
  if (!response?.ok) return { available: false, serverKeyConfigured: false };
  const parsed = availabilitySchema.safeParse(
    await response.json().catch(() => null),
  );
  return parsed.success
    ? parsed.data
    : { available: false, serverKeyConfigured: false };
}

export function createGeminiLyricsAdapter(options: {
  getApiKey: () => string | null | undefined;
  fetcher?: typeof fetch;
}): LyricsAdapter {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const completedScopes = new Map<string, GeminiCacheScope>();
  let disposed = false;

  function getScope(key: string) {
    let scope = completedScopes.get(key);
    if (!scope) {
      scope = {
        chunks: new Map(),
        accounting: {
          attempts: 0,
          rechecks: 0,
          unknownAttempts: 0,
          tokenUsage: { input: 0, output: 0 },
          notices: [],
          model: "gemini-3.8-flash",
        },
      };
      completedScopes.set(key, scope);
    } else {
      completedScopes.delete(key);
      completedScopes.set(key, scope);
    }
    while (completedScopes.size > MAX_CACHED_SCOPES) {
      const oldest = completedScopes.keys().next().value;
      if (oldest === undefined) break;
      completedScopes.delete(oldest);
    }
    return scope;
  }

  return {
    async generate(
      audio: LyricsAudio,
      run: LyricsRunOptions,
    ): Promise<LyricsResult> {
      if (disposed)
        throw new Error("The Gemini adapter has been disconnected.");
      throwIfAborted(run.signal);
      const durationMs = clampDuration(audio);
      if (
        !Array.isArray(audio.channels) ||
        audio.channels.length < 1 ||
        audio.channels.length > 2
      )
        throw new Error("Gemini transcription supports mono or stereo audio.");
      const sourceSampleCount = audio.channels[0]?.length ?? 0;
      if (
        !Number.isSafeInteger(sourceSampleCount) ||
        sourceSampleCount < 1 ||
        audio.channels.some(
          (channel) =>
            !(channel instanceof Float32Array) ||
            channel.length !== sourceSampleCount,
        )
      ) {
        throw new Error(
          "The decoded audio channels have an invalid sample layout.",
        );
      }
      const plans = planCloudAudioChunks(sourceSampleCount, audio.sampleRate);
      if (!plans.length)
        throw new Error(
          "No audio samples are available for Gemini transcription.",
        );
      if (plans.length > 11)
        throw new Error(
          "Gemini transcription supports tracks up to ten minutes long.",
        );
      const plannedDurationMs =
        (plans[0].totalSamples * 1000) / plans[0].sampleRate;
      if (Math.abs(plannedDurationMs - durationMs) > 1000) {
        throw new Error(
          "The decoded audio duration does not match the active track.",
        );
      }

      const startedAt = Date.now();
      const apiKey = options.getApiKey()?.trim() || null;
      const keyFingerprint = await fingerprintKey(apiKey);
      const cacheNonce =
        keyFingerprint === null
          ? typeof crypto !== "undefined" &&
            typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2)
          : "";
      const sourceKey = [
        run.sourceId,
        durationMs,
        audio.sampleRate,
        sourceSampleCount,
        audio.channels.length,
        run.preset,
        keyFingerprint ?? cacheNonce,
      ].join(":");
      const scope = getScope(sourceKey);
      const cache = scope.chunks;
      const accounting = scope.accounting;
      const completed: CachedChunk[] = new Array(plans.length);
      const notices: string[] = [];
      const timing: Record<string, number> = { prepare: 0, send: 0, format: 0 };

      const loadOrRequest = async (index: number, recheck: boolean) => {
        throwIfAborted(run.signal);
        const cacheId = `${index}:${recheck ? "recheck" : "primary"}`;
        const existing = cache.get(cacheId);
        if (existing) {
          accounting.model = existing.result.model;
          return existing;
        }
        const plan = plans[index];
        const encodeStart = Date.now();
        let encoded: Awaited<ReturnType<typeof encodeCloudAudioChunk>> | null =
          null;
        try {
          encoded = await encodeCloudAudioChunk(
            audio.channels,
            audio.sampleRate,
            plan,
            run.signal,
          );
          timing.prepare += Date.now() - encodeStart;
          throwIfAborted(run.signal);
          const sendStart = Date.now();
          const result = await requestChunk({
            wav: encoded.wav,
            chunkIndex: index,
            totalChunks: plans.length,
            chunkStartMs: plan.startMs,
            chunkDurationMs:
              ((plan.endSample - plan.startSample) * 1000) / plan.sampleRate,
            sourceDurationMs: durationMs,
            preset: run.preset,
            recheck,
            apiKey,
            signal: run.signal,
            fetcher,
            onProgress: run.onProgress,
          });
          timing.send += Date.now() - sendStart;
          accounting.model = result.result.model;
          accounting.attempts += result.attempts;
          accounting.rechecks += result.rechecks;
          accounting.unknownAttempts += result.unknownAttempts;
          accounting.tokenUsage = addUsage(
            accounting.tokenUsage,
            result.tokenUsage,
          );
          accounting.notices.push(...result.notices);
          const cached = { result: result.result };
          cache.set(cacheId, cached);
          return cached;
        } catch (error) {
          if (error instanceof GeminiLyricsError) {
            accounting.attempts += error.providerAttempts;
            accounting.unknownAttempts += error.unknownAttempts;
            accounting.tokenUsage = addUsage(
              accounting.tokenUsage,
              error.tokenUsage,
            );
            accounting.notices.push(...error.notices);
            if (
              recheck &&
              (error.providerAttempts > 0 || error.unknownAttempts > 0)
            )
              accounting.rechecks += 1;
            if (error.message && error.code !== "invalid_api_key") {
              accounting.notices.push(
                `Chunk ${index + 1} request failed: ${error.message}`,
              );
            }
          }
          throw error;
        } finally {
          encoded?.wav.fill(0);
        }
      };

      for (let index = 0; index < plans.length; index += 1) {
        throwIfAborted(run.signal);
        const chunk = await loadOrRequest(index, false);
        completed[index] = chunk;
        run.onProgress({
          stage: "transcribe",
          message: `Transcribed audio chunk ${index + 1} of ${plans.length}.`,
          completed: index + 1,
          total: plans.length,
        });
      }

      const recheckLimit = resolveGeminiPolicy(
        run.preset,
        plans.length,
      ).maxRechecks;
      const flagged =
        run.preset === "quality"
          ? completed.flatMap((chunk, index) =>
              chunk.result.flags.uncertain || chunk.result.flags.timing
                ? [index]
                : [],
            )
          : [];
      for (const index of flagged.slice(0, recheckLimit)) {
        throwIfAborted(run.signal);
        const original = completed[index];
        try {
          const replacement = await loadOrRequest(index, true);
          completed[index] = replacement;
        } catch (error) {
          if (isAbortError(error) || run.signal.aborted) throw error;
          notices.push(
            `Quality recheck of chunk ${index + 1} failed; its original transcription was kept. ${
              error instanceof Error
                ? error.message
                : "Retry the track if needed."
            }`,
          );
          completed[index] = original;
        }
      }
      if (flagged.length > recheckLimit) {
        notices.push(
          `Quality flagged ${flagged.length} chunks. Its request budget allowed rechecking ${recheckLimit}; the remaining chunks were kept as transcribed.`,
        );
      }

      run.onProgress({
        stage: "format",
        message: "Combining timestamped lyrics…",
      });
      const allCues: GeneratedCue[] = [];
      for (let index = 0; index < completed.length; index += 1) {
        allCues.push(
          ...resultCues(completed[index].result, index, plans, durationMs),
        );
      }
      const cues = normalizeGeneratedCues(allCues, durationMs);
      timing.format = Date.now() - startedAt - timing.prepare - timing.send;
      if (accounting.unknownAttempts > 0) {
        notices.push(
          `${accounting.unknownAttempts} request outcome${accounting.unknownAttempts === 1 ? " is" : "s are"} unknown. The request may still finish and use Gemini quota.`,
        );
      }
      const finalNotices = [...accounting.notices, ...notices];
      const result: LyricsResult = {
        cues,
        durationMs,
        method: "gemini",
        preset: run.preset,
        diagnostics: {
          model: accounting.model,
          isolation: "none",
          overlap: 0,
          chunks: plans.length,
          attempts: accounting.attempts,
          rechecks: accounting.rechecks,
          timings: timing,
          ...(accounting.tokenUsage.input || accounting.tokenUsage.output
            ? { tokenUsage: accounting.tokenUsage }
            : {}),
        },
        notices: [...new Set(finalNotices)],
      };
      run.onProgress({
        stage: "format",
        message: `Prepared ${cues.length} subtitle lines.`,
      });
      return result;
    },
    dispose() {
      disposed = true;
      completedScopes.clear();
    },
  };
}
