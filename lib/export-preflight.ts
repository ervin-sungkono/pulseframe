import {
  ALL_FORMATS,
  BlobSource,
  Input,
  Quality,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import type { ProjectTrack } from "./project-model";
import { COMPRESSED_VIDEO_QUALITY } from "./export-settings";
import { EXPORT_AUDIO_CHANNELS, EXPORT_AUDIO_SAMPLE_RATE } from "./audio-normalize";
import type { ExportFrameRate } from "./export-timeline";
import { buildPlaylistTimeline, clipProjectRange } from "./playlist-timeline";

export type ExportVideoCodec = "avc" | "vp9" | "vp8";
export type ExportAudioCodec = "aac" | "opus";
export type ExportVideoExtension = "mp4" | "webm";

export type ExportPreflightRequest = {
  file?: File;
  tracks?: readonly ProjectTrack[];
  range?: [number, number];
  width: number;
  height: number;
  frameRate: ExportFrameRate;
  videoCompression?: boolean;
  generation?: number;
};

export type ExportPreflightSegment = {
  trackId: string | null;
  file: File;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  hasAudio: boolean;
  hasVideo: boolean;
  audioDuration: number;
  sourceChannels: number;
  sourceSampleRate: number;
};

export type ExportPreflightResult = {
  key: string;
  extension: ExportVideoExtension;
  mimeType: "video/mp4" | "video/webm";
  videoCodec: ExportVideoCodec;
  audioCodec: ExportAudioCodec | null;
  audioIncluded: boolean;
  audioChannels: number;
  audioSampleRate: number;
  segments: ExportPreflightSegment[];
};

export const EXPORT_BLOB_FALLBACK_BUDGET_BYTES = 300 * 1024 * 1024;

export type BlobFallbackEstimate = {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  videoCompression?: boolean;
  audioIncluded: boolean;
};

/**
 * A conservative size estimate for the in-memory BufferTarget fallback.
 * Actual codec output varies; file-backed output skips this guard entirely.
 */
export function estimateBlobFallbackBytes(request: BlobFallbackEstimate) {
  const { durationSeconds, width, height, frameRate, videoCompression, audioIncluded } = request;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0
  )
    throw new Error("The Blob fallback size cannot be estimated from invalid export settings.");
  const bitsPerPixelFrame = videoCompression ? 0.08 : 0.25;
  const videoBytes = (durationSeconds * width * height * frameRate * bitsPerPixelFrame) / 8;
  const audioBytes = durationSeconds * (audioIncluded ? 320_000 / 8 : 0);
  return Math.ceil(videoBytes + audioBytes + 1024 * 1024);
}

export function assertBlobFallbackWithinBudget(request: BlobFallbackEstimate) {
  const estimatedBytes = estimateBlobFallbackBytes(request);
  if (estimatedBytes > EXPORT_BLOB_FALLBACK_BUDGET_BYTES) {
    const estimateMiB = Math.ceil(estimatedBytes / (1024 * 1024));
    const limitMiB = Math.floor(EXPORT_BLOB_FALLBACK_BUDGET_BYTES / (1024 * 1024));
    throw new Error(
      `This export is too large for an in-memory download (estimated ${estimateMiB} MiB; limit ${limitMiB} MiB). Use Save to file or choose a shorter range.`,
    );
  }
  return estimatedBytes;
}

type SourceInfo = Omit<
  ExportPreflightSegment,
  "trackId" | "sourceStart" | "sourceEnd" | "duration"
>;

const fileIds = new WeakMap<File, number>();
let nextFileId = 1;
const resultCache = new Map<string, ExportPreflightResult>();
const pendingCache = new Map<string, Promise<ExportPreflightResult>>();
const CACHE_LIMIT = 24;
let cacheEpoch = 0;

function fileId(file: File) {
  let id = fileIds.get(file);
  if (id === undefined) {
    id = nextFileId++;
    fileIds.set(file, id);
  }
  return id;
}

