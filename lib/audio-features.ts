import { FFTAnalyzer, waveformEnvelope } from './audio-dsp.mjs';
import { bandPower, recentRms } from './art-reactivity.mjs';
import { BassReturnDetector } from './drop-detector.mjs';
import { ANALYSIS_FPS, ANALYSIS_SIZE } from './audio-analysis-config';

const IMPACT_SIZE = 1024;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const db = (n: number) => n > 0 ? 20 * Math.log10(n) : -160;
export type SoundFrame = {
  time: number; sampleRate: number; size: number;
  channels: ReturnType<FFTAnalyzer['analyze']>[];
  frequency: Uint8Array; wave: Uint8Array; bands: Float32Array[];
  waveform: ReturnType<typeof waveformEnvelope>;
  rms: number; rmsDb: number; bassDb: number; bassHitDb?: number; ringBassDb?: number; middleDb: number; highDb: number;
};
export type SoundEnvelope = Pick<SoundFrame, 'rms' | 'rmsDb' | 'bassDb' | 'bassHitDb' | 'ringBassDb' | 'middleDb' | 'highDb' | 'bands'>;

/** Same calibrated, causal PCM windows for preview, saved frames and exports. */
export class PcmFeatures {
  private analyzers: FFTAnalyzer[];
  private impactAnalyzers: FFTAnalyzer[];
  private frequency = new Uint8Array(ANALYSIS_SIZE / 2);
  private wave = new Uint8Array(ANALYSIS_SIZE);
  constructor(readonly samples: Float32Array[], readonly sampleRate: number) {
    this.analyzers = samples.map(() => new FFTAnalyzer(ANALYSIS_SIZE));
    this.impactAnalyzers = samples.map(() => new FFTAnalyzer(IMPACT_SIZE));
  }
  at(time: number, display = true): SoundFrame {
    const end = Math.round(Math.max(0, time) * this.sampleRate);
    const channels = this.samples.map((samples, i) => this.analyzers[i].analyze(samples, end - ANALYSIS_SIZE / 2, this.sampleRate));
    const frame = { time, sampleRate: this.sampleRate, size: ANALYSIS_SIZE, channels };
    // A separate trailing 21–23 ms window catches short bass impacts. The
    // larger calibrated window still supplies spectrum detail and drop levels.
    const impactFrame = { time, sampleRate: this.sampleRate, size: IMPACT_SIZE,
      channels: this.samples.map((samples, i) => this.impactAnalyzers[i].analyze(samples, end - IMPACT_SIZE / 2, this.sampleRate)) };
    const bassHitDb = db(Math.sqrt(bandPower(impactFrame, 35, 180)));
    const rms = recentRms(this.samples, time, this.sampleRate);
    if (display) {
      this.frequency.fill(0);
      let loudest = 0, power = -1;
      for (let c = 0; c < channels.length; c++) {
        const acPower = recentRms([this.samples[c]], time, this.sampleRate, ANALYSIS_SIZE / this.sampleRate * 1000);
        if (acPower > power) { power = acPower; loudest = c; }
      }
      for (let i = 1; i < this.frequency.length; i++) {
        // Power average avoids stereo phase cancellation and max-channel bias.
        let p = 0;
        for (const channel of channels) p += channel.amplitudes[i] ** 2;
        const level = db(Math.sqrt(p / Math.max(1, channels.length)));
        this.frequency[i] = Math.round(clamp((level + 75) / 63) * 255);
      }
      for (let i = 0; i < this.wave.length; i++) {
      const index = end - ANALYSIS_SIZE + i;
      const value = index >= 0 ? this.samples[loudest]?.[index] ?? 0 : 0;
      this.wave[i] = Math.max(0, Math.min(255, Math.round(128 + value * 127)));
      }
    }
    const bands = channels.map(channel => {
      const output = new Float32Array(96), top = Math.min(16000, this.sampleRate / 2);
      for (let i = 0; i < output.length; i++) {
        const low = 35 * (top / 35) ** (i / output.length);
        const high = 35 * (top / 35) ** ((i + 1) / output.length);
        let first = Math.max(1, Math.ceil(low * ANALYSIS_SIZE / this.sampleRate));
        let last = Math.min(channel.db.length - 1, Math.floor(high * ANALYSIS_SIZE / this.sampleRate));
        if (last < first) first = last = Math.max(1, Math.min(channel.db.length - 1, Math.round(Math.sqrt(low * high) * ANALYSIS_SIZE / this.sampleRate)));
        let peak = -160;
        for (let k = first; k <= last; k++) peak = Math.max(peak, channel.db[k]);
        output[i] = clamp((peak + 75) / 63);
      }
      return output;
    });
    const level = (low: number, high: number) => db(Math.sqrt(bandPower(frame, low, Math.min(high, this.sampleRate / 2))));
    return { ...frame, frequency: this.frequency, wave: this.wave, bands,
      waveform: display ? waveformEnvelope(this.samples, end - Math.round(this.sampleRate * .12), end, 240) : [],
      rms, rmsDb: db(rms), bassDb: level(35, 180), bassHitDb, ringBassDb: level(35, 450), middleDb: level(180, 2500), highDb: level(2500, 12000) };
  }
}

