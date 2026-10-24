"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SubtitleCue } from "@/lib/subtitles/model";
import {
  assessLyricsInput,
  MAX_LYRICS_DURATION_MS,
  MAX_LYRICS_SOURCE_BYTES,
} from "@/lib/lyrics/policy";
import { generatedCuesToSubtitles } from "@/lib/lyrics/cues";
import { getLanguageOptions, resolveLanguageCode } from "@/lib/lyrics/languages";
import type {
  LyricsAdapter,
  LyricsAudio,
  LyricsMethod,
  LyricsPreset,
  LyricsProgress,
  LyricsResult,
  LyricsSource,
} from "@/lib/lyrics/types";

export type SubtitleGenerationRevision = {
  sourceGeneration: number;
  cueRevision: number | string;
  sourceIdentity?: string;
};

export type UseSubtitleGenerationOptions = {
  /** Shared with media replacement and export controllers. */
  lockedRef: { current: boolean };
  /** Returns only the committed, complete active track. */
  getSource: () => LyricsSource | null;
  getCues: () => SubtitleCue[];
  /** Must synchronously commit to the active project when called. */
  applyCues: (cues: SubtitleCue[]) => void;
  getRevision: () => SubtitleGenerationRevision;
  /** Changes when the committed media identity or cue revision changes. */
  revisionKey: string | number;
};

export type SubtitleGenerationPhase = "idle" | "running" | "complete" | "error" | "canceled";

type GenerationSnapshot = {
  source: LyricsSource;
  sourceId: string;
  revision: SubtitleGenerationRevision;
  method: LyricsMethod;
  preset: LyricsPreset;
  result: LyricsResult;
  application: ReturnType<typeof generatedCuesToSubtitles>;
  startedAt: number;
  appliedCueFingerprint: string | null;
};

type ActiveJob = {
  controller: AbortController;
  source: LyricsSource;
  sourceId: string;
  revision: SubtitleGenerationRevision;
  method: LyricsMethod;
  preset: LyricsPreset;
  startedAt: number;
  cancelReason: "user" | "source" | "revision" | "method" | "preset" | "unmount" | null;
  lockOwned: boolean;
};

export type SubtitleGenerationController = ReturnType<typeof useSubtitleGeneration>;

const DEFAULT_METHOD: LyricsMethod = "local";
const DEFAULT_PRESET: LyricsPreset = "auto";

function fileIdentity(source: LyricsSource) {
  const { file } = source;
  return `${source.generation}:${file.name}:${file.size}:${file.lastModified}:${file.type}:${source.duration}`;
}

function sourceIdFor(source: LyricsSource, revision: SubtitleGenerationRevision) {
  return `${fileIdentity(source)}:${revision.sourceIdentity ?? ""}`;
}

function sameRevision(left: SubtitleGenerationRevision, right: SubtitleGenerationRevision) {
  return (
    left.sourceGeneration === right.sourceGeneration &&
    left.cueRevision === right.cueRevision &&
    (left.sourceIdentity ?? "") === (right.sourceIdentity ?? "")
  );
}

function sameMedia(left: SubtitleGenerationRevision, right: SubtitleGenerationRevision) {
  return (
    left.sourceGeneration === right.sourceGeneration &&
    (left.sourceIdentity ?? "") === (right.sourceIdentity ?? "")
  );
}

function cuesFingerprint(cues: readonly SubtitleCue[]) {
  return JSON.stringify(cues.map(({ id, start, end, text }) => ({ id, start, end, text })));
}

