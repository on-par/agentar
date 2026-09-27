import type { VisemeWeights } from "../visemes.js";

/** Loudness envelope of an audio clip, normalised to 0..1. */
export interface AudioEnvelope {
  /** Normalised RMS per hop. */
  values: Float32Array;
  /** Seconds between samples in `values`. */
  hop: number;
  duration: number;
}

/**
 * Compute a normalised RMS envelope from mono PCM samples.
 * Normalises against the 95th percentile so a single plosive spike does not
 * make the rest of the clip look quiet.
 */
export function computeEnvelope(samples: Float32Array, sampleRate: number, hop = 0.01, window = 0.025): AudioEnvelope {
  const hopN = Math.max(1, Math.round(hop * sampleRate));
  const winN = Math.max(hopN, Math.round(window * sampleRate));
  const count = Math.max(1, Math.ceil(samples.length / hopN));
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const center = i * hopN;
    const from = Math.max(0, center - (winN >> 1));
    const to = Math.min(samples.length, from + winN);
    let sum = 0;
    for (let j = from; j < to; j++) {
      const s = samples[j]!;
      sum += s * s;
    }
    values[i] = Math.sqrt(sum / Math.max(1, to - from));
  }
  const sorted = Array.from(values).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let i = 0; i < count; i++) values[i] = Math.min(1, values[i]! / ref);
  return { values, hop, duration: samples.length / sampleRate };
}

/** Linear-interpolated envelope value at time t. */
export function envelopeAt(env: AudioEnvelope, t: number): number {
  const x = t / env.hop;
  const i = Math.floor(x);
  if (i < 0 || i >= env.values.length) return 0;
  const a = env.values[i]!;
  const b = env.values[Math.min(i + 1, env.values.length - 1)]!;
  return a + (b - a) * (x - i);
}

export interface VoicedSegmentOptions {
  /** Envelope level treated as voiced. Default 0.12. */
  threshold?: number;
  /** Silences shorter than this are bridged (seconds). Default 0.14. */
  minSilence?: number;
  /** Voiced blips shorter than this are dropped (seconds). Default 0.05. */
  minVoiced?: number;
}

/** Find [start, end] regions (seconds) where speech is audible. */
export function findVoicedSegments(env: AudioEnvelope, opts: VoicedSegmentOptions = {}): Array<[number, number]> {
  const threshold = opts.threshold ?? 0.12;
  const minSilence = opts.minSilence ?? 0.14;
  const minVoiced = opts.minVoiced ?? 0.05;
  const raw: Array<[number, number]> = [];
  let start = -1;
  env.values.forEach((v, i) => {
    const t = i * env.hop;
    if (v >= threshold && start < 0) start = t;
    else if (v < threshold && start >= 0) {
      raw.push([start, t]);
      start = -1;
    }
  });
  if (start >= 0) raw.push([start, env.duration]);

  const merged: Array<[number, number]> = [];
  for (const seg of raw) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] < minSilence) last[1] = seg[1];
    else merged.push([seg[0], seg[1]]);
  }
  return merged.filter(([s, e]) => e - s >= minVoiced);
}

/**
 * Text-free fallback: guess mouth shape from one FFT frame (e.g. from a Web
 * Audio AnalyserNode). Used when audio arrives without a transcript, such as
 * a live stream. Loudness drives jaw opening; the balance between low, mid
 * and high bands picks between rounded (O/U), open (aa/E) and spread (I/SS)
 * shapes.
 *
 * @param spectrum byte magnitudes (0..255) as from getByteFrequencyData
 * @param sampleRate context sample rate, to locate the bands
 */
export function visemesFromSpectrum(spectrum: Uint8Array, sampleRate: number): VisemeWeights {
  const binHz = sampleRate / 2 / spectrum.length;
  const band = (lo: number, hi: number): number => {
    const a = Math.max(0, Math.floor(lo / binHz));
    const b = Math.min(spectrum.length, Math.ceil(hi / binHz));
    let s = 0;
    for (let i = a; i < b; i++) s += spectrum[i]!;
    return b > a ? s / (b - a) / 255 : 0;
  };
  const low = band(80, 400);
  const mid = band(400, 2000);
  const high = band(2000, 6000);
  const energy = Math.min(1, (low + mid + high) / 1.2);
  if (energy < 0.08) return {};
  const total = low + mid + high + 1e-6;
  const open = Math.min(1, energy * 1.4);
  return {
    aa: open * (mid / total) * 1.3,
    O: open * (low / total) * 1.1,
    U: open * Math.max(0, low / total - 0.45),
    E: open * (high / total) * 0.8,
    I: open * Math.max(0, high / total - 0.3),
    SS: Math.max(0, high / total - 0.45) * 0.8,
  };
}
