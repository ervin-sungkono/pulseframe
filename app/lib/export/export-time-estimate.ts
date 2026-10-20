import type { VisualSettings } from "../visual/visual-settings-model";
import { COMPRESSED_VIDEO_QUALITY } from "./export-settings";

/**
 * Browser-local, deliberately coarse export timing estimates. This stores only
 * the workload shape and timing of successful exports, never media metadata.
 */
export const EXPORT_TIMING_SCHEMA_VERSION = 1 as const;
export const EXPORT_TIMING_PIPELINE_VERSION = "wasm-auto-canvas-v1" as const;
export const EXPORT_TIMING_STORAGE_KEY = "pulseframe.export-timing.v1";
export const EXPORT_TIMING_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
export const EXPORT_TIMING_MAX_RECORDS = 20;

export type ExportSourceKind = "audio" | "video";
export type ExportCodec = "avc" | "vp9" | "vp8";

/** Coarse renderer workload fields; excludes titles, colors, and asset names. */
export type ExportWorkload = {
  /** Coarse render span, so short runs cannot train long-run finishing costs. */
  durationBucket: string;
  /** Prepared sources have no export-time decode; fallback decode span is bucketed. */
  analysisBucket: string;
  mode: string;
  ringLayers: number;
  spectrumReflectionTier: "off" | "low" | "medium" | "high";
  glowTier: "off" | "low" | "medium" | "high";
  particleMode: string;
  particleTier: "off" | "low" | "medium" | "high";
  trails: boolean;
  backdrop: string;
  beatEffects: boolean;
  glitch: boolean;
  dropEffects: boolean;
  subtitles: boolean;
  logo: boolean;
  background: boolean;
  videoOverlay: boolean;
  trackInfo: boolean;
  reducedMotion: boolean;
};

/** Exact, non-identifying settings needed before the actual codec is known. */
export type ExportTimingProfileBase = {
  pipelineVersion: typeof EXPORT_TIMING_PIPELINE_VERSION;
  width: number;
  height: number;
  frameRate: number;
  videoCompression: boolean;
  videoQuality: number;
  sourceKind: ExportSourceKind;
  preparedAudio: boolean;
  workload: ExportWorkload;
};

/** Actual encoder configuration discovered during export. */
export type ExportTimingProfile = ExportTimingProfileBase & {
  codec: ExportCodec;
  audioIncluded: boolean;
};

export type ExportTimingMeasurement = {
  profile: ExportTimingProfile;
  frameCount: number;
  preparationMs: number;
  renderingMs: number;
  finalizationMs: number;
  totalMs: number;
};

export type TimeRange = { minSeconds: number; maxSeconds: number };
export type RemainingEstimate = { range: TimeRange; scope: "file" | "rendering" };

export type TimingStorage = Pick<Storage, "getItem" | "setItem">;

type StoredRecord = ExportTimingMeasurement & { completedAt: number };
type StoredHistory = {
  schemaVersion: typeof EXPORT_TIMING_SCHEMA_VERSION;
  pipelineVersion: typeof EXPORT_TIMING_PIPELINE_VERSION;
  records: StoredRecord[];
};

const monotonicNow = () => {
  try {
    if (typeof performance !== "undefined" && Number.isFinite(performance.now()))
      return performance.now();
  } catch {
    /* Fall back where performance is unavailable. */
  }
  return Date.now();
};
const DEFAULT_NOW = () => Date.now();

function browserStorage(): TimingStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 64;
}

function validWorkload(value: unknown): value is ExportWorkload {
  if (!value || typeof value !== "object") return false;
  const workload = value as Record<string, unknown>;
  return (
    isText(workload.durationBucket) &&
    isText(workload.analysisBucket) &&
    isText(workload.mode) &&
    Number.isInteger(workload.ringLayers) &&
    Number(workload.ringLayers) >= 0 &&
    Number(workload.ringLayers) <= 4 &&
    ["off", "low", "medium", "high"].includes(String(workload.spectrumReflectionTier)) &&
    ["off", "low", "medium", "high"].includes(String(workload.glowTier)) &&
    isText(workload.particleMode) &&
    ["off", "low", "medium", "high"].includes(String(workload.particleTier)) &&
    isBoolean(workload.trails) &&
    isText(workload.backdrop) &&
    isBoolean(workload.beatEffects) &&
    isBoolean(workload.glitch) &&
    isBoolean(workload.dropEffects) &&
    isBoolean(workload.subtitles) &&
    isBoolean(workload.logo) &&
    isBoolean(workload.background) &&
    isBoolean(workload.videoOverlay) &&
    isBoolean(workload.trackInfo) &&
    isBoolean(workload.reducedMotion)
  );
}

