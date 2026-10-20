import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { ANALYSIS_FPS } from "./audio-analysis-config";
const MAX_PCM = 300 * 1024 * 1024;
export async function decodeMediaAudio(
  file: File,
  signal?: AbortSignal,
  start = 0,
  end?: number,
): Promise<AudioBuffer | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    if (!(await track.canDecode()))
      throw new Error(
        "This browser cannot read the sound in this file. Try MP3, WAV, MP4, or WebM.",
      );
    const duration = Math.max(0, Math.min(end ?? Infinity, await track.computeDuration()) - start),
      sink = new AudioBufferSink(track);
    let audio: AudioBuffer | null = null;
    for await (const item of sink.buffers(start, end)) {
      if (signal?.aborted) throw new DOMException("Canceled", "AbortError");
      if (!audio) {
        if (item.buffer.numberOfChannels > 2)
          throw new Error(
            "Export needs a mono or stereo audio track. This surround-sound file can still play with live visualization.",
          );
        const channels = Math.min(2, item.buffer.numberOfChannels);
        const length = Math.max(1, Math.ceil(duration * item.buffer.sampleRate));
        const historyBytes = Math.ceil(duration * ANALYSIS_FPS) * channels * (96 * 4 + 128);
        if (!Number.isFinite(length) || length * channels * 4 + historyBytes > MAX_PCM)
          throw new Error("Choose a shorter section to export this long media file.");
        audio = new AudioBuffer({
          length,
          sampleRate: item.buffer.sampleRate,
          numberOfChannels: channels,
        });
      }
      const offset = Math.round((item.timestamp - start) * audio.sampleRate);
      const skip = Math.max(0, -offset),
        target = Math.max(0, offset);
      const amount = Math.min(item.buffer.length - skip, audio.length - target);
      if (amount > 0)
        for (let c = 0; c < audio.numberOfChannels; c++)
          audio
            .getChannelData(c)
            .set(
              item.buffer
                .getChannelData(Math.min(c, item.buffer.numberOfChannels - 1))
                .subarray(skip, skip + amount),
              target,
            );
    }
    return audio;
  } finally {
    input.dispose();
  }
}

export function sliceAudio(
  audio: AudioBuffer | null,
  start: number,
  end: number,
): AudioBuffer | null {
  if (!audio) return null;
  if (start === 0 && end >= audio.duration) return audio;
  const clip = new AudioBuffer({
    length: Math.max(1, Math.round((end - start) * audio.sampleRate)),
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.numberOfChannels,
  });
  const offset = Math.round(start * audio.sampleRate);
  for (let c = 0; c < clip.numberOfChannels; c++)
    clip.getChannelData(c).set(audio.getChannelData(c).subarray(offset, offset + clip.length));
  return clip;
}

/** Encode selected audio in small consecutive pieces instead of a second full PCM allocation. */
export function* audioSections(audio: AudioBuffer, start: number, end: number) {
  const rate = audio.sampleRate,
    finish = Math.min(audio.length, Math.round(end * rate));
  const step = rate * 5;
  for (let offset = Math.max(0, Math.round(start * rate)); offset < finish; offset += step) {
    yield sliceAudio(audio, offset / rate, Math.min(finish, offset + step) / rate)!;
  }
}