function sourceEntries(request: ExportPreflightRequest) {
  if (request.tracks?.length) {
    const activeTracks = request.tracks.filter((track) => track.range[0] !== track.range[1]);
    const allEntries = activeTracks.map((track) => {
      const [start, end] = track.range;
      if (
        !Number.isFinite(track.duration) ||
        track.duration <= 0 ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        end > track.duration + 0.001
      )
        throw new Error(`Track “${track.title || track.id}” has an invalid selected range.`);
      return {
        trackId: track.id,
        file: track.file,
        sourceStart: start,
        sourceEnd: end,
        duration: end - start,
      };
    });
    if (!request.range) return allEntries;
    const timeline = buildPlaylistTimeline([...activeTracks]);
    const [start, end] = request.range;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > timeline.duration
    )
      throw new Error("The selected export range is outside the playlist duration.");
    const clips = clipProjectRange(timeline, request.range);
    if (!clips.length)
      throw new Error("The selected export range is outside the playlist duration.");
    return clips.map((clip) => ({
      trackId: clip.trackId,
      file: clip.track.file,
      sourceStart: clip.sourceRange[0],
      sourceEnd: clip.sourceRange[1],
      duration: clip.sourceRange[1] - clip.sourceRange[0],
    }));
  }
  if (!request.file) throw new Error("No media file is available for export.");
  return [
    { trackId: null, file: request.file, sourceStart: 0, sourceEnd: Infinity, duration: Infinity },
  ];
}

function cacheKey(request: ExportPreflightRequest) {
  const entries = sourceEntries(request);
  return JSON.stringify({
    generation: request.generation ?? null,
    entries: entries.map((entry) => [
      fileId(entry.file),
      entry.file.size,
      entry.file.lastModified,
      entry.trackId,
      entry.sourceStart,
      entry.sourceEnd,
    ]),
    range: request.range ?? null,
    width: request.width,
    height: request.height,
    frameRate: request.frameRate,
    videoCompression: !!request.videoCompression,
    playlist: !!request.tracks?.length,
  });
}

async function inspectFile(file: File): Promise<SourceInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const [audioTrack, videoTrack] = await Promise.all([
      input.getPrimaryAudioTrack(),
      input.getPrimaryVideoTrack(),
    ]);
    if (audioTrack && !(await audioTrack.canDecode()))
      throw new Error(
        "The sound in one track cannot be decoded on this device. Try MP3, WAV, MP4, or WebM.",
      );
    if (videoTrack && !(await videoTrack.canDecode()))
      throw new Error("The video in one track cannot be decoded on this device.");
    const channels = audioTrack ? await audioTrack.getNumberOfChannels() : 0;
    const sampleRate = audioTrack ? await audioTrack.getSampleRate() : EXPORT_AUDIO_SAMPLE_RATE;
    const audioDuration = audioTrack ? await audioTrack.computeDuration() : 0;
    if (audioTrack && (channels < 1 || channels > 2))
      throw new Error(
        "Export needs mono or stereo audio tracks. Surround-sound tracks are not supported.",
      );
    return {
      file,
      hasAudio: !!audioTrack,
      hasVideo: !!videoTrack,
      audioDuration: Number.isFinite(audioDuration) ? Math.max(0, audioDuration) : 0,
      sourceChannels: channels,
      sourceSampleRate: sampleRate,
    };
  } finally {
    input.dispose();
  }
}

function validatedDimensions(width: number, height: number, frameRate: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width % 2 !== 0 ||
    height % 2 !== 0 ||
    !Number.isFinite(frameRate) ||
    frameRate <= 0
  )
    throw new Error("The selected video dimensions or frame rate are invalid.");
}

