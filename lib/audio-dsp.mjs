const DB_FACTOR = 20 / Math.LN10;

function validateSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive finite number");
  }
}

function decibels(amplitude) {
  return amplitude > 0 ? DB_FACTOR * Math.log(amplitude) : -Infinity;
}

function hannResponse(offset, size) {
  const dftKernel = (binOffset) => {
    if (Math.abs(binOffset) < 1e-14) return [size, 0];
    const numerator = Math.sin(Math.PI * binOffset);
    const denominator = Math.sin((Math.PI * binOffset) / size);
    const magnitude = numerator / denominator;
    const phase = (-Math.PI * binOffset * (size - 1)) / size;
    return [magnitude * Math.cos(phase), magnitude * Math.sin(phase)];
  };

  const center = dftKernel(offset);
  const lower = dftKernel(offset - 1);
  const upper = dftKernel(offset + 1);
  const real = 0.5 * center[0] - 0.25 * lower[0] - 0.25 * upper[0];
  const imag = 0.5 * center[1] - 0.25 * lower[1] - 0.25 * upper[1];
  return (2 * Math.hypot(real, imag)) / size;
}

function estimateHannPeakOffset(amplitudes, bin, size) {
  const center = Math.max(amplitudes[bin], 1e-300);
  const observedLeft = Math.log(Math.max(amplitudes[bin - 1], 1e-300) / center);
  const observedRight = Math.log(Math.max(amplitudes[bin + 1], 1e-300) / center);
  const loss = (offset) => {
    const response = Math.max(hannResponse(offset, size), 1e-300);
    const expectedLeft = Math.log(
      Math.max(hannResponse(offset + 1, size), 1e-300) / response,
    );
    const expectedRight = Math.log(
      Math.max(hannResponse(offset - 1, size), 1e-300) / response,
    );
    return (observedLeft - expectedLeft) ** 2 + (observedRight - expectedRight) ** 2;
  };

  // Fit the neighboring-bin ratios to the exact periodic-Hann response.
  let low = -0.5;
  let high = 0.5;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const first = low + (high - low) / 3;
    const second = high - (high - low) / 3;
    if (loss(first) < loss(second)) high = second;
    else low = first;
  }
  return (low + high) / 2;
}

function validatePowerOfTwo(size, name = "size") {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new RangeError(`${name} must be a power of two of at least 2`);
  }
}

/**
 * Reusable radix-2 real-spectrum analyzer with a periodic Hann window.
 * Spectrum values are peak-amplitude dBFS per FFT bin (0 dBFS = peak 1).
 * `rmsDb` instead uses RMS relative to a sample value of 1, so a full-scale
 * sine reads -3.0103 dBFS RMS while its calibrated spectral peak reads 0 dBFS.
 * The returned `db` and `amplitudes` arrays are reused by the next call to
 * `analyze`; copy them before retaining a spectrum across frames.
 */
export class FFTAnalyzer {
  constructor(size, diagnostics = true) {
    validatePowerOfTwo(size);

    this.diagnostics = diagnostics;
    this.size = size;
    this.binCount = size / 2 + 1;
    this.window = new Float64Array(size);
    this.windowSum = 0;
    this.real = new Float64Array(size);
    this.imag = new Float64Array(size);
    this.amplitudes = new Float64Array(this.binCount);
    this.db = new Float32Array(this.binCount);
    this.#makeWindow();
  }

