use std::sync::Arc;

use wasm_bindgen::prelude::*;

pub(crate) mod fft;
mod temporal;

use crate::fft::SpectrumAnalyzer;
use rustfft::FftPlanner;

pub const DSP_CORE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const FEATURE_SCHEMA_VERSION: u32 = 1;
pub const FFT_SIZE: usize = 4096;
pub const IMPACT_SIZE: usize = 1024;
pub const BAND_COUNT: usize = 96;
pub const BIN_COUNT: usize = FFT_SIZE / 2 + 1;
pub const FEATURE_COUNT: usize = 7;
pub const MAX_CHANNELS: u32 = 2;
pub const MAX_SAMPLE_RATE: u32 = 192_000;

const RMS_MILLISECONDS: f64 = 20.0;
const DB_FACTOR: f64 = 20.0 / std::f64::consts::LN_10;

#[wasm_bindgen]
pub fn core_version() -> String {
    DSP_CORE_VERSION.to_owned()
}

#[wasm_bindgen]
pub fn feature_schema_version() -> u32 {
    FEATURE_SCHEMA_VERSION
}

/// Reusable, scalar f64 analysis for the trailing 4096-sample audio frame.
///
/// JavaScript owns the memory containing the exposed pointers for the lifetime
/// of this instance. All buffers are allocated in `new` and retain their
/// addresses until `free`; `analyze` does not resize or replace them.
#[wasm_bindgen]
pub struct FrameDsp {
    sample_rate: u32,
    channel_count: usize,
    rms_sample_count: usize,
    input: Vec<f32>,
    analyzers: Vec<SpectrumAnalyzer>,
    impact_analyzers: Vec<SpectrumAnalyzer>,
    features: [f64; FEATURE_COUNT],
    bands: Vec<f32>,
    amplitudes: Vec<f64>,
    db: Vec<f32>,
    feature_ranges: FeatureRanges,
    band_ranges: [BinRange; BAND_COUNT],
}

#[wasm_bindgen]
impl FrameDsp {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: u32, channel_count: u32) -> Result<FrameDsp, JsValue> {
        validate_config(sample_rate, channel_count).map_err(JsValue::from_str)?;

        let channel_count = channel_count as usize;
        let mut planner = FftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let impact_fft = planner.plan_fft_forward(IMPACT_SIZE);
        let analyzers = (0..channel_count)
            .map(|_| SpectrumAnalyzer::new(FFT_SIZE, Arc::clone(&fft)))
            .collect();
        let impact_analyzers = (0..channel_count)
            .map(|_| SpectrumAnalyzer::new(IMPACT_SIZE, Arc::clone(&impact_fft)))
            .collect();
        let rms_sample_count = ((sample_rate as f64 * RMS_MILLISECONDS / 1000.0) + 0.5)
            .floor()
            .max(1.0) as usize;