export function isValidTimingProfile(value: unknown): value is ExportTimingProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.pipelineVersion === EXPORT_TIMING_PIPELINE_VERSION &&
    finiteNonnegative(profile.width) &&
    profile.width > 0 &&
    finiteNonnegative(profile.height) &&
    profile.height > 0 &&
    finiteNonnegative(profile.frameRate) &&
    profile.frameRate > 0 &&
    isBoolean(profile.videoCompression) &&
    finiteNonnegative(profile.videoQuality) &&
    profile.videoQuality > 0 &&
    profile.videoQuality <= 1 &&
    (profile.sourceKind === "audio" || profile.sourceKind === "video") &&
    isBoolean(profile.preparedAudio) &&
    (profile.codec === "avc" || profile.codec === "vp9" || profile.codec === "vp8") &&
    isBoolean(profile.audioIncluded) &&
    validWorkload(profile.workload)
  );
}

function validMeasurement(value: unknown): value is ExportTimingMeasurement {
  if (!value || typeof value !== "object") return false;
  const measurement = value as Record<string, unknown>;
  return (
    isValidTimingProfile(measurement.profile) &&
    Number.isInteger(measurement.frameCount) &&
    Number(measurement.frameCount) > 0 &&
    finiteNonnegative(measurement.preparationMs) &&
    finiteNonnegative(measurement.renderingMs) &&
    measurement.renderingMs > 0 &&
    finiteNonnegative(measurement.finalizationMs) &&
    finiteNonnegative(measurement.totalMs) &&
    measurement.totalMs > 0
  );
}

function validRecord(value: unknown): value is StoredRecord {
  return validMeasurement(value) && finiteNonnegative((value as StoredRecord).completedAt);
}

function readRecords(storage: TimingStorage | null, now: number): StoredRecord[] {
  if (!storage || !finiteNonnegative(now)) return [];
  try {
    const serialized = storage.getItem(EXPORT_TIMING_STORAGE_KEY);
    if (!serialized) return [];
    const parsed = JSON.parse(serialized) as Partial<StoredHistory>;
    if (
      parsed.schemaVersion !== EXPORT_TIMING_SCHEMA_VERSION ||
      parsed.pipelineVersion !== EXPORT_TIMING_PIPELINE_VERSION ||
      !Array.isArray(parsed.records)
    )
      return [];
    return parsed.records
      .filter(validRecord)
      .filter(
        (record) =>
          record.completedAt <= now && now - record.completedAt <= EXPORT_TIMING_MAX_AGE_MS,
      )
      .slice(-EXPORT_TIMING_MAX_RECORDS);
  } catch {
    return [];
  }
}

function getProfileStorageKey(profile: ExportTimingProfile) {
  return JSON.stringify(profile);
}

function getBaseStorageKey(profile: ExportTimingProfile) {
  const base = { ...profile } as Partial<ExportTimingProfile>;
  delete base.codec;
  delete base.audioIncluded;
  return JSON.stringify(base);
}

function median(values: number[]) {
  const ordered = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!ordered.length) return null;
  const center = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[center] : (ordered[center - 1] + ordered[center]) / 2;
}

function profileSummary(records: StoredRecord[]) {
  const recent = records.slice(-5);
  if (!recent.length) return null;
  const secondsPerFrame = median(
    recent.map((record) => record.renderingMs / record.frameCount / 1000),
  );
  const preparationSeconds = median(recent.map((record) => record.preparationMs / 1000));
  const finalizationSeconds = median(recent.map((record) => record.finalizationMs / 1000));
  if (
    secondsPerFrame === null ||
    !(secondsPerFrame > 0) ||
    preparationSeconds === null ||
    finalizationSeconds === null
  )
    return null;
  return { secondsPerFrame, preparationSeconds, finalizationSeconds };
}

function rangeAround(seconds: number, lowerFactor = 0.75, upperFactor = 1.4): TimeRange | null {
  if (!finiteNonnegative(seconds) || seconds <= 0) return null;
  const minSeconds = Math.max(1, seconds * lowerFactor);
  const maxSeconds = Math.max(minSeconds + 1, seconds * upperFactor);
  return Number.isFinite(minSeconds) && Number.isFinite(maxSeconds)
    ? { minSeconds, maxSeconds }
    : null;
}

function exactRecords(profile: ExportTimingProfile, storage: TimingStorage | null, now: number) {
  const key = getProfileStorageKey(profile);
  return readRecords(storage, now).filter((record) => getProfileStorageKey(record.profile) === key);
}

