const clamp = (v) => Math.max(0, Math.min(1, v));
const db = (v) => v > 0 ? 20 * Math.log10(v) : -160;

// FFT amplitudes have coherent-gain correction. For a periodic Hann window,
// sum(A²)/3 estimates the time-domain band power for interior one-sided bins.
// Channels are combined as powers: opposite-phase stereo remains visible.
export function bandPower(frame, low, high) {
  if (!frame?.channels?.length) return 0;
  const first = Math.max(1, Math.ceil(low * frame.size / frame.sampleRate));
  const last = Math.min(frame.size / 2 - 1, Math.floor(high * frame.size / frame.sampleRate));
  let power = 0;
  for (const channel of frame.channels) {
    for (let k = first; k <= last; k++) power += channel.amplitudes[k] ** 2 / 3;
  }
  return power / frame.channels.length;
}

export function recentRms(channels, time, sampleRate, milliseconds = 20) {
  if (!channels?.length) return 0;
  const end = Math.round(time * sampleRate);
  const count = Math.max(1, Math.round(sampleRate * milliseconds / 1000));
  let power = 0;
  for (const channel of channels) {
    let sum = 0, squares = 0;
    for (let i = end - count; i < end; i++) {
      const sample = i >= 0 && i < channel.length ? channel[i] : 0;
      sum += sample; squares += sample * sample;
    }
    // DC is not an audible event and should not create animation.
    power += Math.max(0, squares / count - (sum / count) ** 2);
  }
  return Math.sqrt(power / channels.length);
}

export function reactiveFeatures(frame, channels, sensitivity = 1) {
  const empty = { energy: 0, bass: 0, middle: 0, high: 0, bands: [], rmsDb: -160 };
  if (!frame) return empty;
  const rmsDb = db(recentRms(channels, frame.time, frame.sampleRate));
  const gate = clamp((rmsDb + 64) / 14);
  const visual = (level, floor, ceiling) => clamp((level - floor) / (ceiling - floor) * sensitivity) * gate;
  const bandLevel = (low, high) => db(Math.sqrt(bandPower(frame, low, Math.min(high, frame.sampleRate / 2))));
  const bands = frame.channels.map(channel => {
    const output = new Float32Array(96);
    const top = Math.min(16000, frame.sampleRate / 2);
    for (let i = 0; i < output.length; i++) {
      const low = 35 * (top / 35) ** (i / output.length);
      const high = 35 * (top / 35) ** ((i + 1) / output.length);
      let start = Math.max(1, Math.ceil(low * frame.size / frame.sampleRate));
      let end = Math.min(channel.db.length - 1, Math.floor(high * frame.size / frame.sampleRate));
      // Geometry interpolates the nearest real bin when a narrow log bucket
      // is smaller than the FFT spacing. This is an artistic mapping.
      if (end < start) start = end = Math.min(channel.db.length - 1, Math.max(1, Math.round(Math.sqrt(low * high) * frame.size / frame.sampleRate)));
      let peak = -160;
      for (let k = start; k <= end; k++) peak = Math.max(peak, channel.db[k]);
      output[i] = visual(peak, -75, -12);
    }
    return output;
  });
  return {
    energy: visual(rmsDb, -58, -9),
    bass: visual(bandLevel(35, 180), -55, -12),
    middle: visual(bandLevel(180, 2500), -62, -18),
    high: visual(bandLevel(2500, 12000), -72, -24),
    bands, rmsDb,
  };
}

export function smoothFeatures(previous, target, dt, response = 'balanced', reset = false) {
  const timings = { gentle: [0.06, 0.25], balanced: [0.02, 0.14], energetic: [0.009, 0.085] };
  const [attack, release] = timings[response] || timings.balanced;
  const next = { ...target, phase: previous?.phase || 0 };
  for (const key of ['energy', 'bass', 'middle', 'high']) {
    const old = previous?.[key] || 0;
    const alpha = reset || !previous ? 1 : dt > 0 ? 1 - Math.exp(-dt / (target[key] > old ? attack : release)) : 0;
    next[key] = old + (target[key] - old) * alpha;
  }
  if (reset) next.phase = 0;
  else if (dt > 0) next.phase += dt * next.energy * (0.22 + next.energy * 0.45);
  return next;
}
