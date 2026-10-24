/** Fixed Kim Vocal 2 model dimensions and preprocessing constants. */
export const MDX_SAMPLE_RATE = 44_100;
export const MDX_CHANNELS = 2;
export const MDX_FFT_SIZE = 7_680;
export const MDX_HOP_SIZE = 1_024;
export const MDX_BINS = 3_072;
export const MDX_LOW_BINS = 3;
export const MDX_FRAMES = 256;
export const MDX_BLOCK_LENGTH = MDX_HOP_SIZE * (MDX_FRAMES - 1);
export const MDX_BLOCK_SAMPLES = MDX_BLOCK_LENGTH;
export const MDX_TRIM = MDX_FFT_SIZE / 2;
export const MDX_VALID_LENGTH = MDX_BLOCK_LENGTH - 2 * MDX_TRIM;
export const MDX_SPECTRUM_SIZE = MDX_BINS * MDX_FRAMES;
export const MDX_MODEL_SHAPE = [1, 4, MDX_BINS, MDX_FRAMES] as const;
export const MDX_COMPENSATION = 1.009;
