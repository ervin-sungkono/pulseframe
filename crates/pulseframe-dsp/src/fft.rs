use std::sync::Arc;

use rustfft::{num_complex::Complex, Fft};

use crate::clean_sample;

/// Reusable periodic-Hann FFT analyzer with f64 scalar scratch and output.
pub(crate) struct SpectrumAnalyzer {
    size: usize,
    fft: Arc<dyn Fft<f64>>,
    scratch: Vec<Complex<f64>>,
    work: Vec<Complex<f64>>,
    window: Vec<f64>,
    window_sum: f64,
    pub(crate) amplitudes: Vec<f64>,
    pub(crate) db: Vec<f32>,
}

impl SpectrumAnalyzer {
    pub(crate) fn new(size: usize, fft: Arc<dyn Fft<f64>>) -> Self {
        let mut window = Vec::with_capacity(size);
        let mut window_sum = 0.0;
        for n in 0..size {
            let value = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / size as f64).cos();
            window.push(value);
            window_sum += value;
        }
        let bin_count = size / 2 + 1;
        let scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
        Self {
            size,
            fft,
            scratch,
            work: vec![Complex::default(); size],
            window,
            window_sum,
            amplitudes: vec![0.0; bin_count],
            db: vec![f32::NEG_INFINITY; bin_count],
        }
    }

    pub(crate) fn analyze(&mut self, input: &[f32]) {
        debug_assert_eq!(input.len(), self.size);
        for (index, (&sample, &window)) in input.iter().zip(&self.window).enumerate() {
            self.work[index] = Complex::new(clean_sample(sample) * window, 0.0);
        }
        self.fft
            .process_with_scratch(&mut self.work, &mut self.scratch);

        for bin in 0..self.amplitudes.len() {
            let value = self.work[bin];
            // Avoid num-complex's generic norm path: with RustFFT's scalar
            // no-std feature set, that routed every bin through libm sqrt.
            // Inputs originate in f32 and the supported transform sizes are
            // at most 4096, so these f64 squares cannot overflow.
            let magnitude = (value.re * value.re + value.im * value.im).sqrt();
            let one_sided_scale = if bin == 0 || bin == self.size / 2 {
                1.0
            } else {
                2.0
            };
            let amplitude = one_sided_scale * magnitude / self.window_sum;
            self.amplitudes[bin] = amplitude;
            self.db[bin] = amplitude_db_f32(amplitude);
        }
    }
}

fn amplitude_db_f32(value: f64) -> f32 {
    if value > 0.0 {
        (20.0 / std::f64::consts::LN_10 * value.ln()) as f32
    } else {
        f32::NEG_INFINITY
    }
}