  #makeWindow() {
    const denominator = this.size;
    for (let n = 0; n < this.size; n += 1) {
      const value = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / denominator);
      this.window[n] = value;
      this.windowSum += value;
    }
  }

  #fft() {
    const { size, real, imag } = this;

    // In-place bit-reversal permutation.
    let reversed = 0;
    for (let index = 1; index < size; index += 1) {
      let bit = size >> 1;
      while (reversed & bit) {
        reversed ^= bit;
        bit >>= 1;
      }
      reversed ^= bit;
      if (index < reversed) {
        [real[index], real[reversed]] = [real[reversed], real[index]];
        [imag[index], imag[reversed]] = [imag[reversed], imag[index]];
      }
    }

    for (let span = 2; span <= size; span <<= 1) {
      const halfSpan = span >> 1;
      const angleStep = (-2 * Math.PI) / span;
      const stepReal = Math.cos(angleStep);
      const stepImag = Math.sin(angleStep);

      for (let start = 0; start < size; start += span) {
        let twiddleReal = 1;
        let twiddleImag = 0;

        for (let offset = 0; offset < halfSpan; offset += 1) {
          const even = start + offset;
          const odd = even + halfSpan;
          const oddReal =
            real[odd] * twiddleReal - imag[odd] * twiddleImag;
          const oddImag =
            real[odd] * twiddleImag + imag[odd] * twiddleReal;
          const evenReal = real[even];
          const evenImag = imag[even];

          real[even] = evenReal + oddReal;
          imag[even] = evenImag + oddImag;
          real[odd] = evenReal - oddReal;
          imag[odd] = evenImag - oddImag;

          const nextTwiddleReal =
            twiddleReal * stepReal - twiddleImag * stepImag;
          twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
          twiddleReal = nextTwiddleReal;
        }
      }
    }
  }

  /**
   * Analyze an N-sample window centered on `centerSample`.
   * Samples outside the provided channel are treated as silence. A fractional
   * center is rounded to the nearest sample frame.
   */
  analyze(channelArray, centerSample, sampleRate) {
    if (!channelArray || typeof channelArray.length !== "number") {
      throw new TypeError("channelArray must be an array-like sample channel");
    }
    if (!Number.isFinite(centerSample)) {
      throw new RangeError("centerSample must be a finite sample index");
    }
    validateSampleRate(sampleRate);

    const size = this.size;
    const startSample = Math.round(centerSample) - size / 2;
    let squareSum = 0;
    let samplePeak = 0;

    for (let n = 0; n < size; n += 1) {
      const sampleIndex = startSample + n;
      const sourceSample =
        sampleIndex >= 0 && sampleIndex < channelArray.length
          ? Number(channelArray[sampleIndex])
          : 0;
      const sample = Number.isFinite(sourceSample) ? sourceSample : 0;
      const absolute = Math.abs(sample);
      if (absolute > samplePeak) samplePeak = absolute;
      squareSum += sample * sample;
      this.real[n] = sample * this.window[n];
      this.imag[n] = 0;
    }

    this.#fft();

    let peakBin = 0;
    let peakAmplitude = -1;
    for (let bin = 0; bin < this.binCount; bin += 1) {
      const magnitude = Math.hypot(this.real[bin], this.imag[bin]);
      // The DC and Nyquist bins have no negative-frequency partner to double.
      const oneSidedScale = bin === 0 || bin === this.size / 2 ? 1 : 2;
      const amplitude = (oneSidedScale * magnitude) / this.windowSum;
      this.amplitudes[bin] = amplitude;
      this.db[bin] = decibels(amplitude);
      if (amplitude > peakAmplitude) {
        peakAmplitude = amplitude;
        peakBin = bin;
      }
    }

    let peakOffset = 0;
    let peakDb = decibels(Math.max(peakAmplitude, 0));
    if (
      this.diagnostics &&
      peakAmplitude > 0 &&
      peakBin > 1 &&
      peakBin < this.size / 2 - 1
    ) {
      // Fit the Hann main lobe for a sub-bin tone estimate. `db[]` remains the
      // calibrated, literal per-bin spectrum; this correction is for the peak
      // summary only and assumes one dominant sinusoid within the main lobe.
      peakOffset = estimateHannPeakOffset(this.amplitudes, peakBin, this.size);
      if (Math.abs(peakOffset) < 1e-5) peakOffset = 0;
      const response = hannResponse(peakOffset, this.size);
      peakDb = decibels(this.amplitudes[peakBin] / response);
    }

    const peakFrequency = Math.min(
      sampleRate / 2,
      Math.max(0, ((peakBin + peakOffset) * sampleRate) / size),
    );

    return {
      db: this.db,
      amplitudes: this.amplitudes,
      peakFrequency,
      peakDb,
      rmsDb: decibels(Math.sqrt(squareSum / size)),
      samplePeakDb: decibels(samplePeak),
    };
  }
}

/**
 * Reduce each channel to min/max sample envelopes for horizontal pixel columns.
 * The selected interval is half-open [startSample, endSample); empty buckets
 * (possible when zoomed in farther than one sample per pixel) contain NaN.
 */
export function waveformEnvelope(channels, startSample, endSample, pixels) {
  if (!Array.isArray(channels)) {
    throw new TypeError("channels must be an array of sample channels");
  }
  if (!Number.isInteger(startSample) || !Number.isInteger(endSample)) {
    throw new RangeError("startSample and endSample must be integer sample indices");
  }
  if (endSample < startSample) {
    throw new RangeError("endSample must be greater than or equal to startSample");
  }
  if (!Number.isInteger(pixels) || pixels < 1) {
    throw new RangeError("pixels must be a positive integer");
  }

  const span = endSample - startSample;
  return channels.map((channel) => {
    if (!channel || typeof channel.length !== "number") {
      throw new TypeError("each channel must be an array-like sample channel");
    }
    const min = new Float32Array(pixels);
    const max = new Float32Array(pixels);

    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const bucketStart = Math.floor(startSample + (span * pixel) / pixels);
      const bucketEnd = Math.floor(startSample + (span * (pixel + 1)) / pixels);
      const firstSample = Math.max(0, bucketStart);
      const lastSample = Math.min(channel.length, bucketEnd);
      let bucketMin = Infinity;
      let bucketMax = -Infinity;

      for (let sampleIndex = firstSample; sampleIndex < lastSample; sampleIndex += 1) {
        const sample = Number(channel[sampleIndex]) || 0;
        if (sample < bucketMin) bucketMin = sample;
        if (sample > bucketMax) bucketMax = sample;
      }

      min[pixel] = bucketMin === Infinity ? NaN : bucketMin;
      max[pixel] = bucketMax === -Infinity ? NaN : bucketMax;
    }

    return { min, max };
  });
}