        Ok(Self {
            sample_rate,
            channel_count,
            rms_sample_count,
            input: vec![0.0; channel_count * FFT_SIZE],
            analyzers,
            impact_analyzers,
            features: [0.0; FEATURE_COUNT],
            bands: vec![0.0; channel_count * BAND_COUNT],
            amplitudes: vec![0.0; channel_count * BIN_COUNT],
            db: vec![f32::NEG_INFINITY; channel_count * BIN_COUNT],
            feature_ranges: FeatureRanges::new(sample_rate),
            band_ranges: make_visual_band_ranges(sample_rate),
        })
    }

    /// Pointer to channel-major Float32 input (`channel_count * FFT_SIZE`).
    /// Fill it with trailing samples and leading zeros before calling analyze.
    pub fn input_ptr(&mut self) -> usize {
        self.input.as_mut_ptr() as usize
    }

    pub fn input_len(&self) -> usize {
        self.input.len()
    }

    /// Feature order: rms, rmsDb, bassDb, bassHitDb, ringBassDb, middleDb, highDb.
    pub fn features_ptr(&mut self) -> usize {
        self.features.as_mut_ptr() as usize
    }

    pub fn features_len(&self) -> usize {
        self.features.len()
    }

    /// Channel-major bands, 96 values per channel.
    pub fn bands_ptr(&mut self) -> usize {
        self.bands.as_mut_ptr() as usize
    }

    pub fn bands_len(&self) -> usize {
        self.bands.len()
    }

    /// Channel-major Float64 magnitudes, 2049 values per channel.
    pub fn amplitudes_ptr(&mut self) -> usize {
        self.amplitudes.as_mut_ptr() as usize
    }

    pub fn amplitudes_len(&self) -> usize {
        self.amplitudes.len()
    }

    /// Channel-major Float32 dB values, 2049 values per channel.
    pub fn db_ptr(&mut self) -> usize {
        self.db.as_mut_ptr() as usize
    }

    pub fn db_len(&self) -> usize {
        self.db.len()
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channel_count(&self) -> u32 {
        self.channel_count as u32
    }

    /// Compute calibrated 4096 and impact 1024 spectra, RMS and legacy bands.
    /// This function uses only constructor-allocated buffers.
    pub fn analyze(&mut self) {
        let samples_per_channel = FFT_SIZE;
        for channel in 0..self.channel_count {
            let start = channel * samples_per_channel;
            let channel_input = &self.input[start..start + samples_per_channel];
            self.analyzers[channel].analyze(channel_input);
            self.impact_analyzers[channel].analyze(&channel_input[FFT_SIZE - IMPACT_SIZE..]);

            let spectrum_start = channel * BIN_COUNT;
            self.amplitudes[spectrum_start..spectrum_start + BIN_COUNT]
                .copy_from_slice(&self.analyzers[channel].amplitudes);
            self.db[spectrum_start..spectrum_start + BIN_COUNT]
                .copy_from_slice(&self.analyzers[channel].db);
        }

        let rms = recent_rms(&self.input, self.channel_count, self.rms_sample_count);
        let bass = band_power(
            self.amplitudes.chunks_exact(BIN_COUNT),
            self.channel_count,
            self.feature_ranges.bass,
        );
        let bass_hit = band_power(
            self.impact_analyzers
                .iter()
                .map(|analyzer| analyzer.amplitudes.as_slice()),
            self.channel_count,
            self.feature_ranges.bass_hit,
        );
        let ring_bass = band_power(
            self.amplitudes.chunks_exact(BIN_COUNT),
            self.channel_count,
            self.feature_ranges.ring_bass,
        );
        let middle = band_power(
            self.amplitudes.chunks_exact(BIN_COUNT),
            self.channel_count,
            self.feature_ranges.middle,
        );
        let high = band_power(
            self.amplitudes.chunks_exact(BIN_COUNT),
            self.channel_count,
            self.feature_ranges.high,
        );

        self.features = [
            rms,
            level_db(rms),
            level_db(bass.sqrt()),
            level_db(bass_hit.sqrt()),
            level_db(ring_bass.sqrt()),
            level_db(middle.sqrt()),
            level_db(high.sqrt()),
        ];

        write_bands(
            &mut self.bands,
            &self.db,
            self.channel_count,
            &self.band_ranges,
        );
    }
}

fn clean_sample(sample: f32) -> f64 {
    if sample.is_finite() {
        sample as f64
    } else {
        0.0
    }
}

fn recent_rms(input: &[f32], channel_count: usize, count: usize) -> f64 {
    let mut channel_power = 0.0;
    let first = FFT_SIZE.saturating_sub(count);
    for channel in 0..channel_count {
        let offset = channel * FFT_SIZE;
        let mut sum = 0.0;
        let mut squares = 0.0;
        for &sample in &input[offset + first..offset + FFT_SIZE] {
            let value = clean_sample(sample);
            sum += value;
            squares += value * value;
        }
        // The validated sample-rate limit keeps the complete 20 ms window in
        // the supplied 4096 samples; retain JS's full-count denominator.
        let denominator = count as f64;
        let mean = sum / denominator;
        channel_power += (squares / denominator - mean * mean).max(0.0);
    }
    (channel_power / channel_count as f64).sqrt()
}

#[derive(Clone, Copy)]
struct BinRange {
    first: usize,
    last: usize,
}

