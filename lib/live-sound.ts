import { ANALYSIS_SIZE } from './audio-analysis-config';
import { PcmFeatures, type SoundFrame } from './pcm-features';
import { BassReturnDetector } from './drop-detector.mjs';

/** Native playback fallback when a full decoded track exceeds the cache budget. */
export class LiveSound {
  private downmix: GainNode;
  private splitter: ChannelSplitterNode;
  private analyzers: AnalyserNode[];
  private samples: Float32Array[];
  private features: PcmFeatures;
  private detector = new BassReturnDetector();
  private disposed = false;
  constructor(context: AudioContext, source: MediaElementAudioSourceNode) {
    this.downmix = context.createGain();
    this.downmix.channelCount = 2; this.downmix.channelCountMode = 'explicit';
    this.splitter = context.createChannelSplitter(2);
    source.connect(this.downmix); this.downmix.connect(this.splitter);
    this.analyzers = [0, 1].map(channel => {
      const analyzer = context.createAnalyser(); analyzer.fftSize = ANALYSIS_SIZE;
      analyzer.smoothingTimeConstant = 0; this.splitter.connect(analyzer, channel);
      return analyzer;
    });
    this.samples = this.analyzers.map(() => new Float32Array(ANALYSIS_SIZE));
    this.features = new PcmFeatures(this.samples, context.sampleRate);
  }
  at(time: number): { sound: SoundFrame; drop: number } {
    if (this.disposed) throw new Error('LiveSound has been disposed.');
    this.analyzers.forEach((analyzer, i) => analyzer.getFloatTimeDomainData(this.samples[i] as Float32Array<ArrayBuffer>));
    const sound = this.features.at(ANALYSIS_SIZE / this.features.sampleRate);
    sound.time = time;
    return { sound, drop: this.detector.observe({ time, bassDb: sound.bassDb, levelDb: sound.rmsDb }) };
  }
  reset() { if (!this.disposed) this.detector.reset(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.features.dispose();
    this.downmix.disconnect(); this.splitter.disconnect(); this.analyzers.forEach(analyzer => analyzer.disconnect());
  }
}