/** A previous-run estimate for an exact profile, including separate end phases. */
export function getHistoricalProfileEstimate(
  profile: ExportTimingProfile,
  frameCount: number,
  storage: TimingStorage | null = browserStorage(),
  now = DEFAULT_NOW(),
) {
  if (!isValidTimingProfile(profile) || !Number.isInteger(frameCount) || frameCount <= 0)
    return null;
  const summary = profileSummary(exactRecords(profile, storage, now));
  if (!summary) return null;
  const totalSeconds =
    summary.preparationSeconds + summary.secondsPerFrame * frameCount + summary.finalizationSeconds;
  const totalRange = rangeAround(totalSeconds);
  const finalizationRange =
    summary.finalizationSeconds > 0 ? rangeAround(summary.finalizationSeconds, 0.7, 1.5) : null;
  if (!totalRange || !finalizationRange) return null;
  return { totalRange, secondsPerFrame: summary.secondsPerFrame, finalizationRange };
}

/**
 * Resolve unknown pre-export codec/audio choices only when successful history
 * contains one unambiguous actual profile for all known workload settings.
 */
export function getPreExportEstimate(
  base: ExportTimingProfileBase,
  frameCount: number,
  storage: TimingStorage | null = browserStorage(),
  now = DEFAULT_NOW(),
): TimeRange | null {
  if (!isValidBaseProfile(base) || !Number.isInteger(frameCount) || frameCount <= 0) return null;
  const candidates = readRecords(storage, now).filter(
    (record) => getBaseStorageKey(record.profile) === JSON.stringify(base),
  );
  const uniqueProfiles = new Map<string, ExportTimingProfile>();
  for (const record of candidates)
    uniqueProfiles.set(getProfileStorageKey(record.profile), record.profile);
  if (uniqueProfiles.size !== 1) return null;
  return (
    getHistoricalProfileEstimate([...uniqueProfiles.values()][0], frameCount, storage, now)
      ?.totalRange ?? null
  );
}

function isValidBaseProfile(value: unknown): value is ExportTimingProfileBase {
  if (!value || typeof value !== "object") return false;
  const base = value as Record<string, unknown>;
  return (
    base.pipelineVersion === EXPORT_TIMING_PIPELINE_VERSION &&
    finiteNonnegative(base.width) &&
    base.width > 0 &&
    finiteNonnegative(base.height) &&
    base.height > 0 &&
    finiteNonnegative(base.frameRate) &&
    base.frameRate > 0 &&
    isBoolean(base.videoCompression) &&
    finiteNonnegative(base.videoQuality) &&
    base.videoQuality > 0 &&
    base.videoQuality <= 1 &&
    (base.sourceKind === "audio" || base.sourceKind === "video") &&
    isBoolean(base.preparedAudio) &&
    validWorkload(base.workload)
  );
}

/** Storage is best effort: private browsing and quota errors cannot fail export. */
export function recordSuccessfulExport(
  measurement: ExportTimingMeasurement,
  storage: TimingStorage | null = browserStorage(),
  now = DEFAULT_NOW(),
) {
  if (!storage || !validMeasurement(measurement) || !finiteNonnegative(now)) return false;
  try {
    const records = readRecords(storage, now);
    records.push({ ...measurement, completedAt: now });
    const bounded = records.slice(-EXPORT_TIMING_MAX_RECORDS);
    storage.setItem(
      EXPORT_TIMING_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: EXPORT_TIMING_SCHEMA_VERSION,
        pipelineVersion: EXPORT_TIMING_PIPELINE_VERSION,
        records: bounded,
      } satisfies StoredHistory),
    );
    return true;
  } catch {
    return false;
  }
}

/** Frame-throughput estimate fed only by completed encoder submissions. */
export class LiveFrameEstimator {
  private priorFrames = 0;
  private priorElapsedMs = 0;
  private validSamples = 0;
  private validElapsedMs = 0;
  private secondsPerFrame: number | null = null;

