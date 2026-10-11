import type { LyricsProgress, LyricsPreset, LyricsResult } from "./types";

export type LyricsWorkerStart = {
  type: "start";
  jobId: number;
  preset: LyricsPreset;
  sourceId: string;
  sampleRate: number;
  durationMs: number;
  sampleCount: number;
  channelCount: number;
  retainedBytes: number;
};

export type LyricsWorkerAudioSlice = {
  type: "audio-slice";
  jobId: number;
  offset: number;
  channels: Float32Array[];
};

export type LyricsWorkerRequest = LyricsWorkerStart | LyricsWorkerAudioSlice;

export type LyricsWorkerResponse =
  | {
      type: "need-audio";
      jobId: number;
      offset: number;
      length: number;
      completed: number;
      total: number;
    }
  | { type: "progress"; jobId: number; progress: LyricsProgress }
  | { type: "result"; jobId: number; result: LyricsResult }
  | { type: "error"; jobId: number; message: string; fatal?: boolean };
