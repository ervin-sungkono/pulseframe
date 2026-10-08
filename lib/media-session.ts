import { prepareSound, type PreparedSound } from "./audio-features";
import { initializeDsp } from "./dsp/loader";
import { PcmFeatures } from "./pcm-features";
import { LiveSound } from "./live-sound";
import { readLocalImage, type LocalImage } from "./local-image";
import type { ProjectContent } from "./project-file";

export type MediaAssetKind = "logo" | "background";
export type MediaSessionOperation = "load" | "play" | "preview" | "logo" | "background";

export type MediaSessionSnapshot = {
  file: File | null;
  media: HTMLMediaElement | null;
  video: HTMLVideoElement | null;
  sound: PreparedSound | null;
  features: PcmFeatures | null;
  live: LiveSound | null;
  duration: number;
  generation: number;
  logo: LocalImage | null;
  background: LocalImage | null;
  audioContext: AudioContext | null;
  source: MediaElementAudioSourceNode | null;
  playing: boolean;
};

export type MediaSessionEvent =
  | { type: "loading"; loading: boolean; requestGeneration: number }
  | { type: "commit"; snapshot: MediaSessionSnapshot; next: File; project?: ProjectContent; range: [number, number] }
  | { type: "seek"; snapshot: MediaSessionSnapshot; time: number; source: "api" | "native" }
  | { type: "play" | "pause" | "ended"; snapshot: MediaSessionSnapshot; time: number }
  | { type: "position"; snapshot: MediaSessionSnapshot; time: number }
  | { type: "assets"; snapshot: MediaSessionSnapshot; kind: MediaAssetKind; asset: LocalImage | null }
  | { type: "error"; operation: MediaSessionOperation; error: Error }
  | { type: "notice"; message: string };

export type MediaSessionAssetFiles = { logo: File | null; background: File | null };
export type MediaSessionLoadOptions = {
  range?: [number, number];
  project?: ProjectContent;
  projectAssets?: MediaSessionAssetFiles;
};

export type MediaSessionDependencies = {
  createMediaElement?: (video: boolean) => HTMLMediaElement;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  readImage?: (file: File, kind: MediaAssetKind) => Promise<LocalImage>;
  prepareAudio?: (file: File, signal: AbortSignal) => Promise<PreparedSound | null>;
  createAudioContext?: () => AudioContext;
  createSource?: (context: AudioContext, element: HTMLMediaElement) => MediaElementAudioSourceNode;
  createMonitor?: (context: AudioContext) => GainNode;
  createLiveSound?: (context: AudioContext, source: MediaElementAudioSourceNode) => LiveSound;
  isBlocked?: () => boolean;
  getMediaHost?: () => HTMLElement | null;
  onEvent?: (event: MediaSessionEvent) => void;
};

type MediaResource = {
  file: File;
  media: HTMLMediaElement;
  video: HTMLVideoElement | null;
  sound: PreparedSound | null;
  features: PcmFeatures | null;
  live: LiveSound | null;
  duration: number;
  source: MediaElementAudioSourceNode;
  url: string;
};

const abortError = () => new DOMException("Canceled", "AbortError");
const asError = (value: unknown, fallback: string) => value instanceof Error ? value : new Error(fallback);

function isMediaFile(file: File) {
  const video = file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
  const audio = file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name);
  return { video, valid: (audio || video) && file.size > 0 };
}

function waitForMediaData(element: HTMLMediaElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const cleanup = () => {
      element.removeEventListener("loadeddata", loaded);
      element.removeEventListener("error", failed);
      signal.removeEventListener("abort", canceled);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("This browser could not open the media. Try MP3, WAV, MP4, or WebM.")); };
    const canceled = () => { cleanup(); reject(abortError()); };
    element.addEventListener("loadeddata", loaded, { once: true });
    element.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", canceled, { once: true });
  });
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const canceled = () => reject(abortError());
    signal.addEventListener("abort", canceled, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", canceled));
  });
}

