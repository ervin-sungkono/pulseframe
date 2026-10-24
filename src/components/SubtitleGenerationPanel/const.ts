import type { LyricsStage } from "@/lib/lyrics/types";

export const stageLabels: Record<LyricsStage, string> = {
  prepare: "Prepare audio",
  download: "Load local models",
  isolate: "Isolate vocals",
  send: "Send audio",
  transcribe: "Transcribe lyrics",
  format: "Format subtitles",
};
