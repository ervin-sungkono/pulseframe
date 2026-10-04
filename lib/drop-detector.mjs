import { bandPower, recentRms } from './art-reactivity.mjs';
const level = value => Math.max(-90, value > 0 ? 20 * Math.log10(value) : -90);
const follow = (old, next, dt, rise, fall = rise) => old + (next - old) * (1 - Math.exp(-dt / (next > old ? rise : fall)));

/** Conservative causal bass-return heuristic, not a musical section classifier.
 * Unmodified channel powers drive it, independent of visual sensitivity.
 * Requires audible history, a quieter section, then a sustained bass return.
 */
export class BassReturnDetector {
  state = null;
  reset() { this.state = null; }
  update(frame, channels) {
    if (!frame) { this.reset(); return 0; }
    return this.observe({
      time: frame.time, revision: frame.revision, playing: frame.playing,
      bassDb: level(Math.sqrt(bandPower(frame, 35, 180))),
      levelDb: level(recentRms(channels, frame.time, frame.sampleRate)),
    });
  }
  observe({ time, revision = 0, playing = true, bassDb, levelDb }) {
    bassDb = Math.max(-90, Math.min(0, bassDb)); levelDb = Math.max(-90, Math.min(0, levelDb));
    let s = this.state;
    const dt = s ? time - s.time : 0;
    if (!s || !playing || !s.playing || revision !== s.revision || dt < 0 || dt > .25) {
      this.state = { time, revision, playing, age: 0, music: 0, bass: bassDb, loudness: levelDb, referenceBass: bassDb, referenceLevel: levelDb, quiet: 0, armed: false, quietBass: bassDb, quietLevel: levelDb, candidate: 0, event: -Infinity };
      return 0;
    }
    if (dt === 0) return time - s.event < .9 ? Math.exp(-(time - s.event) / .23) : 0;
    s.time = time; s.age += dt;
    s.bass = follow(s.bass, bassDb, dt, .045, .12);
    s.loudness = follow(s.loudness, levelDb, dt, .025, .1);
    s.referenceBass = follow(s.referenceBass, s.bass, dt, .35, 10);
    s.referenceLevel = follow(s.referenceLevel, s.loudness, dt, .35, 10);
    if (s.bass > -48 && s.loudness > -43) s.music += dt;
    const quieter = s.bass < s.referenceBass - 9 && s.loudness < s.referenceLevel - 6;
    if (s.age >= 1.25 && s.music >= .4 && time - s.event > 4) {
      if (quieter) {
        s.quiet += dt;
        s.quietBass = s.quiet <= dt ? s.bass : follow(s.quietBass, s.bass, dt, .2);
        s.quietLevel = s.quiet <= dt ? s.loudness : follow(s.quietLevel, s.loudness, dt, .2);
        if (s.quiet >= .85) s.armed = true;
      } else s.quiet = 0;
    } else s.quiet = 0;
    // Require live 20 ms PCM loudness during confirmation: the FFT window and
    // release envelope alone can stretch a short kick into a false return.
    const returned = s.armed && s.bass - s.quietBass >= 11 && levelDb - s.quietLevel >= 5 && s.bass > -42 && levelDb > -40;
    s.candidate = returned ? s.candidate + dt : 0;
    if (s.candidate >= .1) {
      s.event = time; s.armed = false; s.quiet = 0; s.candidate = 0;
    }
    // Exact cutoff restores a genuinely sharp image between effects.
    const elapsed = time - s.event;
    return elapsed >= 0 && elapsed < .9 ? Math.exp(-elapsed / .23) : 0;
  }
}