  observe(completedFrames: number, frameLoopElapsedMs: number) {
    if (
      !Number.isInteger(completedFrames) ||
      completedFrames <= 0 ||
      !finiteNonnegative(frameLoopElapsedMs)
    )
      return;
    if (completedFrames < this.priorFrames || frameLoopElapsedMs < this.priorElapsedMs) return;
    const frameDelta = completedFrames - this.priorFrames;
    const elapsedDeltaMs = frameLoopElapsedMs - this.priorElapsedMs;
    if (frameDelta <= 0 || elapsedDeltaMs <= 0) return;
    const sample = elapsedDeltaMs / 1000 / frameDelta;
    if (!Number.isFinite(sample) || sample <= 0) return;

    if (this.secondsPerFrame === null) this.secondsPerFrame = sample;
    else {
      // Limit one noisy window while still following sustained slowdown quickly.
      const bounded = Math.min(
        this.secondsPerFrame * 2,
        Math.max(this.secondsPerFrame * 0.5, sample),
      );
      this.secondsPerFrame = this.secondsPerFrame * 0.65 + bounded * 0.35;
    }
    this.priorFrames = completedFrames;
    this.priorElapsedMs = frameLoopElapsedMs;
    this.validSamples++;
    this.validElapsedMs += elapsedDeltaMs;
  }

  get warmedUp() {
    return this.validSamples >= 3 && this.validElapsedMs >= 1000 && this.secondsPerFrame !== null;
  }

  get rate() {
    return this.warmedUp ? this.secondsPerFrame : null;
  }

  remaining(
    totalFrames: number,
    completedFrames: number,
    finalizationRange: TimeRange | null = null,
  ): RemainingEstimate | null {
    if (
      !this.warmedUp ||
      !Number.isInteger(totalFrames) ||
      totalFrames <= 0 ||
      !Number.isInteger(completedFrames) ||
      completedFrames < 0 ||
      completedFrames > totalFrames ||
      this.secondsPerFrame === null
    )
      return null;
    const framesLeft = totalFrames - completedFrames;
    if (framesLeft <= 0) return null;
    const center = framesLeft * this.secondsPerFrame;
    if (!Number.isFinite(center) || center <= 0) return null;
    const renderRange = {
      minSeconds: Math.max(1, center * 0.8),
      maxSeconds: Math.max(2, center * 1.35),
    };
    if (
      !finalizationRange ||
      !finiteNonnegative(finalizationRange.minSeconds) ||
      !finiteNonnegative(finalizationRange.maxSeconds) ||
      finalizationRange.maxSeconds < finalizationRange.minSeconds
    ) {
      return { range: renderRange, scope: "rendering" };
    }
    return {
      range: {
        minSeconds: renderRange.minSeconds + finalizationRange.minSeconds,
        maxSeconds: renderRange.maxSeconds + finalizationRange.maxSeconds,
      },
      scope: "file",
    };
  }
}

/** Track actual phase durations from click (including lazy import) to ready Blob. */
export class ExportRunClock {
  private activePhase: "Preparing media" | "Rendering frames" | "Finishing file" =
    "Preparing media";
  private phaseStartedAt: number;
  private durations = { preparationMs: 0, renderingMs: 0, finalizationMs: 0 };

  private readonly startedAt: number;

  constructor(
    startedAt: number,
    private readonly now: () => number = monotonicNow,
  ) {
    const current = this.now();
    this.startedAt = Number.isFinite(startedAt)
      ? startedAt
      : Number.isFinite(current)
        ? current
        : Date.now();
    // The job start comes before lazy module loading, so preparation includes it.
    this.phaseStartedAt = this.startedAt;
  }

  private safeNow() {
    const value = this.now();
    return Number.isFinite(value) ? value : (this.phaseStartedAt ?? this.startedAt);
  }

  setPhase(phase: "Preparing media" | "Rendering frames" | "Finishing file") {
    const at = this.safeNow();
    this.closePhase(at);
    this.activePhase = phase;
    this.phaseStartedAt = at;
  }

  private closePhase(at: number) {
    const elapsed = at - this.phaseStartedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) return;
    const key =
      this.activePhase === "Preparing media"
        ? "preparationMs"
        : this.activePhase === "Rendering frames"
          ? "renderingMs"
          : "finalizationMs";
    this.durations[key] += elapsed;
  }

  snapshot() {
    const at = this.safeNow();
    return {
      phase: this.activePhase,
      elapsedMs: Math.max(0, at - this.startedAt),
      phaseElapsedMs: Math.max(0, at - this.phaseStartedAt),
    };
  }

  complete() {
    const at = this.safeNow();
    this.closePhase(at);
    return {
      preparationMs: Math.max(0, this.durations.preparationMs),
      renderingMs: Math.max(0, this.durations.renderingMs),
      finalizationMs: Math.max(0, this.durations.finalizationMs),
      totalMs: Math.max(0, at - this.startedAt),
    };
  }
}

