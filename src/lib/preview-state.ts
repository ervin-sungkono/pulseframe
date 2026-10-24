import { ANALYSIS_FPS } from "./audio/audio-analysis-config";
import type { SoundEnvelope } from "./audio/audio-features";
import type { MediaSessionSnapshot } from "./media/media-session";
import {
  createAudioReactiveState,
  soundResponse,
  type AudioReactiveState,
} from "./visual/visualizer";
import type { VisualSettings } from "./visual/visual-settings-model";

type Snapshot = Pick<
  MediaSessionSnapshot,
  "generation" | "media" | "duration" | "sound" | "features"
>;

export type PreviewWarmResult = {
  state: AudioReactiveState;
  time: number;
  generation: number;
};

export const responseSettingsKey = (settings: VisualSettings) =>
  `${settings.sensitivity}|${settings.quietThreshold}|${settings.bassBoost}|${settings.responseStyle}`;

function yieldToBrowser(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 0);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Advances a warmed state across every missed analysis frame after playback continues. */
export function advancePreviewResponse(
  state: AudioReactiveState,
  snapshot: Snapshot,
  settings: VisualSettings,
  fromTime: number,
  toTime: number,
) {
  const time = Math.max(fromTime, Math.min(snapshot.duration, toTime));
  if (time <= fromTime) return fromTime;
  const envelopes = snapshot.sound?.envelopes ?? [];
  const silence: SoundEnvelope = {
    rms: 0,
    rmsDb: -160,
    bassDb: -160,
    middleDb: -160,
    highDb: -160,
    bands: (envelopes[0]?.bands ?? []).map((band) => new Float32Array(band.length)),
  };
  let lastTime = fromTime;
  const finalFrame = Math.floor(time * ANALYSIS_FPS);
  for (let index = Math.floor(fromTime * ANALYSIS_FPS) + 1; index < finalFrame; index++) {
    const frameTime = index / ANALYSIS_FPS;
    soundResponse(envelopes[index] ?? silence, settings, state, 1000 / ANALYSIS_FPS);
    lastTime = frameTime;
  }
  const frame = snapshot.features?.at(time);
  if (frame) soundResponse(frame, settings, state, (time - lastTime) * 1000);
  return time;
}

/** Replays the complete causal sound history, yielding regularly and rejecting stale work. */
export function createPreviewResponseWarmer(options: {
  getSnapshot: () => Snapshot;
  getSettings: () => VisualSettings;
  apply: (result: PreviewWarmResult) => void;
  yieldControl?: (signal: AbortSignal) => Promise<void>;
  chunkSize?: number;
}) {
  let request = 0;
  let active: AbortController | null = null;
  const chunkSize = Math.max(1, options.chunkSize ?? 48);

  const cancel = () => {
    request++;
    active?.abort();
    active = null;
  };

  const warm = async (
    requestedTime: number,
    generation: number,
  ): Promise<PreviewWarmResult | null> => {
    cancel();
    const currentRequest = request;
    const snapshot = options.getSnapshot();
    const media = snapshot.media;
    if (!media || snapshot.generation !== generation || !snapshot.sound) return null;

    const time = Math.max(0, Math.min(snapshot.duration, requestedTime));
    const settings = options.getSettings();
    const key = responseSettingsKey(settings);
    const controller = new AbortController();
    active = controller;
    const isCurrent = () => {
      const latest = options.getSnapshot();
      return (
        currentRequest === request &&
        !controller.signal.aborted &&
        latest.generation === generation &&
        latest.media === media &&
        responseSettingsKey(options.getSettings()) === key
      );
    };

    const envelopes: SoundEnvelope[] = snapshot.sound.envelopes;
    const count = Math.ceil(time * ANALYSIS_FPS);
    const state = createAudioReactiveState();
    let lastTime = time;

    if (envelopes.length && count <= envelopes.length + 10 * ANALYSIS_FPS) {
      lastTime = count ? (count - 1) / ANALYSIS_FPS : 0;
      const silence: SoundEnvelope = {
        rms: 0,
        rmsDb: -160,
        bassDb: -160,
        middleDb: -160,
        highDb: -160,
        bands: (envelopes[0]?.bands ?? []).map((band) => new Float32Array(band.length)),
      };
      for (let start = 0; start < count; start += chunkSize) {
        if (!isCurrent()) return null;
        const end = Math.min(count, start + chunkSize);
        for (let index = start; index < end; index++) {
          soundResponse(
            envelopes[index] ?? silence,
            settings,
            state,
            index ? 1000 / ANALYSIS_FPS : 0,
          );
        }
        if (end < count) {
          await (options.yieldControl ?? yieldToBrowser)(controller.signal);
          if (!isCurrent()) return null;
        }
      }
    }

    if (!isCurrent()) return null;
    const frame = options.getSnapshot().features?.at(time);
    if (frame) soundResponse(frame, settings, state, (time - lastTime) * 1000);
    if (!isCurrent()) return null;

    const result = { state, time, generation };
    active = null;
    options.apply(result);
    return result;
  };

  return { warm, cancel };
}
