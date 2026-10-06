"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { audibleMediaTime, dropEnvelope, type SoundFrame } from "@/lib/audio-features";
import { ANALYSIS_FPS, ANALYSIS_SIZE } from "@/lib/audio-analysis-config";
import { exportDimensions, type ExportAspect } from "@/lib/export-settings";
import type { MediaSessionOwner, MediaSessionEvent, MediaSessionSnapshot } from "@/lib/media-session";
import { advancePreviewResponse, createPreviewResponseWarmer, responseSettingsKey, type PreviewWarmResult } from "@/lib/preview-state";
import type { SubtitleCue } from "@/lib/subtitles";
import { createAudioReactiveState, drawVisualization, makeParticles, soundResponse, type AudioReactiveState, type Particle } from "@/lib/visualizer";
import type { VisualSettings } from "@/lib/visual-settings-model";

const previewDimensions = (format: ExportAspect) => exportDimensions(format, format === "square" ? 1080 : 720);

function cloneAudioState(state: AudioReactiveState): AudioReactiveState {
  return {
    ...state,
    bands: state.bands.map(channel => new Float32Array(channel)),
    ringBands: state.ringBands.map(layer => layer.map(channel => new Float32Array(channel))),
  };
}

export type UseVisualizerPreviewOptions = {
  session: MediaSessionOwner;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  settings: VisualSettings;
  subtitles: SubtitleCue[];
  format: ExportAspect;
  lockedRef: RefObject<boolean>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

/** Owns the display-only visualization loop and a full-size still-frame capture. */
export function useVisualizerPreview({
  session, canvasRef, settings, subtitles, format, lockedRef, onError, onNotice,
}: UseVisualizerPreviewOptions) {
  const settingsRef = useRef(settings);
  const subtitlesRef = useRef(subtitles);
  const formatRef = useRef(format);
  const onErrorRef = useRef(onError);
  const onNoticeRef = useRef(onNotice);
  const reducedMotionRef = useRef(false);
  const audioStateRef = useRef<AudioReactiveState>(createAudioReactiveState());
  const particleRef = useRef<Particle[]>(makeParticles(300));
  const frequencyRef = useRef(new Uint8Array(ANALYSIS_SIZE / 2));
  const waveRef = useRef(new Uint8Array(ANALYSIS_SIZE).fill(128));
  const soundFrameRef = useRef<SoundFrame | null>(null);
  const frameTimeRef = useRef(0);
  const dropRef = useRef(0);
  const lastAudioRef = useRef(0);
  const requestRef = useRef(0);
  const pendingWarmRef = useRef<{ time: number; generation: number; media: HTMLMediaElement; request: number } | null>(null);
  const responseCacheRef = useRef(new Map<string, AudioReactiveState>());
  const responseWarmerRef = useRef<{
    warm: (time: number, generation: number) => Promise<PreviewWarmResult | null>;
    cancel: () => void;
  } | null>(null);

  useEffect(() => {
    const warmer = createPreviewResponseWarmer({
      getSnapshot: () => session.snapshot,
      getSettings: () => settingsRef.current,
      apply: result => {
        const current = session.snapshot;
        let time = result.time;
        if (current.generation === result.generation && current.media && !current.media.paused) {
          const audibleTime = Math.floor(audibleMediaTime(current.media, current.audioContext, performance.now()) * ANALYSIS_FPS) / ANALYSIS_FPS;
          time = Math.max(result.time, audibleTime);
          if (current.sound && time > result.time) {
            advancePreviewResponse(result.state, current, settingsRef.current, result.time, time);
          }
        }
        audioStateRef.current = result.state;
        lastAudioRef.current = time;
        pendingWarmRef.current = null;
      },
    });
    responseWarmerRef.current = warmer;
    return () => {
      warmer.cancel();
      if (responseWarmerRef.current === warmer) responseWarmerRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    settingsRef.current = settings;
    subtitlesRef.current = subtitles;
    formatRef.current = format;
    onErrorRef.current = onError;
    onNoticeRef.current = onNotice;
  }, [settings, subtitles, format, onError, onNotice]);

  const cancelWarm = useCallback(() => {
    requestRef.current++;
    pendingWarmRef.current = null;
    responseWarmerRef.current?.cancel();
  }, []);

  const queueWarm = useCallback((requestedTime: number, generation: number) => {
    cancelWarm();
    const request = requestRef.current;
    const snapshot = session.snapshot;
    const media = snapshot?.media;
    if (!snapshot || !media || snapshot.generation !== generation) return;

    const time = Math.max(0, Math.min(snapshot.duration, requestedTime));
    const settingsAtStart = settingsRef.current;
    const responseKey = responseSettingsKey(settingsAtStart);
    const cacheKey = `${generation}:${Math.round(time * ANALYSIS_FPS)}:${responseKey}`;
    pendingWarmRef.current = { time, generation, media, request };
    const isCurrent = () => {
      const latest = session.snapshot;
      return requestRef.current === request
        && latest?.generation === generation
        && latest.media === media
        && responseSettingsKey(settingsRef.current) === responseKey;
    };

    const sound = snapshot.sound;

    if (sound) {
      const cached = responseCacheRef.current.get(cacheKey);
      if (cached) {
        if (isCurrent()) {
          // Rendering advances its state in place, so cached history always
          // gets a private copy before it becomes the active response state.
          responseCacheRef.current.delete(cacheKey);
          responseCacheRef.current.set(cacheKey, cached);
          audioStateRef.current = cloneAudioState(cached);
          lastAudioRef.current = time;
          pendingWarmRef.current = null;
        }
        return;
      }
    }

    // Live analysis has no retained history. Match the old paused-settings path
    // by restarting from the held frame; full PCM audio is replayed below.
    if (!sound) {
      const state = createAudioReactiveState();
      const frame = soundFrameRef.current;
      if (frame) soundResponse(frame, settingsAtStart, state, 1000);
      if (!isCurrent()) return;
      audioStateRef.current = state;
      lastAudioRef.current = time;
      pendingWarmRef.current = null;
      return;
    }
    const warmer = responseWarmerRef.current;
    if (!warmer) { pendingWarmRef.current = null; return; }
    void warmer.warm(time, generation).then(result => {
      if (result) {
        const appliedCacheKey = `${generation}:${Math.round(lastAudioRef.current * ANALYSIS_FPS)}:${responseKey}`;
        responseCacheRef.current.set(appliedCacheKey, cloneAudioState(result.state));
        if (responseCacheRef.current.size > 8) {
          const oldest = responseCacheRef.current.keys().next().value;
          if (oldest !== undefined) responseCacheRef.current.delete(oldest);
        }
      } else if (pendingWarmRef.current?.request === request) {
        pendingWarmRef.current = null;
      }
    });
  }, [cancelWarm, session]);

  const captureImage = useCallback(() => {
    const target = previewDimensions(formatRef.current);
    const imageCanvas = document.createElement("canvas");
    imageCanvas.width = target.width;
    imageCanvas.height = target.height;
    const context = imageCanvas.getContext("2d", { alpha: false });
    if (!context) {
      onErrorRef.current("Could not create the image.");
      return;
    }
    const snapshot = session.snapshot;
    const sound = soundFrameRef.current;
    drawVisualization(context, settingsRef.current, frequencyRef.current, waveRef.current,
      particleRef.current, frameTimeRef.current, 0, snapshot?.video ?? null,
      snapshot?.logo?.image ?? null, audioStateRef.current, sound?.sampleRate ?? 48000,
      snapshot?.duration ?? 0, subtitlesRef.current,
      { sound, background: snapshot?.background?.image ?? null, drop: dropRef.current,
        reducedMotion: reducedMotionRef.current });
    imageCanvas.toBlob(blob => {
      if (!blob) {
        onErrorRef.current("Could not create the image.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pulseframe-${settingsRef.current.mode}-${target.label.replace(":", "x")}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onNoticeRef.current("Frame saved as PNG.");
    }, "image/png");
  }, [session]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { reducedMotionRef.current = preference.matches; };
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const target = previewDimensions(formatRef.current);
      const maxEdge = window.innerWidth <= 860 ? 900 : 1280;
      const scale = Math.min(1, maxEdge / Math.max(target.width, target.height));
      const width = Math.round(target.width * scale);
      const height = Math.round(target.height * scale);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [canvasRef, format]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;
    let frame = 0;
    let last = 0;
    let lastUi = 0;
    const demoFrequency = new Uint8Array(ANALYSIS_SIZE / 2);
    const demoWave = new Uint8Array(ANALYSIS_SIZE);

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (document.hidden || now - last < 1000 / ANALYSIS_FPS - 1) return;
      const delta = Math.min(100, now - last);
      last = now;
      const snapshot: MediaSessionSnapshot = session.snapshot;
      if (!lockedRef.current) {
        const media = snapshot.media;
        const visualTime = media ? audibleMediaTime(media, snapshot.audioContext, now) : now / 1000;
        const analysisTime = Math.floor(visualTime * ANALYSIS_FPS) / ANALYSIS_FPS;
        const pendingWarm = pendingWarmRef.current;
        const warmingCurrentSeek = !!media && pendingWarm?.generation === snapshot.generation && pendingWarm.media === media;
        if (analysisTime < lastAudioRef.current && !warmingCurrentSeek) {
          audioStateRef.current = createAudioReactiveState();
          snapshot.live?.reset();
        }
        const audioDelta = media
          ? (media.paused || warmingCurrentSeek ? 0 : Math.max(0, Math.min(.25, analysisTime - lastAudioRef.current)) * 1000)
          : delta;
        lastAudioRef.current = analysisTime;
        let frequency: Uint8Array = demoFrequency;
        let wave: Uint8Array = demoWave;
        const live = snapshot.live && media && !media.paused ? snapshot.live.at(analysisTime) : null;
        const sound = snapshot.features?.at(analysisTime)
          ?? live?.sound
          ?? (snapshot.live ? soundFrameRef.current : null);
        if (sound) {
          frequency = sound.frequency;
          wave = sound.wave;
        } else if (media) {
          demoFrequency.fill(0);
          demoWave.fill(128);
        } else {
          for (let i = 0; i < demoFrequency.length; i++) {
            demoFrequency[i] = Math.max(0, Math.min(255,
              (73 + 49 * Math.sin(i * .065 + now * .0017) + 26 * Math.sin(i * .015 - now * .0012)) * Math.exp(-i / 180)));
          }
          for (let i = 0; i < demoWave.length; i++) {
            demoWave[i] = 128 + 32 * Math.sin(i * .033 + now * .002) * Math.sin(i * .009 - now * .0007);
          }
        }
        soundFrameRef.current = sound;
        dropRef.current = media && !media.paused
          ? (live?.drop ?? dropEnvelope(snapshot.sound?.events ?? [], visualTime))
          : 0;
        frequencyRef.current.set(frequency);
        waveRef.current.set(wave);
        frameTimeRef.current = visualTime;
        drawVisualization(context, settingsRef.current, frequency, wave, particleRef.current,
          visualTime, audioDelta, snapshot.video, snapshot.logo?.image ?? null,
          audioStateRef.current, sound?.sampleRate ?? 48000, snapshot.duration,
          subtitlesRef.current,
          { sound, background: snapshot.background?.image ?? null, drop: dropRef.current,
            reducedMotion: reducedMotionRef.current });
      }
      if (snapshot.media && now - lastUi > 150) {
        session.pollPosition();
        lastUi = now;
      }
    };

    const unsubscribe = session.subscribe((event: MediaSessionEvent) => {
      if (event.type === "commit") {
        cancelWarm();
        responseCacheRef.current.clear();
        soundFrameRef.current = null;
        audioStateRef.current = createAudioReactiveState();
        dropRef.current = 0;
        lastAudioRef.current = 0;
        frameTimeRef.current = 0;
      } else if (event.type === "seek") {
        event.snapshot.live?.reset();
        const media = event.snapshot.media;
        const visualTime = media
          ? audibleMediaTime(media, event.snapshot.audioContext, performance.now())
          : event.time;
        const time = Math.floor(visualTime * ANALYSIS_FPS) / ANALYSIS_FPS;
        lastAudioRef.current = time;
        if (!event.snapshot.features) soundFrameRef.current = null;
        queueWarm(time, event.snapshot.generation);
      } else if (event.type === "pause") {
        event.snapshot.live?.reset();
        const pending = pendingWarmRef.current;
        if (pending?.generation === event.snapshot.generation && pending.media === event.snapshot.media) {
          queueWarm(Math.floor(event.time * ANALYSIS_FPS) / ANALYSIS_FPS, event.snapshot.generation);
        }
      }
    });

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      cancelWarm();
    };
  }, [cancelWarm, canvasRef, lockedRef, queueWarm, session]);

  useEffect(() => {
    const snapshot = session.snapshot;
    const media = snapshot?.media;
    if (!snapshot || !media) return;
    const pending = pendingWarmRef.current;
    if (!media.paused && !(pending?.generation === snapshot.generation && pending.media === media)) return;
    const requestedTime = pending?.generation === snapshot.generation && pending.media === media
      ? pending.time
      : Math.floor(media.currentTime * ANALYSIS_FPS) / ANALYSIS_FPS;
    queueWarm(requestedTime, snapshot.generation);
  }, [
    session, queueWarm,
    settings.sensitivity, settings.quietThreshold, settings.bassBoost, settings.responseStyle,
  ]);

  return { captureImage, reducedMotionRef };
}
