/**
 * Reusable mixed-radix complex FFT for lengths whose factors are 2, 3 and 5.
 *
 * The plan precomputes a mixed-radix input permutation, stage twiddles and
 * reusable work arrays. The 7,680-point Kim Vocal 2 transform therefore does
 * no per-frame allocation, trigonometry or recursive tree traversal.
 */

export type FFTDirection = "forward" | "inverse";

type FFTStage = {
  length: number;
  radix: number;
  subLength: number;
  twiddleReal: Float64Array;
  twiddleImag: Float64Array;
};

const RADICES = [2, 3, 5] as const;

function factorize(length: number): number[] {
  const factors: number[] = [];
  let remainder = length;
  while (remainder > 1) {
    const radix = RADICES.find((candidate) => remainder % candidate === 0);
    if (radix === undefined) {
      throw new RangeError(`FFT length ${length} has a factor other than 2, 3, or 5`);
    }
    factors.push(radix);
    remainder /= radix;
  }
  return factors;
}

function makeStages(factors: readonly number[]): FFTStage[] {
  const stages: FFTStage[] = [];
  let length = 1;
  for (let index = factors.length - 1; index >= 0; index -= 1) {
    const radix = factors[index];
    length *= radix;
    const subLength = length / radix;
    const twiddleReal = new Float64Array(length * radix);
    const twiddleImag = new Float64Array(length * radix);
    for (let branch = 0; branch < radix; branch += 1) {
      const branchOffset = branch * length;
      for (let frequency = 0; frequency < length; frequency += 1) {
        const angle = (2 * Math.PI * branch * frequency) / length;
        const tableIndex = branchOffset + frequency;
        twiddleReal[tableIndex] = Math.cos(angle);
        twiddleImag[tableIndex] = -Math.sin(angle);
      }
    }
    stages.push({ length, radix, subLength, twiddleReal, twiddleImag });
  }
  return stages;
}

function makeInputPermutation(length: number, factors: readonly number[]): Int32Array {
  const permutation = new Int32Array(length);
  const digits = new Int32Array(factors.length);
  for (let destination = 0; destination < length; destination += 1) {
    let remainder = destination;
    for (let index = factors.length - 1; index >= 0; index -= 1) {
      digits[index] = remainder % factors[index];
      remainder = Math.floor(remainder / factors[index]);
    }

    let source = 0;
    let stride = 1;
    for (let index = 0; index < factors.length; index += 1) {
      source += digits[index] * stride;
      stride *= factors[index];
    }
    permutation[destination] = source;
  }
  return permutation;
}

/** A compiled, reusable complex FFT plan. Inverse transforms are normalized. */
export class FFTPlan {
  readonly length: number;
  private readonly stages: FFTStage[];
  private readonly inputPermutation: Int32Array;
  private readonly workReal: Float64Array;
  private readonly workImag: Float64Array;
  private readonly scratchReal = new Float64Array(5);
  private readonly scratchImag = new Float64Array(5);

  constructor(length: number) {
    if (!Number.isSafeInteger(length) || length < 1) {
      throw new RangeError("FFT length must be a positive safe integer");
    }
    this.length = length;
    const factors = factorize(length);
    this.inputPermutation = makeInputPermutation(length, factors);
    this.stages = makeStages(factors);
    this.workReal = new Float64Array(length);
    this.workImag = new Float64Array(length);
  }

  /**
   * Write a complex transform into caller-owned output arrays. Input and output
   * arrays may alias because samples are permuted into plan-owned work storage.
   */
  transform(
    inputReal: Float32Array | Float64Array,
    inputImag: Float32Array | Float64Array,
    outputReal: Float32Array | Float64Array,
    outputImag: Float32Array | Float64Array,
    direction: FFTDirection = "forward",
  ): void {
    if (
      inputReal.length < this.length ||
      inputImag.length < this.length ||
      outputReal.length < this.length ||
      outputImag.length < this.length
    ) {
      throw new RangeError(`FFT buffers must each contain at least ${this.length} samples`);
    }

    const inverse = direction === "inverse";
    for (let destination = 0; destination < this.length; destination += 1) {
      const source = this.inputPermutation[destination];
      this.workReal[destination] = inputReal[source];
      this.workImag[destination] = inputImag[source];
    }

    for (const stage of this.stages) {
      const { length, radix, subLength, twiddleReal, twiddleImag } = stage;
      for (let groupStart = 0; groupStart < this.length; groupStart += length) {
        for (let k2 = 0; k2 < subLength; k2 += 1) {
          for (let branch = 0; branch < radix; branch += 1) {
            const source = groupStart + branch * subLength + k2;
            this.scratchReal[branch] = this.workReal[source];
            this.scratchImag[branch] = this.workImag[source];
          }

          for (let k1 = 0; k1 < radix; k1 += 1) {
            const outputFrequency = k2 + subLength * k1;
            let sumReal = 0;
            let sumImag = 0;
            for (let branch = 0; branch < radix; branch += 1) {
              const tableIndex = branch * length + outputFrequency;
              const factorReal = twiddleReal[tableIndex];
              const forwardTwiddleImag = twiddleImag[tableIndex];
              const twiddleImagValue = inverse ? -forwardTwiddleImag : forwardTwiddleImag;
              const valueReal = this.scratchReal[branch];
              const valueImag = this.scratchImag[branch];
              sumReal += valueReal * factorReal - valueImag * twiddleImagValue;
              sumImag += valueReal * twiddleImagValue + valueImag * factorReal;
            }
            const target = groupStart + outputFrequency;
            this.workReal[target] = sumReal;
            this.workImag[target] = sumImag;
          }
        }
      }
    }

    const scale = inverse ? 1 / this.length : 1;
    for (let index = 0; index < this.length; index += 1) {
      outputReal[index] = this.workReal[index] * scale;
      outputImag[index] = this.workImag[index] * scale;
    }
  }
}

export function createFFTPlan(length: number): FFTPlan {
  return new FFTPlan(length);
}