/** Coarse settings signature used by the pre-export history lookup. */
export function makeExportWorkload(input: {
  durationSeconds: number;
  analysisSeconds: number;
  preparedAudio: boolean;
  mode: string;
  ringLayers: number;
  spectrumReflection: number;
  glow: number;
  particleMode: string;
  particleCount: number;
  particles: boolean;
  trails: boolean;
  backdrop: string;
  beatEffects: boolean;
  glitch: boolean;
  dropEffects: boolean;
  subtitles: boolean;
  logo: boolean;
  background: boolean;
  videoOverlay: boolean;
  trackInfo: boolean;
  reducedMotion: boolean;
}): ExportWorkload {
  const count = Number.isFinite(input.particleCount) ? Math.max(0, input.particleCount) : 0;
  const particleTier: ExportWorkload["particleTier"] =
    !input.particles || count === 0
      ? "off"
      : count <= 100
        ? "low"
        : count <= 200
          ? "medium"
          : "high";
  const glow = Number.isFinite(input.glow) ? Math.max(0, input.glow) : 0;
  const reflection = Number.isFinite(input.spectrumReflection)
    ? Math.max(0, input.spectrumReflection)
    : 0;
  return {
    durationBucket: timingDurationBucket(input.durationSeconds),
    analysisBucket: input.preparedAudio ? "prepared" : timingDurationBucket(input.analysisSeconds),
    mode: input.mode,
    ringLayers:
      input.mode === "ring" && Number.isInteger(input.ringLayers)
        ? Math.max(1, Math.min(4, input.ringLayers))
        : 0,
    spectrumReflectionTier:
      input.mode !== "spectrum" || reflection === 0
        ? "off"
        : reflection <= 33
          ? "low"
          : reflection <= 66
            ? "medium"
            : "high",
    glowTier: glow === 0 ? "off" : glow <= 0.75 ? "low" : glow <= 1.5 ? "medium" : "high",
    particleMode: input.particleMode,
    particleTier,
    trails: Boolean(input.trails),
    backdrop: input.backdrop,
    beatEffects: Boolean(input.beatEffects),
    glitch: Boolean(input.glitch),
    dropEffects: Boolean(input.dropEffects),
    subtitles: Boolean(input.subtitles),
    logo: Boolean(input.logo),
    background: Boolean(input.background),
    videoOverlay: Boolean(input.videoOverlay),
    trackInfo: Boolean(input.trackInfo),
    reducedMotion: Boolean(input.reducedMotion),
  };
}

/** Logarithmic buckets restrict historical setup/finalization reuse by span. */
export function timingDurationBucket(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  return `d${Math.floor(Math.log(seconds) / Math.log(1.5))}`;
}

export function makeExportTimingProfileBase(input: {
  width: number;
  height: number;
  frameRate: number;
  videoCompression: boolean;
  sourceKind: ExportSourceKind;
  preparedAudio: boolean;
  workload: ExportWorkload;
}): ExportTimingProfileBase {
  return {
    pipelineVersion: EXPORT_TIMING_PIPELINE_VERSION,
    width: input.width,
    height: input.height,
    frameRate: input.frameRate,
    videoCompression: input.videoCompression,
    videoQuality: input.videoCompression ? COMPRESSED_VIDEO_QUALITY : 0.75,
    sourceKind: input.sourceKind,
    preparedAudio: input.preparedAudio,
    workload: input.workload,
  };
}

/** Keep pre-export and adapter workload signatures derived from one mapping. */
export function makeExportWorkloadForExport(input: {
  durationSeconds: number;
  analysisSeconds: number;
  preparedAudio: boolean;
  settings: VisualSettings;
  subtitles: boolean;
  logo: boolean;
  background: boolean;
  videoOverlay: boolean;
  reducedMotion: boolean;
}): ExportWorkload {
  const { settings } = input;
  return makeExportWorkload({
    durationSeconds: input.durationSeconds,
    analysisSeconds: input.analysisSeconds,
    preparedAudio: input.preparedAudio,
    mode: settings.mode,
    ringLayers: settings.ringLayers,
    spectrumReflection: settings.spectrumReflection,
    glow: settings.glow,
    particleMode: settings.particleMode,
    particleCount: settings.particleCount,
    particles: settings.particles,
    trails: settings.trails,
    backdrop: settings.backdrop,
    beatEffects: settings.beatRays || settings.beatLightingIntensity > 0,
    glitch: settings.glitch,
    dropEffects: settings.dropEffects,
    subtitles: input.subtitles,
    logo: input.logo,
    background: input.background,
    videoOverlay: input.videoOverlay,
    trackInfo: settings.showTrackInfo,
    reducedMotion: input.reducedMotion,
  });
}
