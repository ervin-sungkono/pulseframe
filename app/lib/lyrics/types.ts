import type { SubtitleCue } from "../subtitles.js";

export type LyricsMethod = "local" | "gemini";
export type LyricsPreset = "auto" | "fast" | "quality";
export type GeneratedCue = { startMs: number; endMs: number; text: string };
export type LyricsStage = "prepare" | "download" | "isolate" | "send" | "transcribe" | "format";
export type LyricsProgress = {
  stage: LyricsStage;
  message: string;
  completed?: number;
  total?: number;
  elapsedMs?: number;
};
export type LyricsDiagnostics = {
  model: string;
  revision?: string;
  isolation: "none" | "kim-vocal-2";
  overlap: number;
  isolationBackend?: string;
  whisperBackend?: string;
  graphCapture?: boolean;
  requestedThreads?: number;
  chunks: number;
  attempts: number;
  rechecks: number;
  timings: Record<string, number>;
  tokenUsage?: { input: number; output: number };
};
export type LyricsResult = {
  cues: GeneratedCue[];
  durationMs: number;
  method: LyricsMethod;
  preset: LyricsPreset;
  diagnostics: LyricsDiagnostics;
  notices: string[];
};
export type LyricsSource = {
  file: File;
  duration: number;
  generation: number;
  retainedAudio?: AudioBuffer | null;
};
/** Read-only media-owner PCM. Adapters transfer only their own copied slices. */
export type LyricsAudio = {
  channels: readonly Float32Array[];
  sampleRate: number;
  durationMs: number;
  retainedBytes: number;
};
export type LyricsRunOptions = {
  preset: LyricsPreset;
  languageCode?: string;
  sourceId: string;
  signal: AbortSignal;
  onProgress: (progress: LyricsProgress) => void;
};
export type LyricsAdapter = {
  generate: (audio: LyricsAudio, options: LyricsRunOptions) => Promise<LyricsResult>;
  dispose: () => void;
};
export type GeneratedApplication = {
  cues: SubtitleCue[];
  error: string | null;
};