function isAbort(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function userError(error: unknown, apiKey: string) {
  const message = error instanceof Error ? error.message : "Subtitle generation could not finish.";
  const exactKey = apiKey;
  const trimmedKey = apiKey.trim();
  return [exactKey, trimmedKey]
    .filter((key, index, keys) => key.length > 0 && keys.indexOf(key) === index)
    .reduce((safe, key) => safe.split(key).join("[redacted]"), message);
}

function sourceLimitError(source: LyricsSource) {
  if (!Number.isFinite(source.duration) || source.duration <= 0)
    return "The active track duration could not be read.";
  if (source.file.size > MAX_LYRICS_SOURCE_BYTES)
    return "Automatic subtitles support source files up to 100 MiB. The full file is required; generation will not shorten it.";
  if (source.duration * 1000 > MAX_LYRICS_DURATION_MS)
    return "Automatic subtitles support complete tracks up to ten minutes. Generation will not use a trimmed section.";
  return null;
}

function estimatedBytes(audio: AudioBuffer) {
  return audio.length * audio.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function availableMemoryGiB() {
  if (typeof navigator === "undefined") return undefined;
  const hint = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof hint === "number" && Number.isFinite(hint) && hint > 0 ? hint : undefined;
}

function estimateMayIsolate(method: LyricsMethod, preset: LyricsPreset) {
  if (preset === "quality") return true;
  if (method !== "local") return false;
  if (preset !== "auto" || typeof navigator === "undefined") return false;
  const hasWebGpu = "gpu" in navigator;
  return hasWebGpu && (availableMemoryGiB() ?? 3) >= 3;
}

function readAudio(audio: AudioBuffer, trackDuration: number, retainedOtherBytes = 0): LyricsAudio {
  if (audio.numberOfChannels < 1 || audio.numberOfChannels > 2)
    throw new Error("Automatic subtitles support mono or stereo audio.");
  const fullChannels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  const maximumSamples = Math.max(1, Math.ceil(trackDuration * audio.sampleRate));
  const channelLength = Math.min(fullChannels[0]?.length ?? 0, maximumSamples);
  const channels = fullChannels.map((channel) => channel.subarray(0, channelLength));
  if (channels.some((channel) => !channel.length || channel.length !== channels[0].length))
    throw new Error("The decoded audio has an invalid or empty sample layout.");
  const durationMs = (channels[0].length / audio.sampleRate) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0)
    throw new Error("The active track has no usable audio samples.");
  return {
    channels,
    sampleRate: audio.sampleRate,
    durationMs,
    retainedBytes: estimatedBytes(audio) + retainedOtherBytes,
  };
}

function estimatedRetainedBytes(durationMs: number, sampleRate: number, channels: number) {
  return Math.ceil((durationMs / 1000) * sampleRate * channels * Float32Array.BYTES_PER_ELEMENT);
}

function assessAudioAdmission(
  source: LyricsSource,
  method: LyricsMethod,
  preset: LyricsPreset,
  audio?: AudioBuffer | null,
) {
  const durationMs = audio
    ? Math.round(Math.min(audio.duration, source.duration) * 1000)
    : Math.round(source.duration * 1000);
  const sampleRate = audio?.sampleRate ?? 44_100;
  const channelCount = audio?.numberOfChannels ?? 2;
  const retainedBytes = audio
    ? estimatedBytes(audio)
    : estimatedRetainedBytes(durationMs, sampleRate, channelCount);
  return assessLyricsInput({
    method,
    fileBytes: source.file.size,
    durationMs,
    sampleRate,
    channelCount,
    retainedBytes: retainedBytes + (source.retainedOtherBytes ?? 0),
    deviceMemoryGiB: availableMemoryGiB(),
    isolation: estimateMayIsolate(method, preset),
    model: preset === "quality" ? "base" : "tiny",
  });
}

/**
 * Coordinates lazy local/Gemini adapters with the studio's synchronous shared lock.
 * Audio arrays remain owned by the media session; adapters receive read-only slices.
 */
export function useSubtitleGeneration(options: UseSubtitleGenerationOptions) {
  const optionsRef = useRef(options);
  const jobRef = useRef<ActiveJob | null>(null);
  const localAdapterRef = useRef<LyricsAdapter | null>(null);
  const geminiAdapterRef = useRef<LyricsAdapter | null>(null);
  const apiKeyRef = useRef("");
  const cloudConsentScopeRef = useRef<string | null>(null);
  const lastRequestRef = useRef<{
    method: LyricsMethod;
    preset: LyricsPreset;
    languageCode: string;
  } | null>(null);
  const resultRef = useRef<GenerationSnapshot | null>(null);
  const mountedRef = useRef(true);

  const [method, setMethodState] = useState<LyricsMethod>(DEFAULT_METHOD);
  const [preset, setPresetState] = useState<LyricsPreset>(DEFAULT_PRESET);
  const [languageCode, setLanguageCodeState] = useState<string>("");
  const [apiKey, setApiKeyState] = useState("");
  const [phase, setPhase] = useState<SubtitleGenerationPhase>("idle");
  const [running, setRunning] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [progress, setProgress] = useState<LyricsProgress | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resultState, setResultState] = useState<GenerationSnapshot | null>(null);
  const [needsReplacement, setNeedsReplacement] = useState(false);
  const [cloudConsentScope, setCloudConsentScope] = useState<string | null>(null);

  const currentSource = (() => {
    try {
      return options.getSource();
    } catch {
      return null;
    }
  })();
  const currentRevision = (() => {
    try {
      return options.getRevision();
    } catch {
      return { sourceGeneration: -1, cueRevision: "invalid" };
    }
  })();
  const currentSourceScope = currentSource
    ? `${fileIdentity(currentSource)}:${currentRevision.sourceIdentity ?? ""}`
    : null;
  const hasCloudConsent = !!currentSourceScope && cloudConsentScope === currentSourceScope;
  const currentResult = (() => {
    const snapshot = resultState;
    if (!snapshot || !sameMedia(snapshot.revision, currentRevision)) return null;
    if (sameRevision(snapshot.revision, currentRevision)) return snapshot;
    const currentCues = options.getCues();
    if (
      snapshot.appliedCueFingerprint &&
      cuesFingerprint(currentCues) === snapshot.appliedCueFingerprint
    )
      return snapshot;
    return null;
  })();
  const validationError = currentSource ? sourceLimitError(currentSource) : null;

  const setApiKey = useCallback(
    (value: string) => {
      if (apiKeyRef.current !== value) {
        const job = jobRef.current;
        if (job?.method === "gemini") {
          job.cancelReason = "method";
          job.controller.abort();
        }
        geminiAdapterRef.current?.dispose();
        geminiAdapterRef.current = null;
      }
      apiKeyRef.current = value;
      setApiKeyState(value);
    },
    [setApiKeyState],
  );

  const acknowledgeCloudUpload = useCallback(
    (acknowledged: boolean) => {
      const source = options.getSource();
      if (!acknowledged || !source) {
        cloudConsentScopeRef.current = null;
        setCloudConsentScope(null);
        return;
      }
      const revision = options.getRevision();
      const scope = `${fileIdentity(source)}:${revision.sourceIdentity ?? ""}`;
      cloudConsentScopeRef.current = scope;
      setCloudConsentScope(scope);
    },
    [options, setCloudConsentScope],
  );

  const disposeAdapter = useCallback((target: LyricsMethod) => {
    if (target === "local") {
      localAdapterRef.current?.dispose();
      localAdapterRef.current = null;
    } else {
      geminiAdapterRef.current?.dispose();
      geminiAdapterRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    const job = jobRef.current;
    if (!job || job.controller.signal.aborted) return;
    job.cancelReason = "user";
    setCancelRequested(true);
    job.controller.abort();
  }, []);

  const setMethod = useCallback(
    (next: LyricsMethod) => {
      const currentJob = jobRef.current;
      if (currentJob && currentJob.method !== next && !currentJob.controller.signal.aborted) {
        currentJob.cancelReason = "method";
        setCancelRequested(true);
        currentJob.controller.abort();
      }
      if (method !== next) {
        lastRequestRef.current = null;
        if (next === "local") {
          geminiAdapterRef.current?.dispose();
          geminiAdapterRef.current = null;
        } else {
          localAdapterRef.current?.dispose();
          localAdapterRef.current = null;
        }
      }
      setLanguageCodeState((current) => resolveLanguageCode(next, current));
      setMethodState(next);
      setError(null);
    },
    [method],
  );

  const setPreset = useCallback(
    (next: LyricsPreset) => {
      const currentJob = jobRef.current;
      if (currentJob && currentJob.preset !== next && !currentJob.controller.signal.aborted) {
        currentJob.cancelReason = "preset";
        setCancelRequested(true);
        currentJob.controller.abort();
      }
      if (preset !== next) lastRequestRef.current = null;
      setPresetState(next);
      setError(null);
    },
    [preset],
  );

  const setLanguageCode = useCallback(
    (next: string) => {
      if (!getLanguageOptions(method).some(([code]) => code === next) || jobRef.current) return;
      lastRequestRef.current = null;
      setLanguageCodeState(next);
      setError(null);
    },
    [method],
  );

  const disconnectGemini = useCallback(() => {
    if (jobRef.current?.method === "gemini") {
      const job = jobRef.current;
      job.cancelReason = "method";
      setCancelRequested(true);
      job.controller.abort();
    }
    apiKeyRef.current = "";
    setApiKeyState("");
    cloudConsentScopeRef.current = null;
    setCloudConsentScope(null);
    if (lastRequestRef.current?.method === "gemini") lastRequestRef.current = null;
    disposeAdapter("gemini");
  }, [disposeAdapter]);

  const ensureAdapter = useCallback(async (target: LyricsMethod) => {
    if (target === "local") {
      if (localAdapterRef.current) return localAdapterRef.current;
      const { createLocalLyricsAdapter } = await import("@/lib/lyrics/local-client");
      const adapter = createLocalLyricsAdapter();
      localAdapterRef.current = adapter;
      return adapter;
    }
    if (geminiAdapterRef.current) return geminiAdapterRef.current;
    const { createGeminiLyricsAdapter } = await import("@/lib/lyrics/gemini-client");
    const adapter = createGeminiLyricsAdapter({
      getApiKey: () => apiKeyRef.current,
    });
    geminiAdapterRef.current = adapter;
    return adapter;
  }, []);

  const getAudio = useCallback(
    async (
      source: LyricsSource,
      targetMethod: LyricsMethod,
      targetPreset: LyricsPreset,
      signal: AbortSignal,
    ) => {
      const initialLimit = sourceLimitError(source);
      if (initialLimit) throw new Error(initialLimit);
      const preflight = assessAudioAdmission(
        source,
        targetMethod,
        targetPreset,
        source.retainedAudio,
      );
      if (!preflight.admitted)
        throw new Error(preflight.reason || "This track exceeds the memory budget.");
      if (signal.aborted) throw new DOMException("Audio preparation canceled.", "AbortError");

      let audio = source.retainedAudio ?? null;
      if (!audio) {
        const { decodeMediaAudio } = await import("@/lib/media/media-audio");
        audio = await decodeMediaAudio(source.file, signal);
      }
      if (signal.aborted) throw new DOMException("Audio preparation canceled.", "AbortError");
      if (!audio)
        throw new Error("This media file has no readable audio track for subtitle generation.");
      const admission = assessAudioAdmission(source, targetMethod, targetPreset, audio);
      if (!admission.admitted)
        throw new Error(admission.reason || "This track exceeds the estimated memory budget.");
      return readAudio(audio, source.duration, source.retainedOtherBytes);
    },
    [],
  );

  const generate = useCallback(
    async (override?: { method?: LyricsMethod; preset?: LyricsPreset; languageCode?: string }) => {
      const currentOptions = optionsRef.current;
      const targetMethod = override?.method ?? method;
      const targetPreset = override?.preset ?? preset;
      const targetLanguageCode = resolveLanguageCode(
        targetMethod,
        override?.languageCode ?? languageCode,
      );
      if (jobRef.current || currentOptions.lockedRef.current) return false;
      const source = currentOptions.getSource();
      if (!source) {
        setError("Load a complete track before generating subtitles.");
        setPhase("error");
        return false;
      }
      const limit = sourceLimitError(source);
      if (limit) {
        setError(limit);
        setPhase("error");
        return false;
      }
      const revision = currentOptions.getRevision();
      if (revision.sourceGeneration !== source.generation) {
        setError("The active media changed. Wait for the committed track, then try again.");
        setPhase("error");
        return false;
      }
      const sourceScope = `${fileIdentity(source)}:${revision.sourceIdentity ?? ""}`;
      if (targetMethod === "gemini") {
        if (!apiKeyRef.current.trim()) {
          setError(
            "Enter your Gemini API key. It stays in this browser session and is cleared when disconnected or reloaded.",
          );
          setPhase("error");
          return false;
        }
        if (cloudConsentScopeRef.current !== sourceScope || cloudConsentScope !== sourceScope) {
          setError(
            "Confirm that this track's audio may be sent to Google before starting Gemini generation.",
          );
          setPhase("error");
          return false;
        }
      }
      const controller = new AbortController();
      const job: ActiveJob = {
        controller,
        source,
        sourceId: sourceIdFor(source, revision),
        revision,
        method: targetMethod,
        preset: targetPreset,
        startedAt: Date.now(),
        cancelReason: null,
        lockOwned: true,
      };
      jobRef.current = job;
      lastRequestRef.current = {
        method: targetMethod,
        preset: targetPreset,
        languageCode: targetLanguageCode,
      };
      currentOptions.lockedRef.current = true;
      setRunning(true);
      setPhase("running");
      setCancelRequested(false);
      setProgress({
        stage: "prepare",
        message: "Preparing the complete active track…",
        elapsedMs: 0,
      });
      setStartedAt(job.startedAt);
      setRetryable(true);
      setError(null);
      setNotice(null);

      const release = () => {
        if (job.lockOwned) {
          job.lockOwned = false;
          if (currentOptions.lockedRef.current) currentOptions.lockedRef.current = false;
        }
        if (jobRef.current === job) jobRef.current = null;
        if (mountedRef.current) {
          setRunning(false);
          setCancelRequested(false);
        }
      };

      try {
        const audio = await getAudio(source, targetMethod, targetPreset, controller.signal);
        if (controller.signal.aborted) throw new DOMException("Generation canceled.", "AbortError");
        if (!sameRevision(currentOptions.getRevision(), revision)) {
          job.cancelReason = "revision";
          throw new Error(
            "Subtitles or the active track changed during preparation. Generate again from the current version.",
          );
        }
        const adapter = await ensureAdapter(targetMethod);
        if (controller.signal.aborted) throw new DOMException("Generation canceled.", "AbortError");
        const result = await adapter.generate(audio, {
          preset: targetPreset,
          languageCode: targetLanguageCode,
          sourceId: job.sourceId,
          signal: controller.signal,
          onProgress: (next) => {
            if (jobRef.current !== job || controller.signal.aborted || !mountedRef.current) return;
            setProgress({
              ...next,
              elapsedMs: Math.max(0, Date.now() - job.startedAt),
            });
          },
        });
        if (controller.signal.aborted) throw new DOMException("Generation canceled.", "AbortError");
        const latestOptions = optionsRef.current;
        const latestRevision = latestOptions.getRevision();
        if (!sameRevision(latestRevision, revision)) {
          job.cancelReason = "revision";
          throw new Error(
            "The active media or subtitles changed while generation was running. The result was discarded.",
          );
        }
        if (!sameMedia(latestRevision, revision)) {
          job.cancelReason = "source";
          throw new Error(
            "The active track changed while generation was running. The result was discarded.",
          );
        }

        const applyDurationMs = Math.min(
          source.duration * 1000,
          result.durationMs > 0 ? result.durationMs : source.duration * 1000,
        );
        const application = generatedCuesToSubtitles(result.cues, applyDurationMs);
        const existingCues = latestOptions.getCues();
        const snapshot: GenerationSnapshot = {
          source,
          sourceId: job.sourceId,
          revision,
          method: targetMethod,
          preset: targetPreset,
          result,
          application,
          startedAt: job.startedAt,
          appliedCueFingerprint: null,
        };
        const autoApply = !existingCues.length && application.cues.length > 0 && !application.error;
        if (autoApply) {
          // `setSubtitles` checks the shared lock. Release it in this stack and
          // immediately perform the synchronous canonical state update.
          currentOptions.lockedRef.current = false;
          job.lockOwned = false;
          if (jobRef.current === job) jobRef.current = null;
          const fingerprint = cuesFingerprint(application.cues);
          snapshot.appliedCueFingerprint = fingerprint;
          latestOptions.applyCues(application.cues);
        }

        resultRef.current = snapshot;
        if (mountedRef.current) {
          setResultState(snapshot);
          setNeedsReplacement(
            !autoApply &&
              existingCues.length > 0 &&
              application.cues.length > 0 &&
              !application.error,
          );
          setPhase("complete");
          setProgress({
            stage: "format",
            message: result.cues.length
              ? `Generated ${result.cues.length} subtitle ${result.cues.length === 1 ? "line" : "lines"}.`
              : "No lyrics were detected in this track.",
            elapsedMs: Math.max(0, Date.now() - job.startedAt),
          });
          const notices = [...result.notices];
          if (application.error) notices.push(application.error);
          if (autoApply)
            notices.unshift(
              "Generated subtitles were applied. Machine-generated lyrics; wording and timing may be inaccurate.",
            );
          else if (result.cues.length)
            notices.unshift("Machine-generated lyrics; wording and timing may be inaccurate.");
          setNotice(notices.length ? notices.join(" ") : null);
        }
        release();
        return true;
      } catch (caught) {
        const canceled = isAbort(caught) || controller.signal.aborted;
        const cancelReason = job.cancelReason;
        if (mountedRef.current) {
          const providerNotices =
            caught &&
            typeof caught === "object" &&
            "notices" in caught &&
            Array.isArray(caught.notices)
              ? (caught.notices as unknown[]).filter(
                  (item): item is string => typeof item === "string",
                )
              : [];
          setPhase(canceled ? "canceled" : "error");
          setRetryable(
            !(
              caught &&
              typeof caught === "object" &&
              "retryable" in caught &&
              caught.retryable === false
            ),
          );
          setError(
            canceled
              ? cancelReason === "source"
                ? "Generation stopped because the committed track changed."
                : cancelReason === "revision"
                  ? "Generation stopped because subtitles or the active track changed."
                  : cancelReason === "unmount"
                    ? null
                    : "Generation canceled. Existing subtitles were preserved."
              : userError(caught, apiKeyRef.current),
          );
          if (providerNotices.length)
            setNotice(
              providerNotices
                .map((message) => userError(new Error(message), apiKeyRef.current))
                .join(" "),
            );
        }
        return false;
      } finally {
        release();
      }
    },
    [cloudConsentScope, ensureAdapter, getAudio, languageCode, method, preset],
  );

  const retry = useCallback(() => {
    if (!retryable) return Promise.resolve(false);
    const request = lastRequestRef.current;
    if (!request) return Promise.resolve(false);
    return generate(request);
  }, [generate, retryable]);

  const useFast = useCallback(() => {
    lastRequestRef.current = null;
    geminiAdapterRef.current?.dispose();
    geminiAdapterRef.current = null;
    setLanguageCodeState((current) => resolveLanguageCode("local", current));
    setMethodState("local");
    setPresetState("fast");
    return generate({ method: "local", preset: "fast" });
  }, [generate]);

  const applyGenerated = useCallback(() => {
    const snapshot = resultRef.current;
    const currentOptions = optionsRef.current;
    if (!snapshot || !snapshot.application.cues.length || snapshot.application.error) return false;
    if (currentOptions.lockedRef.current) {
      setError("Subtitles cannot be changed while another operation is running.");
      return false;
    }
    const currentRevision = currentOptions.getRevision();
    if (!sameRevision(snapshot.revision, currentRevision)) {
      setError("The subtitles changed after generation. Generate again before replacing them.");
      setPhase("error");
      return false;
    }
    if (snapshot.source.file !== currentOptions.getSource()?.file) {
      setError(
        "The active track changed after generation. Generate again before applying this result.",
      );
      setPhase("error");
      return false;
    }
    const fingerprint = cuesFingerprint(snapshot.application.cues);
    snapshot.appliedCueFingerprint = fingerprint;
    currentOptions.applyCues(snapshot.application.cues);
    setResultState({ ...snapshot });
    setNeedsReplacement(false);
    setNotice(
      "Generated subtitles were applied. Machine-generated lyrics; wording and timing may be inaccurate.",
    );
    return true;
  }, []);

  const keepExisting = useCallback(() => {
    const snapshot = resultRef.current;
    if (optionsRef.current.lockedRef.current) {
      setError("Wait for the current operation to finish before keeping subtitles.");
      return false;
    }
    if (!snapshot || !sameRevision(snapshot.revision, optionsRef.current.getRevision())) {
      setError(
        "The subtitles changed after generation. Generate again to review a current result.",
      );
      setPhase("error");
      return false;
    }
    setNeedsReplacement(false);
    setNotice("Existing subtitles were kept. The generated result remains available to download.");
    return true;
  }, []);

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const job = jobRef.current;
    const revision = optionsRef.current.getRevision();
    if (job && !sameRevision(job.revision, revision) && !job.controller.signal.aborted) {
      job.cancelReason = sameMedia(job.revision, revision) ? "revision" : "source";
      setCancelRequested(true);
      job.controller.abort();
    }

    const snapshot = resultRef.current;
    if (!snapshot) return;
    const source = optionsRef.current.getSource();
    if (
      !sameMedia(snapshot.revision, revision) ||
      (!!source && source.file !== snapshot.source.file)
    ) {
      resultRef.current = null;
      setResultState(null);
      setNeedsReplacement(false);
      setNotice("The active track changed. Generate subtitles again for the new track.");
      return;
    }
    if (sameRevision(snapshot.revision, revision)) return;
    const cues = optionsRef.current.getCues();
    const fingerprint = cuesFingerprint(cues);
    if (snapshot.appliedCueFingerprint && fingerprint === snapshot.appliedCueFingerprint) {
      snapshot.revision = revision;
      setResultState({ ...snapshot });
      return;
    }
    resultRef.current = null;
    setResultState(null);
    setNeedsReplacement(false);
    setNotice(
      "Subtitles changed after generation. The old result was cleared; generate again to keep downloads current.",
    );
  }, [options.revisionKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const job = jobRef.current;
      if (job && !job.controller.signal.aborted) {
        job.cancelReason = "unmount";
        job.controller.abort();
      }
      localAdapterRef.current?.dispose();
      geminiAdapterRef.current?.dispose();
      localAdapterRef.current = null;
      geminiAdapterRef.current = null;
    };
  }, []);

  const sourceStillCurrent =
    !!currentSource &&
    currentSource.generation === currentRevision.sourceGeneration &&
    (!currentResult || currentSource.file === currentResult.source.file);
  const currentResultValid = !!currentResult && sourceStillCurrent;
  const canGenerate =
    !!currentSource &&
    !validationError &&
    !running &&
    (method !== "gemini" || (!!apiKey.trim() && hasCloudConsent));

  return {
    method,
    setMethod,
    preset,
    setPreset,
    languageCode,
    setLanguageCode,
    apiKey,
    setApiKey,
    disconnectGemini,
    cloudConsent: hasCloudConsent,
    acknowledgeCloudUpload,
    running,
    cancelRequested,
    phase,
    progress,
    retryable,
    startedAt,
    elapsedMs: progress?.elapsedMs ?? 0,
    error,
    notice,
    result: running ? null : currentResultValid ? currentResult : null,
    needsReplacement: currentResultValid && needsReplacement,
    applicationError: currentResultValid ? (currentResult?.application.error ?? null) : null,
    validationError,
    canGenerate,
    generate,
    retry,
    useFast,
    cancel,
    applyGenerated,
    keepExisting,
  };
}
