use std::sync::Arc;

use rustfft::FftPlanner;
use wasm_bindgen::prelude::*;

use crate::fft::SpectrumAnalyzer;

pub(crate) const TEMPORAL_FFT_SIZE: usize = 2048;
pub(crate) const TEMPORAL_HOP_SIZE: usize = 512;
const SPECTRUM_BINS: usize = TEMPORAL_FFT_SIZE / 2 + 1;
const OUTPUT_COUNT: usize = 7;
const HISTORY_SECONDS: usize = 8;
const MIN_TEMPO_BPM: f64 = 50.0;
const MAX_TEMPO_BPM: f64 = 180.0;
const REFRACTORY_SECONDS: f64 = 0.09;
const ONSET_THRESHOLD_FLOOR: f64 = 0.015;
const ONSET_THRESHOLD_MULTIPLIER: f64 = 2.5;
const ONSET_THRESHOLD_MARGIN: f64 = 0.005;
const MAX_RECENT_ONSETS: usize = 128;
const MIN_AUTOCORRELATION: f64 = 0.2;

/// Optional stateful spectral-flux and tempo analysis.
///
/// `input_ptr` addresses one chronological 2048-sample, mono window whose
/// exclusive end is given to `observe`. Call once per 512-sample hop. A
/// repeated, backwards, or non-adjacent sample position clears detector state
/// before that frame is consumed. Output order is spectral flux, onset time in
/// seconds (or -1), onset strength, coarse tempo BPM (or 0), beat phase, tempo
/// confidence, and causal latency in seconds. Tempo can be half/double
/// ambiguous; confidence is reduced when a related period is also strong.
#[wasm_bindgen]
pub struct TemporalDsp {
    sample_rate: u32,
    input: Vec<f32>,
    output: [f64; OUTPUT_COUNT],
    analyzer: SpectrumAnalyzer,
    previous_spectrum: Vec<f64>,
    has_previous_spectrum: bool,
    last_end_sample: Option<u32>,
    novelty_history: Vec<f64>,
    novelty_next: usize,
    novelty_len: usize,
    flux_steps: u64,
    previous_flux: f64,
    older_flux: f64,
    previous_flux_sample: u32,
    last_onset_sample: Option<u32>,
    onset_samples: [u32; MAX_RECENT_ONSETS],
    onset_next: usize,
    onset_len: usize,
    autocorrelation_scores: Vec<f64>,
    tempo_update_interval: u64,
    tempo_bpm: f64,
    tempo_confidence: f64,
    beat_anchor_sample: Option<u32>,
}

#[wasm_bindgen]
impl TemporalDsp {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32) -> Result<TemporalDsp, JsValue> {
        if let Err(message) = validate_sample_rate(sample_rate) {
            return Err(JsValue::from_str(message));
        }

        let mut planner = FftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(TEMPORAL_FFT_SIZE);
        let analyzer = SpectrumAnalyzer::new(TEMPORAL_FFT_SIZE, Arc::clone(&fft));
        let history_capacity =
            ((sample_rate as usize * HISTORY_SECONDS).div_ceil(TEMPORAL_HOP_SIZE)).max(1);
        let max_tempo_lag = ((60.0 * sample_rate as f64)
            / (MIN_TEMPO_BPM * TEMPORAL_HOP_SIZE as f64))
            .ceil() as usize;
        let tempo_update_interval =
            ((sample_rate as u64 * 80).div_ceil(TEMPORAL_HOP_SIZE as u64 * 1000)).max(1);