/** Owns every browser resource associated with one loaded project and its assets. */
export class MediaSessionOwner {
  private media: MediaResource | null = null;
  private logo: LocalImage | null = null;
  private background: LocalImage | null = null;
  private context: AudioContext | null = null;
  private monitor: GainNode | null = null;
  private generationValue = 0;
  private requestValue = 0;
  private transportRequest = 0;
  private activeLoad: AbortController | null = null;
  private disposed = false;
  private volume = 0.7;
  private looping = false;
  private segmentEnd: number | null = null;
  private lastPositionEvent = 0;
  private logoRequest = 0;
  private backgroundRequest = 0;
  private listeners = new Set<(event: MediaSessionEvent) => void>();

  constructor(private readonly dependencies: MediaSessionDependencies = {}) {}

  get requestGeneration() { return this.requestValue; }
  get generation() { return this.generationValue; }
  get logoAsset() { return this.logo; }
  get backgroundAsset() { return this.background; }
  get audioContext() { return this.context; }

  get snapshot(): MediaSessionSnapshot {
    return {
      file: this.media?.file ?? null,
      media: this.media?.media ?? null,
      video: this.media?.video ?? null,
      sound: this.media?.sound ?? null,
      features: this.media?.features ?? null,
      live: this.media?.live ?? null,
      duration: this.media?.duration ?? 0,
      generation: this.generationValue,
      logo: this.logo,
      background: this.background,
      audioContext: this.context,
      source: this.media?.source ?? null,
      playing: !!this.media && !this.media.media.paused && !this.media.media.ended,
    };
  }

