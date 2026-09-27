import type { Viseme, VisemeWeights } from "../visemes.js";
import { textToVisemes, type WordVisemes } from "./english.js";

/** One viseme placed on the audio clock, in seconds. */
export interface TimelineKey {
  viseme: Viseme;
  start: number;
  end: number;
  wordIndex: number;
}

export interface TimelineWord {
  word: string;
  charIndex: number;
  start: number;
  end: number;
}

export interface LipSyncTimeline {
  keys: TimelineKey[];
  words: TimelineWord[];
  duration: number;
}

export interface BuildTimelineOptions {
  /** Seconds per relative unit (≈ one average phoneme). Default 0.075. */
  unitSeconds?: number;
  /** Speech rate multiplier (1 = normal). Divides unitSeconds. */
  rate?: number;
  /** Relative gap between words. Default 0.35. */
  wordGap?: number;
  /** If set, the timeline is stretched/compressed to exactly this length. */
  duration?: number;
  /**
   * Voiced regions detected in the real audio, as [start, end] seconds.
   * When provided, speech is laid out only inside these regions so the
   * mouth is closed during the pauses the TTS engine actually made.
   */
  voicedSegments?: Array<[number, number]>;
}

const DEFAULT_UNIT = 0.075;

/** Build a timeline from free text. */
export function buildTimelineFromText(text: string, opts: BuildTimelineOptions = {}): LipSyncTimeline {
  return buildTimeline(textToVisemes(text), opts);
}

export function buildTimeline(words: WordVisemes[], opts: BuildTimelineOptions = {}): LipSyncTimeline {
  const unit = (opts.unitSeconds ?? DEFAULT_UNIT) / (opts.rate ?? 1);
  const wordGap = opts.wordGap ?? 0.35;
  const segments = opts.voicedSegments?.filter(([s, e]) => e > s);

  if (segments && segments.length) {
    return layoutInSegments(words, segments);
  }

  const keys: TimelineKey[] = [];
  const outWords: TimelineWord[] = [];
  let t = 0;
  words.forEach((w, wordIndex) => {
    const wStart = t;
    for (const v of w.visemes) {
      keys.push({ viseme: v.viseme, start: t + v.start * unit, end: t + (v.start + v.duration) * unit, wordIndex });
    }
    t += w.duration * unit;
    outWords.push({ word: w.word, charIndex: w.charIndex, start: wStart, end: t });
    if (wordIndex < words.length - 1) t += (wordGap + w.pauseAfter) * unit;
  });

  const timeline: LipSyncTimeline = { keys, words: outWords, duration: t };
  if (opts.duration && t > 0) return scaleTimeline(timeline, opts.duration / t);
  return timeline;
}

export function scaleTimeline(tl: LipSyncTimeline, factor: number, offset = 0): LipSyncTimeline {
  return {
    keys: tl.keys.map((k) => ({ ...k, start: offset + k.start * factor, end: offset + k.end * factor })),
    words: tl.words.map((w) => ({ ...w, start: offset + w.start * factor, end: offset + w.end * factor })),
    duration: offset + tl.duration * factor,
  };
}

/**
 * Lay words out on "speech time" (pauses removed), then map speech time onto
 * the concatenated voiced segments of the real audio. Word-internal timing
 * is preserved proportionally; pauses fall where the audio is silent.
 */
function layoutInSegments(words: WordVisemes[], segments: Array<[number, number]>): LipSyncTimeline {
  const speechUnits: Array<{ w: WordVisemes; start: number }> = [];
  let u = 0;
  for (const w of words) {
    speechUnits.push({ w, start: u });
    u += w.duration + 0.2; // small intra-phrase gap keeps words distinct
  }
  const totalUnits = Math.max(u - 0.2, 1e-6);
  const voicedTotal = segments.reduce((acc, [s, e]) => acc + (e - s), 0);

  const toAudioTime = (units: number): number => {
    let voiced = (units / totalUnits) * voicedTotal;
    for (const [s, e] of segments) {
      const len = e - s;
      if (voiced <= len) return s + voiced;
      voiced -= len;
    }
    return segments[segments.length - 1]![1];
  };

  const keys: TimelineKey[] = [];
  const outWords: TimelineWord[] = [];
  speechUnits.forEach(({ w, start }, wordIndex) => {
    for (const v of w.visemes) {
      const s = toAudioTime(start + v.start);
      const e = toAudioTime(start + v.start + v.duration);
      keys.push({ viseme: v.viseme, start: s, end: Math.max(e, s + 0.03), wordIndex });
    }
    outWords.push({ word: w.word, charIndex: w.charIndex, start: toAudioTime(start), end: toAudioTime(start + w.duration) });
  });
  return { keys, words: outWords, duration: segments[segments.length - 1]![1] };
}

/** How strongly each viseme is expressed at full activation. */
export const VISEME_INTENSITY: Record<Viseme, number> = {
  sil: 0, PP: 0.9, FF: 0.75, TH: 0.6, DD: 0.55, kk: 0.55, CH: 0.7, SS: 0.55, nn: 0.55,
  RR: 0.6, aa: 0.85, E: 0.75, I: 0.7, O: 0.8, U: 0.8,
};

export interface SampleOptions {
  /** Cross-fade half-width in seconds (coarticulation). Default 0.045. */
  blend?: number;
  /** Global multiplier on all weights. Default 1. */
  gain?: number;
}

/**
 * Sample the timeline at time `t` (seconds). Neighbouring visemes are
 * cross-faded so the mouth moves continuously instead of snapping.
 * Keys are sorted by start time, so we binary-search for the first key that
 * could still be active.
 */
export function sampleTimeline(tl: LipSyncTimeline, t: number, opts: SampleOptions = {}): VisemeWeights {
  const blend = opts.blend ?? 0.045;
  const gain = opts.gain ?? 1;
  const out: VisemeWeights = {};
  const keys = tl.keys;
  if (!keys.length || t < keys[0]!.start - blend || t > tl.duration + blend) return out;

  let lo = 0;
  let hi = keys.length - 1;
  const target = t - 2 * blend - 1; // generous lower bound for long keys
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.end < target) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 2); i < keys.length; i++) {
    const k = keys[i]!;
    if (k.start - blend > t) break;
    if (k.end + blend < t) continue;
    const up = smoothstep(k.start - blend, k.start + blend, t);
    const down = 1 - smoothstep(k.end - blend, k.end + blend, t);
    const w = Math.min(up, down) * VISEME_INTENSITY[k.viseme] * gain;
    if (w > (out[k.viseme] ?? 0)) out[k.viseme] = w;
  }
  return out;
}

/** Index of the word being spoken at time t, or -1. */
export function wordAt(tl: LipSyncTimeline, t: number): number {
  return tl.words.findIndex((w) => t >= w.start && t <= w.end);
}

function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