function validateSignalParameters(sampleRate, duration) {
  validateSampleRate(sampleRate);
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError("duration must be a non-negative finite number");
  }
}

/** Create a deterministic, original mellow electronic stereo demo signal. */
export function generateDemo(sampleRate, duration) {
  validateSignalParameters(sampleRate, duration);
  const frameCount = Math.floor(sampleRate * duration);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  const beatDuration = 60 / 96;
  const barDuration = beatDuration * 4;
  const chordRoots = [45, 41, 48, 43]; // A2, F2, C3, G2
  const chordIntervals = [0, 3, 7, 10];
  const melody = [69, 72, 76, 79, 76, 72, 71, 67];
  let noiseSeed = 0x13579bdf;

  const midiToHz = (note) => 440 * 2 ** ((note - 69) / 12);
  for (let index = 0; index < frameCount; index += 1) {
    const time = index / sampleRate;
    const beatPhase = (time % beatDuration) / beatDuration;
    const barIndex = Math.floor(time / barDuration) % chordRoots.length;
    const barPhase = (time % barDuration) / barDuration;
    const root = chordRoots[barIndex];
    let pad = 0;
    let panPad = 0;
    for (let voice = 0; voice < chordIntervals.length; voice += 1) {
      const frequency = midiToHz(root + chordIntervals[voice] + 12);
      const phase = 2 * Math.PI * frequency * time;
      const voiceValue = Math.sin(phase) * 0.055;
      pad += voiceValue;
      panPad += voiceValue * (voice % 2 === 0 ? 0.72 : 1.0);
    }

    const beatIndex = Math.floor(time / beatDuration);
    const kickPhase = time % beatDuration;
    const kickFrequency = 92 * Math.exp(-kickPhase * 7) + 38;
    const kick =
      (beatIndex % 4 === 0 || beatIndex % 4 === 2) && kickPhase < 0.35
        ? 0.48 * Math.exp(-kickPhase * 12) * Math.sin(2 * Math.PI * kickFrequency * kickPhase)
        : 0;

    const stepDuration = beatDuration / 2;
    const stepPhase = time % stepDuration;
    noiseSeed = (1664525 * noiseSeed + 1013904223) >>> 0;
    const noise = noiseSeed / 0xffffffff * 2 - 1;
    const hat = stepPhase < 0.045 ? 0.035 * Math.exp(-stepPhase * 90) * noise : 0;

    const noteIndex = Math.floor(time / (beatDuration / 2)) % melody.length;
    const notePhase = time % (beatDuration / 2);
    const pluck =
      0.095 * Math.exp(-notePhase * 5) *
      Math.sin(2 * Math.PI * midiToHz(melody[noteIndex]) * time);
    const bass =
      0.16 * Math.exp(-beatPhase * 1.5) *
      Math.sin(2 * Math.PI * midiToHz(root - 12) * time);
    const stereoDrift = 0.12 * Math.sin(2 * Math.PI * 0.17 * time + barPhase * Math.PI);

    // An original two-bar breakdown gives the sample a clear bass return at
    // 15 seconds, so listeners can hear what the drop effects respond to.
    const breakdown = time >= 10 && time < 15;
    const rhythm = breakdown ? .025 : 1;
    const melodyGain = breakdown ? .08 : 1;
    left[index] = pad * (0.88 + stereoDrift) * melodyGain + (kick + bass) * rhythm + (hat + pluck) * melodyGain;
    right[index] = panPad * (0.88 - stereoDrift) * melodyGain + (kick + bass) * rhythm + (hat + pluck) * melodyGain;
  }

  return [left, right];
}

/** Generate an exactly phase-aligned test sine, optionally inverted in R. */
export function generateTestTone(
  sampleRate,
  duration = 8,
  frequency = 1000,
  amplitude = 0.5,
  phaseInverted = false,
) {
  validateSignalParameters(sampleRate, duration);
  if (!Number.isFinite(frequency) || frequency < 0 || frequency > sampleRate / 2) {
    throw new RangeError("frequency must be between DC and Nyquist");
  }
  if (!Number.isFinite(amplitude) || amplitude < 0) {
    throw new RangeError("amplitude must be a non-negative finite number");
  }

  const frameCount = Math.floor(sampleRate * duration);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    left[index] = value;
    right[index] = phaseInverted ? -value : value;
  }
  return [left, right];
}