impl BinRange {
    fn new(size: usize, sample_rate: u32, low: f64, high: f64) -> Self {
        let first = ((low * size as f64 / sample_rate as f64).ceil() as usize).max(1);
        let last = ((high * size as f64 / sample_rate as f64).floor() as usize).min(size / 2 - 1);
        Self { first, last }
    }
}

struct FeatureRanges {
    bass: BinRange,
    bass_hit: BinRange,
    ring_bass: BinRange,
    middle: BinRange,
    high: BinRange,
}

impl FeatureRanges {
    fn new(sample_rate: u32) -> Self {
        Self {
            bass: BinRange::new(FFT_SIZE, sample_rate, 35.0, 180.0),
            bass_hit: BinRange::new(IMPACT_SIZE, sample_rate, 35.0, 180.0),
            ring_bass: BinRange::new(FFT_SIZE, sample_rate, 35.0, 450.0),
            middle: BinRange::new(FFT_SIZE, sample_rate, 180.0, 2500.0),
            high: BinRange::new(FFT_SIZE, sample_rate, 2500.0, 12_000.0),
        }
    }
}

fn band_power<'a>(
    spectra: impl IntoIterator<Item = &'a [f64]>,
    channel_count: usize,
    range: BinRange,
) -> f64 {
    if range.first > range.last {
        return 0.0;
    }
    let mut power = 0.0;
    for spectrum in spectra.into_iter().take(channel_count) {
        for bin in range.first..=range.last {
            let amplitude = spectrum[bin];
            power += amplitude * amplitude / 3.0;
        }
    }
    power / channel_count as f64
}

fn make_visual_band_ranges(sample_rate: u32) -> [BinRange; BAND_COUNT] {
    let top = (sample_rate as f64 / 2.0).min(16_000.0);
    let ratio = top / 35.0;
    std::array::from_fn(|index| {
        let low = 35.0 * ratio.powf(index as f64 / BAND_COUNT as f64);
        let high = 35.0 * ratio.powf((index + 1) as f64 / BAND_COUNT as f64);
        let mut first = ((low * FFT_SIZE as f64 / sample_rate as f64).ceil() as usize).max(1);
        let mut last =
            ((high * FFT_SIZE as f64 / sample_rate as f64).floor() as usize).min(BIN_COUNT - 1);
        if last < first {
            let nearest =
                ((low * high).sqrt() * FFT_SIZE as f64 / sample_rate as f64).round() as usize;
            first = nearest.max(1).min(BIN_COUNT - 1);
            last = first;
        }
        BinRange { first, last }
    })
}

fn write_bands(
    output: &mut [f32],
    db: &[f32],
    channel_count: usize,
    ranges: &[BinRange; BAND_COUNT],
) {
    for channel in 0..channel_count {
        let channel_db = &db[channel * BIN_COUNT..(channel + 1) * BIN_COUNT];
        let channel_bands = &mut output[channel * BAND_COUNT..(channel + 1) * BAND_COUNT];
        for (target, range) in channel_bands.iter_mut().zip(ranges) {
            let peak = channel_db[range.first..=range.last]
                .iter()
                .copied()
                .fold(f32::NEG_INFINITY, f32::max);
            *target = ((peak + 75.0) / 63.0).clamp(0.0, 1.0);
        }
    }
}

fn validate_config(sample_rate: u32, channel_count: u32) -> Result<(), &'static str> {
    if sample_rate == 0 || sample_rate > MAX_SAMPLE_RATE {
        return Err("sample_rate must be in 1..=192000");
    }
    if !(1..=MAX_CHANNELS).contains(&channel_count) {
        return Err("channel_count must be in 1..=2");
    }
    Ok(())
}