export function dropEnvelope(events: number[], time: number) {
  let low = 0, high = events.length;
  while (low < high) { const mid = (low + high) >>> 1; if (events[mid] <= time) low = mid + 1; else high = mid; }
  const event = events[low - 1];
  if (event === undefined || time >= event + .9) return 0;
  return Math.exp(-(time - event) / .23);
}

/** Analyze a fixed hop from track start, so range exports retain musical history. */
async function scanSound(samples: Float32Array[], rate: number, signal?: AbortSignal, retain = false) {
  const analyzer = new PcmFeatures(samples, rate), detector = new BassReturnDetector(), events: number[] = [];
  const envelopes: SoundEnvelope[] = [];
  const count = Math.ceil((samples[0]?.length ?? 0) / rate * ANALYSIS_FPS);
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
    const frame = analyzer.at(i / ANALYSIS_FPS, false);
    if (detector.observe({ time: frame.time, bassDb: frame.bassDb, levelDb: frame.rmsDb }) === 1) events.push(frame.time);
    if (retain) envelopes.push({ rms: frame.rms, rmsDb: frame.rmsDb, bassDb: frame.bassDb, bassHitDb: frame.bassHitDb, ringBassDb: frame.ringBassDb, middleDb: frame.middleDb, highDb: frame.highDb, bands: frame.bands });
    if (i % 60 === 59) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { events, envelopes };
}
export async function findDropEvents(samples: Float32Array[], rate: number, signal?: AbortSignal) { return (await scanSound(samples, rate, signal)).events; }

export type PreparedSound = { audio: AudioBuffer | null; events: number[]; envelopes: SoundEnvelope[]; overview: ReturnType<typeof waveformEnvelope> };
export async function prepareSound(audio: AudioBuffer | null, signal?: AbortSignal): Promise<PreparedSound> {
  const samples = audio ? Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)) : [];
  const analysis = audio ? await scanSound(samples, audio.sampleRate, signal, true) : { events: [], envelopes: [] };
  return { audio, ...analysis,
    overview: waveformEnvelope(samples, 0, audio?.length ?? 0, 900) };
}

/** HTML media clock correction is an estimate; device/display latency still varies. */
export function audibleMediaTime(media: HTMLMediaElement, context: AudioContext | null, now: number) {
  if (media.paused || !context) return media.currentTime;
  let latency = context.outputLatency || context.baseLatency || 0;
  const stamp = context.getOutputTimestamp?.();
  if (stamp && typeof stamp.contextTime === 'number' && typeof stamp.performanceTime === 'number' && stamp.contextTime > 0 && stamp.performanceTime > 0) {
    latency = Math.max(0, context.currentTime - (stamp.contextTime + Math.max(0, now - stamp.performanceTime) / 1000));
  }
  return Math.max(0, media.currentTime - Math.min(.25, latency));
}