        Ok(Self {
            sample_rate,
            input: vec![0.0; TEMPORAL_FFT_SIZE],
            output: [0.0, -1.0, 0.0, 0.0, 0.0, 0.0, latency_seconds(sample_rate)],
            analyzer,
            previous_spectrum: vec![0.0; SPECTRUM_BINS],
            has_previous_spectrum: false,
            last_end_sample: None,
            novelty_history: vec![0.0; history_capacity],
            novelty_next: 0,
            novelty_len: 0,
            flux_steps: 0,
            previous_flux: 0.0,
            older_flux: 0.0,
            previous_flux_sample: 0,
            last_onset_sample: None,
            onset_samples: [0; MAX_RECENT_ONSETS],
            onset_next: 0,
            onset_len: 0,
            autocorrelation_scores: vec![0.0; max_tempo_lag + 2],
            tempo_update_interval,
            tempo_bpm: 0.0,
            tempo_confidence: 0.0,
            beat_anchor_sample: None,
        })
    }

    /// Pointer to the chronological Float32 input window (2048 samples).
    pub fn input_ptr(&mut self) -> usize {
        self.input.as_mut_ptr() as usize
    }

    pub fn input_len(&self) -> usize {
        self.input.len()
    }

    /// Pointer to the seven Float64 output metrics.
    pub fn output_ptr(&mut self) -> usize {
        self.output.as_mut_ptr() as usize
    }

    pub fn output_len(&self) -> usize {
        self.output.len()
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Analyze one causal window ending at `end_sample`.
    ///
    /// Consecutive calls must advance by exactly one 512-sample hop. This
    /// method performs no heap allocation after construction.
    pub fn observe(&mut self, end_sample: u32) {
        if self.last_end_sample.is_some_and(|previous| {
            previous.checked_add(TEMPORAL_HOP_SIZE as u32) != Some(end_sample)
        }) {
            self.clear_state();
        }

        self.analyzer.analyze(&self.input);
        let flux = if self.has_previous_spectrum {
            positive_spectral_flux(&self.previous_spectrum, &self.analyzer.amplitudes)
        } else {
            0.0
        };
        self.previous_spectrum
            .copy_from_slice(&self.analyzer.amplitudes);
        self.has_previous_spectrum = true;

        let frame_center = end_sample.saturating_sub((TEMPORAL_FFT_SIZE / 2) as u32);
        let onset = self.observe_flux(flux, frame_center);
        self.last_end_sample = Some(end_sample);

        if let Some((onset_sample, _)) = onset {
            if self.tempo_bpm > 0.0 {
                self.beat_anchor_sample = Some(onset_sample);
            }
        }

        let phase = self.beat_phase(frame_center);
        self.output = [
            flux,
            onset.map_or(-1.0, |(sample, _)| sample as f64 / self.sample_rate as f64),
            onset.map_or(0.0, |(_, strength)| strength),
            self.tempo_bpm,
            phase,
            self.tempo_confidence,
            latency_seconds(self.sample_rate),
        ];
    }

    /// Clear all sequential detector state. The next observation is a warm-up
    /// frame and reports zero flux, no onset, and unknown tempo.
    pub fn reset(&mut self) {
        self.input.fill(0.0);
        self.clear_state();
    }
}

impl TemporalDsp {
    fn clear_state(&mut self) {
        self.has_previous_spectrum = false;
        self.last_end_sample = None;
        self.novelty_next = 0;
        self.novelty_len = 0;
        self.flux_steps = 0;
        self.previous_flux = 0.0;
        self.older_flux = 0.0;
        self.previous_flux_sample = 0;
        self.last_onset_sample = None;
        self.onset_next = 0;
        self.onset_len = 0;
        self.tempo_bpm = 0.0;
        self.tempo_confidence = 0.0;
        self.beat_anchor_sample = None;
        self.output = [
            0.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            latency_seconds(self.sample_rate),
        ];
    }

    fn observe_flux(&mut self, flux: f64, frame_center: u32) -> Option<(u32, f64)> {
        let mut onset = None;
        if self.flux_steps >= 2 {
            let baseline = self.recent_baseline();
            let threshold = (baseline * ONSET_THRESHOLD_MULTIPLIER + ONSET_THRESHOLD_MARGIN)
                .max(ONSET_THRESHOLD_FLOOR);
            let is_local_peak = self.previous_flux > self.older_flux && self.previous_flux >= flux;
            if is_local_peak && self.previous_flux > threshold {
                let refractory_samples =
                    (self.sample_rate as f64 * REFRACTORY_SECONDS).ceil() as u32;
                let refractory_samples = refractory_samples.max(TEMPORAL_HOP_SIZE as u32);
                let outside_refractory = self.last_onset_sample.is_none_or(|last| {
                    self.previous_flux_sample.saturating_sub(last) >= refractory_samples
                });
                if outside_refractory {
                    let onset_sample = self.previous_flux_sample;
                    self.last_onset_sample = Some(onset_sample);
                    self.record_onset(onset_sample);
                    onset = Some((onset_sample, self.previous_flux));
                }
            }
        }

        self.older_flux = self.previous_flux;
        self.previous_flux = flux;
        self.previous_flux_sample = frame_center;
        self.push_novelty(flux);
        self.flux_steps = self.flux_steps.saturating_add(1);

        if self.flux_steps % self.tempo_update_interval == 0 {
            self.update_tempo(frame_center);
        }
        onset
    }