fn level_db(value: f64) -> f64 {
    if value > 0.0 {
        DB_FACTOR * value.ln()
    } else {
        -160.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dsp(rate: u32, channels: u32) -> FrameDsp {
        FrameDsp::new(rate, channels).expect("valid analyzer configuration")
    }

    fn fill_tone(input: &mut [f32], rate: u32, frequency: f64, amplitude: f32) {
        for (index, value) in input.iter_mut().enumerate() {
            *value = amplitude
                * (2.0 * std::f64::consts::PI * frequency * index as f64 / rate as f64).sin()
                    as f32;
        }
    }

    #[test]
    fn calibrated_sine_produces_finite_spectrum_and_expected_band_shape() {
        let mut frame = dsp(48_000, 1);
        fill_tone(&mut frame.input, 48_000, 1_007.8125, 0.5);
        frame.analyze();

        let peak = frame.amplitudes[1..BIN_COUNT - 1]
            .iter()
            .copied()
            .fold(0.0_f64, f64::max);
        assert!((peak - 0.5).abs() < 0.02, "calibrated peak was {peak}");
        assert!((frame.features[0] - 0.5 / 2.0_f64.sqrt()).abs() < 0.015);
        assert!(frame.features[2] < -35.0);
        assert_eq!(frame.bands.len(), BAND_COUNT);
        assert!(frame
            .bands
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value)));
        assert!(frame.amplitudes.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn dc_and_silence_have_no_ac_rms_or_fabricated_band_level() {
        let mut frame = dsp(48_000, 1);
        frame.input.fill(0.75);
        frame.analyze();
        assert_eq!(frame.features[0], 0.0);
        assert_eq!(frame.features[1], -160.0);
        assert!(frame.features[2] < -120.0);
        assert!(frame.bands.iter().all(|value| *value == 0.0));

        frame.input.fill(0.0);
        frame.analyze();
        assert_eq!(frame.features[3], -160.0);
        assert!(frame
            .db
            .iter()
            .all(|value| value.is_infinite() && value.is_sign_negative()));
    }

    #[test]
    fn stereo_power_average_preserves_opposite_phase_and_channel_independence() {
        let mut mono = dsp(48_000, 1);
        fill_tone(&mut mono.input, 48_000, 120.0, 0.3);
        mono.analyze();

        let mut stereo = dsp(48_000, 2);
        fill_tone(&mut stereo.input[..FFT_SIZE], 48_000, 120.0, 0.3);
        for index in 0..FFT_SIZE {
            stereo.input[FFT_SIZE + index] = -stereo.input[index];
        }
        stereo.analyze();

        assert!((stereo.features[2] - mono.features[2]).abs() < 1e-10);
        assert!((stereo.features[0] - mono.features[0]).abs() < 1e-7);
        assert!(stereo.amplitudes[..BIN_COUNT]
            .iter()
            .zip(&stereo.amplitudes[BIN_COUNT..])
            .all(|(left, right)| (left - right).abs() < 1e-12));
        assert_eq!(&stereo.bands[..BAND_COUNT], &stereo.bands[BAND_COUNT..]);
    }

    #[test]
    fn non_finite_values_are_silence_and_short_leading_edges_are_zero_padded() {
        let mut frame = dsp(48_000, 1);
        frame.input.fill(f32::NAN);
        frame.input[FFT_SIZE - 512..].fill(0.25);
        frame.analyze();
        assert!(frame.features.iter().all(|value| value.is_finite()));
        assert!(frame.amplitudes.iter().all(|value| value.is_finite()));
        assert!(frame.features[0] > 0.0);
        assert!(frame.features[0] < 0.18);
    }

    #[test]
    fn dimensions_and_configuration_are_bounded() {
        assert!(validate_config(0, 1).is_err());
        assert!(validate_config(MAX_SAMPLE_RATE + 1, 1).is_err());
        assert!(validate_config(48_000, 0).is_err());
        assert!(validate_config(48_000, MAX_CHANNELS + 1).is_err());

        let frame = dsp(96_000, 2);
        assert_eq!(frame.input_len(), 2 * FFT_SIZE);
        assert_eq!(frame.features_len(), FEATURE_COUNT);
        assert_eq!(frame.bands_len(), 2 * BAND_COUNT);
        assert_eq!(frame.amplitudes_len(), 2 * BIN_COUNT);
        assert_eq!(frame.db_len(), 2 * BIN_COUNT);
    }
}