async function chooseCodecs(
  request: ExportPreflightRequest,
  segments: ExportPreflightSegment[],
): Promise<Omit<ExportPreflightResult, "key" | "segments">> {
  validatedDimensions(request.width, request.height, request.frameRate);
  if (typeof VideoEncoder === "undefined")
    throw new Error("Fast video export needs WebCodecs. Try an up-to-date browser.");
  const audioIncluded = segments.some((segment) => segment.hasAudio);
  const audioChannels = request.tracks?.length
    ? EXPORT_AUDIO_CHANNELS
    : (segments[0]?.sourceChannels ?? 0);
  const audioSampleRate = request.tracks?.length
    ? EXPORT_AUDIO_SAMPLE_RATE
    : (segments[0]?.sourceSampleRate ?? EXPORT_AUDIO_SAMPLE_RATE);
  const quality = new Quality(request.videoCompression ? COMPRESSED_VIDEO_QUALITY : "high");
  const audioQuality = new Quality("high");
  const avc = await canEncodeVideo("avc", {
    width: request.width,
    height: request.height,
    frameRate: request.frameRate,
    quality,
  });
  const aac =
    !audioIncluded ||
    (await canEncodeAudio("aac", {
      numberOfChannels: audioChannels,
      sampleRate: audioSampleRate,
      quality: audioQuality,
    }));
  if (avc && aac) {
    return {
      extension: "mp4",
      mimeType: "video/mp4",
      videoCodec: "avc",
      audioCodec: audioIncluded ? "aac" : null,
      audioIncluded,
      audioChannels,
      audioSampleRate,
    };
  }

  const webmAudioChannels =
    audioIncluded && request.tracks?.length ? EXPORT_AUDIO_CHANNELS : audioChannels;
  const opus =
    !audioIncluded ||
    (await canEncodeAudio("opus", {
      numberOfChannels: webmAudioChannels,
      sampleRate: EXPORT_AUDIO_SAMPLE_RATE,
      quality: audioQuality,
    }));
  const videoCodec: ExportVideoCodec | null = (await canEncodeVideo("vp9", {
    width: request.width,
    height: request.height,
    frameRate: request.frameRate,
    quality,
  }))
    ? "vp9"
    : (await canEncodeVideo("vp8", {
          width: request.width,
          height: request.height,
          frameRate: request.frameRate,
          quality,
        }))
      ? "vp8"
      : null;
  if (!videoCodec || !opus)
    throw new Error("This device has no compatible fast video and audio encoder for MP4 or WebM.");
  return {
    extension: "webm",
    mimeType: "video/webm",
    videoCodec,
    audioCodec: audioIncluded ? "opus" : null,
    audioIncluded,
    audioChannels: webmAudioChannels,
    audioSampleRate: EXPORT_AUDIO_SAMPLE_RATE,
  };
}

async function runPreflight(request: ExportPreflightRequest, key: string) {
  const entries = sourceEntries(request);
  if (!entries.length) throw new Error("No playlist segments overlap the selected export range.");
  const sources: SourceInfo[] = [];
  for (const entry of entries) sources.push(await inspectFile(entry.file));
  const segments = entries.map((entry, index): ExportPreflightSegment => ({
    ...entry,
    ...sources[index],
  }));
  const codec = await chooseCodecs(request, segments);
  return { key, ...codec, segments } satisfies ExportPreflightResult;
}

function remember(key: string, value: ExportPreflightResult) {
  resultCache.delete(key);
  resultCache.set(key, value);
  while (resultCache.size > CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** Lightweight decoder/encoder capability check. A ready result is not a promise that a long encode will finish. */
export async function preflightExport(
  request: ExportPreflightRequest,
): Promise<ExportPreflightResult> {
  const key = cacheKey(request);
  const existing = resultCache.get(key);
  if (existing) return existing;
  const pending = pendingCache.get(key);
  if (pending) return pending;
  const epoch = cacheEpoch;
  const task = runPreflight(request, key)
    .then((result) => {
      if (epoch === cacheEpoch) remember(key, result);
      return result;
    })
    .finally(() => {
      if (pendingCache.get(key) === task) pendingCache.delete(key);
    });
  pendingCache.set(key, task);
  return task;
}

export function getCachedExportPreflight(
  request: ExportPreflightRequest,
): ExportPreflightResult | null {
  try {
    return resultCache.get(cacheKey(request)) ?? null;
  } catch {
    return null;
  }
}

/** Synchronous picker helper; run `preflightExport` before the click if uncached. */
export function getExportExtension(request: ExportPreflightRequest): ExportVideoExtension | null {
  return getCachedExportPreflight(request)?.extension ?? null;
}

export function invalidateExportPreflight(generation?: number) {
  cacheEpoch++;
  if (generation === undefined) {
    resultCache.clear();
    pendingCache.clear();
    return;
  }
  const marker = `"generation":${generation},`;
  for (const key of resultCache.keys()) if (key.includes(marker)) resultCache.delete(key);
  for (const key of pendingCache.keys()) if (key.includes(marker)) pendingCache.delete(key);
}
