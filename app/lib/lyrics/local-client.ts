import type { LyricsAdapter, LyricsAudio, LyricsRunOptions } from "./types";
import type { IsolationBackend } from "./isolation";
import type { LyricsWorkerRequest, LyricsWorkerResponse } from "./worker-protocol";

const AUDIO_SLICE_SAMPLES = 65_536;
const WORKER_HANDSHAKE_TIMEOUT_MS = 30_000;

type ActiveRequest = {
  id: number;
  audio: LyricsAudio;
  options: LyricsRunOptions;
  resolve: (value: WorkerResult) => void;
  reject: (reason: Error) => void;
  abort: () => void;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
};

type IsolatedAudio = {
  channels: [Float32Array, Float32Array];
  backend: IsolationBackend;
  notices: string[];
};
type WorkerResult = Awaited<ReturnType<LyricsAdapter["generate"]>> | IsolatedAudio;

/** A worker is created only after Generate subtitles is requested. */
export function createLocalLyricsAdapter(): LyricsAdapter & {
  isolate(audio: LyricsAudio, options: LyricsRunOptions): Promise<IsolatedAudio>;
} {
  let worker: Worker | null = null;
  let active: ActiveRequest | null = null;
  let nextJobId = 1;
  let disposed = false;

  const terminate = (reason?: Error) => {
    worker?.terminate();
    worker = null;
    if (active) {
      const current = active;
      active = null;
      if (current.handshakeTimer) clearTimeout(current.handshakeTimer);
      current.options.signal.removeEventListener("abort", current.abort);
      current.reject(reason ?? new Error("Local subtitle generation stopped."));
    }
  };

  const getWorker = () => {
    if (disposed) throw new Error("The local subtitle worker has been disposed.");
    if (worker) return worker;
    worker = new Worker(new URL("./processing.worker.ts", import.meta.url), {
      type: "module",
      name: "pulseframe-local-lyrics",
    });
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onWorkerError);
    worker.addEventListener("messageerror", onMessageError);
    return worker;
  };

  const onWorkerError = (event: ErrorEvent) => {
    terminate(new Error(event.message || "The local subtitle worker stopped unexpectedly."));
  };

  const onMessageError = () => {
    terminate(new Error("The local subtitle worker returned an unreadable response."));
  };

  const onMessage = (event: MessageEvent<LyricsWorkerResponse>) => {
    const message = event.data;
    const current = active;
    if (!current || message.jobId !== current.id) return;
    if (current.handshakeTimer) {
      clearTimeout(current.handshakeTimer);
      current.handshakeTimer = null;
    }

    if (message.type === "progress") {
      current.options.onProgress(message.progress);
      return;
    }
    if (message.type === "need-audio") {
      try {
        const offset = message.offset;
        const end = offset + message.length;
        const firstChannelLength = current.audio.channels[0]?.length;
        if (
          !Number.isInteger(firstChannelLength) ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(message.length) ||
          message.length < 1 ||
          message.length > AUDIO_SLICE_SAMPLES ||
          end > firstChannelLength ||
          current.audio.channels.length < 1 ||
          current.audio.channels.some((channel) => end > channel.length)
        ) {
          throw new Error("The local worker requested an invalid audio slice.");
        }
        // The media owner retains its source buffers. Only these bounded copies
        // are transferred to the worker, so its buffers can never be detached.
        const channels = current.audio.channels.map((channel) =>
          channel.subarray(offset, end).slice(),
        );
        const transfer = channels.map((channel) => channel.buffer as ArrayBuffer);
        getWorker().postMessage(
          {
            type: "audio-slice",
            jobId: current.id,
            offset,
            channels,
          } satisfies LyricsWorkerRequest,
          transfer,
        );
      } catch (error) {
        terminate(
          error instanceof Error
            ? error
            : new Error("Could not copy the audio for local processing."),
        );
      }
      return;
    }
    if (message.type === "error") {
      if (message.fatal) {
        terminate(new Error(message.message));
        return;
      }
      finishFailure(new Error(message.message));
      return;
    }
    finishSuccess(
      message.type === "isolated"
        ? {
            channels: message.channels,
            backend: message.backend,
            notices: message.notices,
          }
        : message.result,
    );
  };

  const finishSuccess = (result: Parameters<ActiveRequest["resolve"]>[0]) => {
    if (!active) return;
    const current = active;
    active = null;
    if (current.handshakeTimer) clearTimeout(current.handshakeTimer);
    current.options.signal.removeEventListener("abort", current.abort);
    const completedWorker = worker;
    if (completedWorker) {
      completedWorker.removeEventListener("message", onMessage);
      completedWorker.removeEventListener("error", onWorkerError);
      completedWorker.removeEventListener("messageerror", onMessageError);
      completedWorker.terminate();
      worker = null;
    }
    current.resolve(result);
  };

  const finishFailure = (error: Error) => {
    if (!active) return;
    const current = active;
    active = null;
    if (current.handshakeTimer) clearTimeout(current.handshakeTimer);
    current.options.signal.removeEventListener("abort", current.abort);
    current.reject(error);
  };

  const start = (
    audio: LyricsAudio,
    options: LyricsRunOptions,
    isolationOnly: boolean,
  ): Promise<WorkerResult> => {
    if (disposed) return Promise.reject(new Error("The local subtitle worker has been disposed."));
    if (active) return Promise.reject(new Error("Local subtitle generation is already running."));
    if (options.signal.aborted)
      return Promise.reject(new DOMException("Generation canceled.", "AbortError"));
    if (!audio.channels.length || audio.channels.length > 2)
      return Promise.reject(new Error("Automatic subtitles support mono or stereo audio."));
    const sampleCount = audio.channels[0]?.length ?? 0;
    if (!sampleCount || audio.channels.some((channel) => channel.length !== sampleCount))
      return Promise.reject(new Error("The audio data is empty or inconsistent."));

    const currentId = nextJobId++;
    return new Promise((resolve, reject) => {
      const abort = () => terminate(new DOMException("Generation canceled.", "AbortError"));
      active = {
        id: currentId,
        audio,
        options,
        resolve,
        reject,
        abort,
        handshakeTimer: null,
      };
      options.signal.addEventListener("abort", abort, { once: true });
      const request: LyricsWorkerRequest = {
        type: "start",
        jobId: currentId,
        preset: options.preset,
        sourceId: options.sourceId,
        sampleRate: audio.sampleRate,
        durationMs: audio.durationMs,
        sampleCount,
        channelCount: audio.channels.length,
        retainedBytes: audio.retainedBytes,
        isolationOnly,
        languageCode: isolationOnly ? undefined : options.languageCode,
      };
      try {
        getWorker().postMessage(request);
        active.handshakeTimer = setTimeout(() => {
          terminate(new Error("The local subtitle worker did not start. Reload and try again."));
        }, WORKER_HANDSHAKE_TIMEOUT_MS);
      } catch (error) {
        terminate(
          error instanceof Error ? error : new Error("Could not start local subtitle generation."),
        );
      }
    });
  };

  return {
    async generate(audio, options) {
      const result = await start(audio, options, false);
      if ("channels" in result) throw new Error("The local worker returned unexpected audio.");
      return result;
    },
    async isolate(audio, options) {
      const result = await start(audio, options, true);
      if (!("channels" in result))
        throw new Error("The local worker returned unexpected subtitles.");
      return result;
    },
    dispose() {
      disposed = true;
      terminate(new Error("The local subtitle worker was disposed."));
    },
  };
}
