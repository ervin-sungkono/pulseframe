import type { PreparedSound } from "@/lib/audio/audio-features";

export type TrackWaveformProps = {
  overview: PreparedSound["overview"];
  position: number;
  duration: number;
  audioDuration: number;
  onSeek: (time: number) => void;
  disabled: boolean;
};