    fn recent_baseline(&self) -> f64 {
        let frames = (self.sample_rate as usize)
            .div_ceil(TEMPORAL_HOP_SIZE)
            .max(1)
            .min(self.novelty_len.saturating_sub(2));
        if frames == 0 {
            return 0.0;
        }
        let mut sum = 0.0;
        // Exclude the two newest novelty values because one is being tested as
        // the peak and the other is its immediate left neighbor.
        for age in 2..frames + 2 {
            sum += self.novelty_at_age(age);
        }
        sum / frames as f64
    }

    fn push_novelty(&mut self, novelty: f64) {
        self.novelty_history[self.novelty_next] = novelty;
        self.novelty_next = (self.novelty_next + 1) % self.novelty_history.len();
        self.novelty_len = (self.novelty_len + 1).min(self.novelty_history.len());
    }

    /// Read novelty with age zero meaning the newest sample.
    fn novelty_at_age(&self, age: usize) -> f64 {
        let index =
            (self.novelty_next + self.novelty_history.len() - 1 - age) % self.novelty_history.len();
        self.novelty_history[index]
    }

    fn record_onset(&mut self, sample: u32) {
        self.onset_samples[self.onset_next] = sample;
        self.onset_next = (self.onset_next + 1) % self.onset_samples.len();
        self.onset_len = (self.onset_len + 1).min(self.onset_samples.len());
    }

    fn recent_onset_count(&self, now_sample: u32) -> usize {
        let history_samples =
            (self.sample_rate as u64 * HISTORY_SECONDS as u64).min(u32::MAX as u64) as u32;
        self.onset_samples
            .iter()
            .take(self.onset_len)
            .filter(|&&sample| now_sample.saturating_sub(sample) <= history_samples)
            .count()
    }