  subscribe(listener: (event: MediaSessionEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: MediaSessionEvent) {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* Subscribers are observers and cannot break an ownership transaction. */ }
    }
    try { this.dependencies.onEvent?.(event); } catch { /* See above. */ }
  }

  private blocked() { return this.disposed || !!this.dependencies.isBlocked?.(); }
  private objectUrl(blob: Blob) { return (this.dependencies.createObjectURL ?? URL.createObjectURL.bind(URL))(blob); }
  private revoke(url: string | null | undefined) { if (url) (this.dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL))(url); }
  private readImage(file: File, kind: MediaAssetKind) { return (this.dependencies.readImage ?? readLocalImage)(file, kind); }

  private revokeAsset(asset: LocalImage | null) { if (asset) this.revoke(asset.url); }

  private async prepareAudio(file: File, signal: AbortSignal): Promise<PreparedSound | null> {
    try {
      if (this.dependencies.prepareAudio) return await this.dependencies.prepareAudio(file, signal);
      const { decodeMediaAudio } = await import("./media-audio");
      return await prepareSound(await decodeMediaAudio(file, signal), signal);
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      // Native playback and live analysis remain available if PCM decoding fails.
      return null;
    }
  }

  private ensureAudioGraph(): { context: AudioContext; monitor: GainNode } {
    if (!this.context) {
      this.context = this.dependencies.createAudioContext?.() ?? new AudioContext();
    }
    if (!this.monitor) {
      this.monitor = this.dependencies.createMonitor?.(this.context) ?? this.context.createGain();
      this.monitor.connect(this.context.destination);
    }
    const gain = this.monitor.gain;
    if (this.context.currentTime !== undefined && typeof gain.setValueAtTime === "function") {
      gain.setValueAtTime(this.volume, this.context.currentTime);
    } else gain.value = this.volume;
    return { context: this.context, monitor: this.monitor };
  }

  private attachMediaHandlers(resource: MediaResource, generation: number) {
    const { media } = resource;
    const current = () => this.media === resource && this.generationValue === generation;
    media.addEventListener("play", () => { if (current()) this.emit({ type: "play", snapshot: this.snapshot, time: media.currentTime || 0 }); });
    media.addEventListener("pause", () => {
      if (!current()) return;
      resource.live?.reset();
      this.emit({ type: "pause", snapshot: this.snapshot, time: media.currentTime || 0 });
    });
    media.addEventListener("ended", () => {
      if (!current()) return;
      this.segmentEnd = null;
      this.emit({ type: "ended", snapshot: this.snapshot, time: media.currentTime || 0 });
    });
    media.addEventListener("seeking", () => {
      if (!current()) return;
      resource.live?.reset();
      this.emit({ type: "seek", snapshot: this.snapshot, time: media.currentTime || 0, source: "native" });
    });
    const stopAtSegmentEnd = () => {
      if (!current() || this.segmentEnd === null || media.currentTime < this.segmentEnd - 0.04) return;
      this.segmentEnd = null;
      media.pause();
    };
    media.addEventListener("timeupdate", stopAtSegmentEnd);
    media.addEventListener("error", () => {
      if (current()) this.emit({ type: "error", operation: "load", error: new Error("Playback failed. Try another media file.") });
    });
  }

  private releaseMedia(resource: MediaResource | null) {
    if (!resource) return;
    resource.media.pause();
    resource.media.removeAttribute("src");
    resource.media.load();
    resource.media.remove();
    resource.source.disconnect();
    resource.features?.dispose();
    resource.live?.dispose();
    this.revoke(resource.url);
  }

  private updateAsset(kind: MediaAssetKind, asset: LocalImage | null, emit = true) {
    const old = kind === "logo" ? this.logo : this.background;
    if (kind === "logo") this.logo = asset;
    else this.background = asset;
    if (old !== asset) this.revokeAsset(old);
    if (emit) this.emit({ type: "assets", snapshot: this.snapshot, kind, asset });
  }

  /** Prepare media and project assets off to the side, then synchronously swap the complete snapshot. */
  async load(next: File | undefined, options: MediaSessionLoadOptions = {}): Promise<boolean> {
    if (!next || this.blocked()) return false;
    const { video, valid } = isMediaFile(next);
    if (!valid) {
      this.emit({ type: "error", operation: "load", error: new Error("Choose a nonempty audio or video file.") });
      return false;
    }

    const request = ++this.requestValue;
    this.activeLoad?.abort();
    const controller = new AbortController();
    this.activeLoad = controller;
    this.emit({ type: "loading", loading: true, requestGeneration: request });

    let element: HTMLMediaElement | null = null;
    let url: string | null = null;
    let candidateLogo: LocalImage | null = null;
    let candidateBackground: LocalImage | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let live: LiveSound | null = null;
    let features: PcmFeatures | null = null;
    let committed = false;
    const contextExistedBeforeLoad = !!this.context;
    try {
      element = (this.dependencies.createMediaElement ?? (isVideo => document.createElement(isVideo ? "video" : "audio")))(video);
      element.preload = "auto";
      if (video && "playsInline" in element) (element as HTMLVideoElement).playsInline = true;
      url = this.objectUrl(next);
      const ready = waitForMediaData(element, controller.signal);
      element.src = url;

      const projectAssets = options.projectAssets ?? (options.project ? { logo: options.project.logo, background: options.project.background } : null);
      const prepareAsset = (kind: MediaAssetKind, file: File | null) => {
        if (!file) return Promise.resolve(null);
        return this.readImage(file, kind).then(asset => {
          if (controller.signal.aborted || request !== this.requestValue || this.disposed || this.blocked()) {
            this.revokeAsset(asset);
            return null;
          }
          if (kind === "logo") candidateLogo = asset;
          else candidateBackground = asset;
          return asset;
        });
      };
      const assets = projectAssets
        ? Promise.all([prepareAsset("logo", projectAssets.logo), prepareAsset("background", projectAssets.background)])
        : Promise.resolve([null, null] as const);
      const soundWork = this.prepareAudio(next, controller.signal);
      const dspWork = initializeDsp();
      const [, , sound] = await withAbort(Promise.all([ready, assets, soundWork, dspWork]), controller.signal);
      if (request !== this.requestValue || controller.signal.aborted || this.blocked()) return false;

      const length = Number.isFinite(element.duration) ? element.duration : sound?.audio?.duration ?? 0;
      if (!(length > 0)) throw new Error("Could not determine the media duration.");
      const { context, monitor } = this.ensureAudioGraph();
      source = this.dependencies.createSource?.(context, element) ?? context.createMediaElementSource(element);
      source.connect(monitor);
      live = sound?.audio ? null : (this.dependencies.createLiveSound?.(context, source) ?? new LiveSound(context, source));
      element.loop = this.looping;

      const host = this.dependencies.getMediaHost?.();
      host?.appendChild(element);
      features = sound?.audio
        ? new PcmFeatures(Array.from({ length: sound.audio.numberOfChannels }, (_, i) => sound.audio!.getChannelData(i)), sound.audio.sampleRate)
        : null;
      const range = this.normalizeRange(options.range, length);
      const resource: MediaResource = {
        file: next, media: element, video: video ? element as HTMLVideoElement : null,
        sound, features, live, duration: length, source, url,
      };
      const previous = this.media;
      const previousLogo = this.logo, previousBackground = this.background;
      this.transportRequest++;
      this.media = resource;
      this.segmentEnd = null;
      this.generationValue++;
      this.attachMediaHandlers(resource, this.generationValue);
      if (projectAssets) {
        ++this.logoRequest; ++this.backgroundRequest;
        this.logo = candidateLogo;
        this.background = candidateBackground;
      }
      committed = true;
      this.emit({ type: "commit", snapshot: this.snapshot, next, project: options.project, range });
      this.releaseMedia(previous);
      if (projectAssets) {
        this.revokeAsset(previousLogo);
        this.revokeAsset(previousBackground);
      }
      if (!sound) this.emit({ type: "notice", message: "Playback is ready with live sound response. Export support depends on the file and this browser; choose a short section for large files." });
      return true;
    } catch (caught) {
      const error = asError(caught, "Could not open this media.");
      if (request === this.requestValue && !controller.signal.aborted && error.name !== "AbortError") {
        this.emit({ type: "error", operation: "load", error });
      }
      return false;
    } finally {
      if (!committed) {
        if (!controller.signal.aborted) controller.abort();
        element?.pause();
        element?.removeAttribute("src");
        element?.load();
        element?.remove();
        source?.disconnect();
        features?.dispose();
        live?.dispose();
        this.revoke(url);
        this.revokeAsset(candidateLogo);
        this.revokeAsset(candidateBackground);
        if (!contextExistedBeforeLoad && !this.media && this.context) {
          void this.context.close();
          this.context = null; this.monitor = null;
        }
      }
      if (request === this.requestValue) {
        this.activeLoad = null;
        this.emit({ type: "loading", loading: false, requestGeneration: request });
      }
    }
  }

  private normalizeRange(range: [number, number] | undefined, duration: number): [number, number] {
    if (!range || !(range[1] > range[0])) return [0, duration];
    const start = Math.max(0, Math.min(range[0], Math.max(0, duration - 0.1)));
    const end = Math.max(0.1, Math.min(range[1], duration));
    return end > start ? [start, end] : [0, duration];
  }

  seek(time: number) {
    this.transportRequest++;
    const resource = this.media;
    if (!resource || this.blocked()) return;
    this.segmentEnd = null;
    resource.media.currentTime = Math.max(0, Math.min(resource.duration, Number.isFinite(time) ? time : 0));
    resource.live?.reset();
    this.emit({ type: "seek", snapshot: this.snapshot, time: resource.media.currentTime || 0, source: "api" });
  }

  async play() {
    const resource = this.media;
    if (!resource || this.blocked()) return false;
    const request = ++this.transportRequest;
    try {
      this.segmentEnd = null;
      await this.context?.resume();
      if (!this.isCurrentTransport(resource, request)) return false;
      if (resource.media.ended) resource.media.currentTime = 0;
      await resource.media.play();
      return this.isCurrentTransport(resource, request);
    } catch {
      if (!this.isCurrentTransport(resource, request)) return false;
      this.emit({ type: "error", operation: "play", error: new Error("Playback was blocked. Press play again or try another file.") });
      return false;
    }
  }

  pause() {
    this.transportRequest++;
    this.segmentEnd = null;
    const resource = this.media;
    if (!resource) return;
    resource.media.pause();
  }

  async togglePlay() {
    if (this.blocked()) return false;
    const resource = this.media;
    if (!resource) return false;
    if (resource.media.paused || resource.media.ended) return this.play();
    this.pause();
    return true;
  }

  async previewRange(range: [number, number]) {
    const resource = this.media;
    if (!resource || this.blocked()) return false;
    const request = ++this.transportRequest;
    this.segmentEnd = null;
    try {
      const [start, end] = this.normalizeRange(range, resource.duration);
      resource.media.pause();
      resource.media.currentTime = start;
      resource.live?.reset();
      this.emit({ type: "seek", snapshot: this.snapshot, time: start, source: "api" });
      if (!this.isCurrentTransport(resource, request)) return false;
      await this.context?.resume();
      if (!this.isCurrentTransport(resource, request)) return false;
      this.segmentEnd = end;
      await resource.media.play();
      return this.isCurrentTransport(resource, request);
    } catch {
      if (!this.isCurrentTransport(resource, request)) return false;
      this.segmentEnd = null;
      this.emit({ type: "error", operation: "preview", error: new Error("Could not preview that section.") });
      return false;
    }
  }

  private isCurrentTransport(resource: MediaResource, request: number) {
    return this.transportRequest === request && this.media === resource && !this.blocked();
  }

  pollPosition(force = false) {
    const resource = this.media;
    if (!resource) return 0;
    const time = resource.media.currentTime || 0;
    if (this.segmentEnd !== null && time >= this.segmentEnd - 0.04) {
      this.segmentEnd = null;
      resource.media.pause();
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (force || now - this.lastPositionEvent >= 150) {
      this.lastPositionEvent = now;
      this.emit({ type: "position", snapshot: this.snapshot, time });
    }
    return time;
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    if (!this.context || !this.monitor) return;
    const gain = this.monitor.gain;
    if (typeof gain.setTargetAtTime === "function") gain.setTargetAtTime(this.volume, this.context.currentTime, 0.015);
    else gain.value = this.volume;
  }

  setLoop(looping: boolean) {
    this.looping = looping;
    if (this.media) this.media.media.loop = looping;
  }

  async changeImage(kind: MediaAssetKind, file: File | null): Promise<boolean> {
    if (this.blocked()) return false;
    const generation = kind === "logo" ? ++this.logoRequest : ++this.backgroundRequest;
    if (!file) {
      this.updateAsset(kind, null);
      return true;
    }
    try {
      const asset = await this.readImage(file, kind);
      const stillCurrent = generation === (kind === "logo" ? this.logoRequest : this.backgroundRequest);
      if (!stillCurrent || this.blocked()) { this.revokeAsset(asset); return false; }
      this.updateAsset(kind, asset);
      return true;
    } catch (caught) {
      const stillCurrent = generation === (kind === "logo" ? this.logoRequest : this.backgroundRequest);
      if (stillCurrent) this.emit({ type: "error", operation: kind, error: asError(caught, `Could not read that ${kind}.`) });
      return false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.transportRequest++;
    this.segmentEnd = null;
    this.activeLoad?.abort();
    this.activeLoad = null;
    this.requestValue++;
    this.logoRequest++; this.backgroundRequest++;
    this.releaseMedia(this.media);
    this.media = null;
    this.revokeAsset(this.logo); this.logo = null;
    this.revokeAsset(this.background); this.background = null;
    this.monitor?.disconnect(); this.monitor = null;
    if (this.context) void this.context.close();
    this.context = null;
    this.listeners.clear();
  }
}
