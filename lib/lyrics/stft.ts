import { createFFTPlan, type FFTPlan } from "./fft";
import {
  MDX_BINS,
  MDX_BLOCK_SAMPLES,
  MDX_FFT_SIZE,
  MDX_FRAMES,
  MDX_HOP_SIZE,
  MDX_LOW_BINS,
  MDX_SPECTRUM_SIZE,
} from "./mdx-config";

export {
  MDX_BINS,
  MDX_BLOCK_SAMPLES,
  MDX_FFT_SIZE,
  MDX_FRAMES,
  MDX_HOP_SIZE,
  MDX_LOW_BINS,
  MDX_MODEL_SHAPE,
  MDX_SAMPLE_RATE,
  MDX_SPECTRUM_SIZE,
} from "./mdx-config";

const HALF_FFT = MDX_FFT_SIZE / 2;
const MAX_SAFE_NORM = 1e-12;

/** The model uses the periodic form of Hann, whose denominator is N. */
export function createPeriodicHann(length: number): Float32Array {
  if (!Number.isSafeInteger(length) || length < 2) {
    throw new RangeError("Hann window length must be an integer greater than one");
  }
  const window = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / length);
  }
  return window;
}

/**
 * Reusable centered STFT/iSTFT pair for Kim Vocal 2.
 *
 * A model block contains 256 frames at 1,024-sample hops. Center padding by
 * 3,840 samples on both sides produces exactly those frames. Spectra use the
 * model's frequency-major layout: `bin * frameCount + frame`. Only the first
 * 3,072 nonnegative bins are passed to the model; omitted upper frequencies
 * are zeroed during reconstruction.
 */
export class MdxSTFT {
  readonly fftSize = MDX_FFT_SIZE;
  readonly hopSize = MDX_HOP_SIZE;
  readonly bins = MDX_BINS;
  readonly frames = MDX_FRAMES;
  readonly blockSamples = MDX_BLOCK_SAMPLES;
  readonly hann: Float32Array;

  private readonly fft: FFTPlan;
  private readonly frameReal: Float64Array;
  private readonly frameImag: Float64Array;
  private readonly transformedReal: Float64Array;
  private readonly transformedImag: Float64Array;
  private readonly inverseReal: Float64Array;
  private readonly inverseImag: Float64Array;
  private readonly inverseAccum: Float64Array;
  private readonly inverseNorm: Float64Array;

  constructor() {
    this.fft = createFFTPlan(MDX_FFT_SIZE);
    this.hann = createPeriodicHann(MDX_FFT_SIZE);
    this.frameReal = new Float64Array(MDX_FFT_SIZE);
    this.frameImag = new Float64Array(MDX_FFT_SIZE);
    this.transformedReal = new Float64Array(MDX_FFT_SIZE);
    this.transformedImag = new Float64Array(MDX_FFT_SIZE);
    this.inverseReal = new Float64Array(MDX_FFT_SIZE);
    this.inverseImag = new Float64Array(MDX_FFT_SIZE);
    this.inverseAccum = new Float64Array(MDX_BLOCK_SAMPLES + MDX_FFT_SIZE);
    this.inverseNorm = new Float64Array(MDX_BLOCK_SAMPLES + MDX_FFT_SIZE);
  }

  /** Analyze one 261,120-sample mono channel into one model plane pair. */
  forward(signal: Float32Array, spectrumReal: Float32Array, spectrumImag: Float32Array): void {
    if (signal.length !== MDX_BLOCK_SAMPLES) {
      throw new RangeError(`MDX input blocks must contain exactly ${MDX_BLOCK_SAMPLES} samples`);
    }
    this.assertSpectrumBuffers(spectrumReal, spectrumImag);

    const half = HALF_FFT;
    for (let frame = 0; frame < MDX_FRAMES; frame += 1) {
      const paddedStart = frame * MDX_HOP_SIZE;
      for (let index = 0; index < MDX_FFT_SIZE; index += 1) {
        const sourceIndex = paddedStart + index - half;
        const sample = sourceIndex >= 0 && sourceIndex < signal.length ? signal[sourceIndex] : 0;
        this.frameReal[index] = sample * this.hann[index];
        this.frameImag[index] = 0;
      }

      this.fft.transform(
        this.frameReal,
        this.frameImag,
        this.transformedReal,
        this.transformedImag,
      );
      for (let bin = 0; bin < MDX_BINS; bin += 1) {
        const target = bin * MDX_FRAMES + frame;
        spectrumReal[target] = bin < MDX_LOW_BINS ? 0 : this.transformedReal[bin];
        spectrumImag[target] = bin < MDX_LOW_BINS ? 0 : this.transformedImag[bin];
      }
    }
  }

  /**
   * Reconstruct one model spectrum into a centered, overlap-added block.
   *
   * DC is constrained to be real, and the omitted high-frequency bins are
   * zero-filled. The model output is otherwise preserved, including bins that
   * were zeroed only on the input path.
   */
  inverse(spectrumReal: Float32Array, spectrumImag: Float32Array, signal: Float32Array): void {
    this.assertSpectrumBuffers(spectrumReal, spectrumImag);
    if (signal.length !== MDX_BLOCK_SAMPLES) {
      throw new RangeError(`MDX output blocks must contain exactly ${MDX_BLOCK_SAMPLES} samples`);
    }

    this.inverseAccum.fill(0);
    this.inverseNorm.fill(0);
    for (let frame = 0; frame < MDX_FRAMES; frame += 1) {
      this.inverseReal.fill(0);
      this.inverseImag.fill(0);
      for (let bin = 0; bin < MDX_BINS; bin += 1) {
        const source = bin * MDX_FRAMES + frame;
        const real = spectrumReal[source];
        const imag = bin === 0 ? 0 : spectrumImag[source];
        this.inverseReal[bin] = real;
        this.inverseImag[bin] = imag;
        if (bin > 0) {
          this.inverseReal[MDX_FFT_SIZE - bin] = real;
          this.inverseImag[MDX_FFT_SIZE - bin] = -imag;
        }
      }

      this.fft.transform(
        this.inverseReal,
        this.inverseImag,
        this.transformedReal,
        this.transformedImag,
        "inverse",
      );

      const frameStart = frame * MDX_HOP_SIZE;
      for (let index = 0; index < MDX_FFT_SIZE; index += 1) {
        const window = this.hann[index];
        const position = frameStart + index;
        this.inverseAccum[position] += this.transformedReal[index] * window;
        this.inverseNorm[position] += window * window;
      }
    }

    const cropStart = HALF_FFT;
    for (let index = 0; index < MDX_BLOCK_SAMPLES; index += 1) {
      const position = cropStart + index;
      const normalization = this.inverseNorm[position];
      signal[index] =
        normalization > MAX_SAFE_NORM ? this.inverseAccum[position] / normalization : 0;
    }
  }

  private assertSpectrumBuffers(real: Float32Array, imag: Float32Array): void {
    if (real.length < MDX_SPECTRUM_SIZE || imag.length < MDX_SPECTRUM_SIZE) {
      throw new RangeError(`MDX spectrum buffers must each contain ${MDX_SPECTRUM_SIZE} values`);
    }
  }
}

export function createMdxSTFT(): MdxSTFT {
  return new MdxSTFT();
}