    fn update_tempo(&mut self, now_sample: u32) {
        let min_frames = ((self.sample_rate as usize * 4).div_ceil(TEMPORAL_HOP_SIZE)).max(1);
        let frame_count = self.novelty_len;
        if frame_count < min_frames || self.recent_onset_count(now_sample) < 4 {
            self.tempo_bpm = 0.0;
            self.tempo_confidence = 0.0;
            self.beat_anchor_sample = None;
            return;
        }

        let min_lag = ((60.0 * self.sample_rate as f64)
            / (MAX_TEMPO_BPM * TEMPORAL_HOP_SIZE as f64))
            .ceil()
            .max(2.0) as usize;
        let max_lag = (((60.0 * self.sample_rate as f64)
            / (MIN_TEMPO_BPM * TEMPORAL_HOP_SIZE as f64))
            .floor() as usize)
            .min(frame_count / 2);
        if max_lag <= min_lag || self.autocorrelation_scores.len() <= max_lag {
            self.tempo_bpm = 0.0;
            self.tempo_confidence = 0.0;
            self.beat_anchor_sample = None;
            return;
        }

        let mean = (0..frame_count)
            .map(|age| self.novelty_at_age(age))
            .sum::<f64>()
            / frame_count as f64;
        let centered_energy = (0..frame_count)
            .map(|age| {
                let value = self.novelty_at_age(age) - mean;
                value * value
            })
            .sum::<f64>();
        if !centered_energy.is_finite() || centered_energy <= 1e-16 {
            self.tempo_bpm = 0.0;
            self.tempo_confidence = 0.0;
            self.beat_anchor_sample = None;
            return;
        }

        let mut max_score = 0.0;
        let mut max_score_lag = 0usize;
        self.autocorrelation_scores.fill(0.0);
        for lag in min_lag..=max_lag {
            let mut cross = 0.0;
            let mut left_energy = 0.0;
            let mut right_energy = 0.0;
            for age in 0..frame_count - lag {
                let left = self.novelty_at_age(age) - mean;
                let right = self.novelty_at_age(age + lag) - mean;
                cross += left * right;
                left_energy += left * left;
                right_energy += right * right;
            }
            let denominator = (left_energy * right_energy).sqrt();
            let score = if denominator > 1e-16 {
                (cross / denominator).clamp(0.0, 1.0)
            } else {
                0.0
            };
            self.autocorrelation_scores[lag] = score;

            // Prefer the faster interpretation when two periods are nearly
            // equivalent. The confidence penalty below keeps that choice
            // explicitly uncertain when the half/double alternative fits.
            if score > max_score {
                max_score = score;
                max_score_lag = lag;
            }
        }

        let best_score = max_score;
        let best_lag = (min_lag..=max_lag)
            .find(|&lag| self.autocorrelation_scores[lag] >= best_score * 0.97)
            .unwrap_or(max_score_lag);

        if best_lag == 0 || best_score < MIN_AUTOCORRELATION {
            self.tempo_bpm = 0.0;
            self.tempo_confidence = best_score.clamp(0.0, 1.0);
            self.beat_anchor_sample = None;
            return;
        }

        let mut refined_lag = best_lag as f64;
        if best_lag > min_lag && best_lag < max_lag {
            let before = self.autocorrelation_scores[best_lag - 1];
            let center = self.autocorrelation_scores[best_lag];
            let after = self.autocorrelation_scores[best_lag + 1];
            let curvature = before - 2.0 * center + after;
            if curvature < -1e-12 {
                refined_lag += (0.5 * (before - after) / curvature).clamp(-0.5, 0.5);
            }
        }

        let half_lag = (best_lag / 2).max(1);
        let double_lag = best_lag.saturating_mul(2);
        let half_score = if half_lag >= min_lag {
            self.autocorrelation_scores[half_lag]
        } else {
            0.0
        };
        let double_score = if double_lag <= max_lag {
            self.autocorrelation_scores[double_lag]
        } else {
            0.0
        };
        let harmonic_score = half_score.max(double_score);
        let ambiguity_ratio = if best_score > 0.0 {
            (harmonic_score / best_score).clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.tempo_bpm = (60.0 * self.sample_rate as f64
            / (refined_lag * TEMPORAL_HOP_SIZE as f64))
            .clamp(MIN_TEMPO_BPM, MAX_TEMPO_BPM);
        self.tempo_confidence = (best_score * (1.0 - 0.55 * ambiguity_ratio)).clamp(0.0, 1.0);
    }

    fn beat_phase(&self, frame_center: u32) -> f64 {
        let Some(anchor) = self.beat_anchor_sample else {
            return 0.0;
        };
        if self.tempo_bpm <= 0.0 {
            return 0.0;
        }
        let period_samples = 60.0 * self.sample_rate as f64 / self.tempo_bpm;
        if period_samples <= 0.0 || !period_samples.is_finite() {
            return 0.0;
        }
        ((frame_center as f64 - anchor as f64) / period_samples).rem_euclid(1.0)
    }
}

fn positive_spectral_flux(previous: &[f64], current: &[f64]) -> f64 {
    let mut positive_change = 0.0;
    let mut previous_energy = 0.0;
    let mut current_energy = 0.0;
    // Ignore DC while retaining the Nyquist bin. Both spectra come from the
    // shared periodic-Hann, coherent-gain calibrated f64 analyzer.
    for (&before, &after) in previous.iter().zip(current).skip(1) {
        previous_energy += before;
        current_energy += after;
        positive_change += (after - before).max(0.0);
    }
    let scale = previous_energy.max(current_energy).max(1e-15);
    (positive_change / scale).clamp(0.0, 1.0)
}

fn latency_seconds(sample_rate: u32) -> f64 {
    (TEMPORAL_FFT_SIZE / 2 + TEMPORAL_HOP_SIZE) as f64 / sample_rate as f64
}

fn validate_sample_rate(sample_rate: u32) -> Result<(), &'static str> {
    if sample_rate == 0 || sample_rate > crate::MAX_SAMPLE_RATE {
        Err("sample_rate must be in 1..=192000")
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dsp(sample_rate: u32) -> TemporalDsp {
        TemporalDsp::new(sample_rate).expect("valid temporal analyzer configuration")
    }

    fn observe_signal(dsp: &mut TemporalDsp, end_sample: u32, signal: impl Fn(u32) -> f32) {
        let window_start = end_sample.saturating_sub(TEMPORAL_FFT_SIZE as u32);
        for (offset, target) in dsp.input.iter_mut().enumerate() {
            let absolute_sample = window_start.saturating_add(offset as u32);
            *target = signal(absolute_sample);
        }
        dsp.observe(end_sample);
    }

    fn observe_zeroed(dsp: &mut TemporalDsp, end_sample: u32) {
        dsp.input.fill(0.0);
        dsp.observe(end_sample);
    }

    fn click_train(period: u32, first_click: u32) -> impl Fn(u32) -> f32 {
        move |sample| {
            if sample >= first_click && (sample - first_click) % period == 0 {
                0.8
            } else {
                0.0
            }
        }
    }

    #[test]
    fn silence_dc_and_steady_tone_have_no_spurious_onsets_or_tempo() {
        let mut silence = dsp(48_000);
        for end in (TEMPORAL_FFT_SIZE as u32..48_000 * 6).step_by(TEMPORAL_HOP_SIZE) {
            observe_zeroed(&mut silence, end);
            assert_eq!(silence.output[0], 0.0);
            assert_eq!(silence.output[1], -1.0);
            assert_eq!(silence.output[3], 0.0);
            assert_eq!(silence.output[5], 0.0);
        }

        for signal in [
            Box::new(|_| 0.75_f32) as Box<dyn Fn(u32) -> f32>,
            Box::new(|sample| {
                (0.4 * (2.0 * std::f64::consts::PI * 750.0 * sample as f64 / 48_000.0).sin()) as f32
            }),
        ] {
            let mut analyzer = dsp(48_000);
            for end in (TEMPORAL_FFT_SIZE as u32..48_000 * 6).step_by(TEMPORAL_HOP_SIZE) {
                observe_signal(&mut analyzer, end, &signal);
                assert!(analyzer.output[0].is_finite() && analyzer.output[0] < 1e-8);
                assert_eq!(analyzer.output[1], -1.0);
                assert_eq!(analyzer.output[3], 0.0);
            }
        }
    }

    #[test]
    fn click_track_produces_causally_timed_onsets_and_coarse_tempo_at_both_rates() {
        for sample_rate in [44_100_u32, 48_000] {
            let mut analyzer = dsp(sample_rate);
            let period = sample_rate / 2;
            let first_click = sample_rate / 4;
            let clicks = click_train(period, first_click);
            let final_sample = sample_rate * 12;
            let mut onset_samples = Vec::new();
            for end in (TEMPORAL_FFT_SIZE as u32..final_sample).step_by(TEMPORAL_HOP_SIZE) {
                observe_signal(&mut analyzer, end, &clicks);
                if analyzer.output[1] >= 0.0 {
                    onset_samples.push((analyzer.output[1] * sample_rate as f64).round() as u32);
                }
                assert!(analyzer.output.iter().all(|value| value.is_finite()));
                assert!((0.0..=1.0).contains(&analyzer.output[0]));
                assert!((0.0..=1.0).contains(&analyzer.output[2]));
                assert!((0.0..=1.0).contains(&analyzer.output[4]));
                assert!((0.0..=1.0).contains(&analyzer.output[5]));
            }

            assert!(
                onset_samples.len() >= 8,
                "detected {} onsets at {sample_rate} Hz",
                onset_samples.len()
            );
            for onset in onset_samples.iter().copied().skip(1) {
                let beat_index =
                    ((onset as i64 - first_click as i64) as f64 / period as f64).round();
                let expected = (first_click as f64 + beat_index * period as f64).max(0.0) as u32;
                let error = onset.abs_diff(expected);
                assert!(
                    error <= (TEMPORAL_HOP_SIZE * 2) as u32,
                    "onset error {error} samples at {sample_rate} Hz"
                );
            }

            let tempo = analyzer.output[3];
            assert!(
                (tempo - 120.0).abs() < 12.0 || (tempo - 60.0).abs() < 6.0,
                "coarse click tempo was {tempo} BPM at {sample_rate} Hz"
            );
            assert!(
                analyzer.output[5] < 0.75,
                "equal clicks should retain half/double uncertainty"
            );
            assert!((analyzer.output[6] - latency_seconds(sample_rate)).abs() < 1e-12);
        }
    }

    #[test]
    fn silence_dropout_does_not_create_onsets_and_metrics_stay_bounded() {
        let sample_rate = 48_000_u32;
        let mut analyzer = dsp(sample_rate);
        let period = sample_rate / 2;
        let first_click = sample_rate / 4;
        let clicks = click_train(period, first_click);
        let mut dropout_onsets = 0;
        for end in (TEMPORAL_FFT_SIZE as u32..sample_rate * 11).step_by(TEMPORAL_HOP_SIZE) {
            observe_signal(&mut analyzer, end, |sample| {
                if (sample_rate * 5..sample_rate * 7).contains(&sample) {
                    0.0
                } else {
                    clicks(sample)
                }
            });
            let timestamp = analyzer.output[1];
            if (5.0..7.0).contains(&timestamp) {
                dropout_onsets += 1;
            }
            assert!(analyzer.output.iter().all(|value| value.is_finite()));
            assert!((0.0..=1.0).contains(&analyzer.output[0]));
            assert!((0.0..=1.0).contains(&analyzer.output[2]));
            assert!((0.0..=1.0).contains(&analyzer.output[4]));
            assert!((0.0..=1.0).contains(&analyzer.output[5]));
        }
        assert_eq!(dropout_onsets, 0);
        assert!(analyzer.output[3] == 0.0 || analyzer.output[3].is_finite());
    }

    #[test]
    fn repeated_backwards_and_non_hop_positions_reset_state() {
        let mut analyzer = dsp(48_000);
        observe_signal(&mut analyzer, 2048, |_| 0.5);
        observe_signal(&mut analyzer, 2560, |_| 0.5);

        observe_signal(&mut analyzer, 2560, |_| 0.5);
        assert_eq!(analyzer.output[0], 0.0);
        assert_eq!(analyzer.output[1], -1.0);
        assert_eq!(analyzer.output[3], 0.0);
        assert_eq!(analyzer.output[5], 0.0);

        observe_signal(&mut analyzer, 3072, |_| 0.5);
        observe_signal(&mut analyzer, 2600, |_| 0.5);
        assert_eq!(analyzer.output[0], 0.0);
        assert_eq!(analyzer.output[1], -1.0);
        assert_eq!(analyzer.output[3], 0.0);

        observe_signal(&mut analyzer, 3112, |_| 0.5);
        assert_eq!(analyzer.output[0], 0.0);
        assert_eq!(analyzer.output[1], -1.0);
    }

    #[test]
    fn explicit_reset_and_pointer_contract_are_bounded() {
        assert!(validate_sample_rate(0).is_err());
        assert!(validate_sample_rate(crate::MAX_SAMPLE_RATE + 1).is_err());
        assert!(validate_sample_rate(48_000).is_ok());
        let mut analyzer = dsp(48_000);
        assert_eq!(analyzer.input_len(), TEMPORAL_FFT_SIZE);
        assert_eq!(analyzer.output_len(), OUTPUT_COUNT);
        assert_eq!(analyzer.sample_rate(), 48_000);
        observe_signal(&mut analyzer, 2048, |_| 0.25);
        analyzer.reset();
        assert!(analyzer.input.iter().all(|&sample| sample == 0.0));
        assert_eq!(analyzer.output[0], 0.0);
        assert_eq!(analyzer.output[1], -1.0);
        assert_eq!(analyzer.output[3], 0.0);
        assert_eq!(analyzer.output[6], latency_seconds(48_000));
    }

    #[test]
    fn non_finite_and_extreme_input_samples_keep_metrics_finite_and_bounded() {
        for value in [f32::NAN, f32::INFINITY, f32::MAX] {
            let mut analyzer = dsp(48_000);
            analyzer.input.fill(value);
            analyzer.observe(2048);
            analyzer.input.fill(value);
            analyzer.observe(2560);
            assert!(analyzer.output.iter().all(|metric| metric.is_finite()));
            assert!((0.0..=1.0).contains(&analyzer.output[0]));
            assert_eq!(analyzer.output[1], -1.0);
            assert!((0.0..=1.0).contains(&analyzer.output[2]));
            assert!((0.0..=MAX_TEMPO_BPM).contains(&analyzer.output[3]));
            assert!((0.0..=1.0).contains(&analyzer.output[4]));
            assert!((0.0..=1.0).contains(&analyzer.output[5]));
        }
    }
}
