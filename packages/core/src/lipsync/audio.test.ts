import { describe, expect, it } from "vitest";
import { computeEnvelope, envelopeAt, findVoicedSegments, visemesFromSpectrum } from "./audio.js";

function tone(sampleRate: number, pattern: Array<[number, boolean]>): Float32Array {
  const total = pattern.reduce((a, [d]) => a + d, 0);
  const out = new Float32Array(Math.round(total * sampleRate));
  let i = 0;
  for (const [d, on] of pattern) {
    const n = Math.round(d * sampleRate);
    for (let j = 0; j < n; j++, i++) out[i] = on ? 0.5 * Math.sin((2 * Math.PI * 220 * i) / sampleRate) : 0;
  }
  return out;
}

describe("audio envelope", () => {
  const sr = 16000;
  const samples = tone(sr, [[0.3, false], [0.5, true], [0.4, false], [0.6, true], [0.2, false]]);
  const env = computeEnvelope(samples, sr);

  it("normalises to 0..1", () => {
    const max = Math.max(...env.values);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(0.9);
    expect(envelopeAt(env, 0.1)).toBe(0);
  });

  it("finds voiced segments", () => {
    const segs = findVoicedSegments(env);
    expect(segs).toHaveLength(2);
    expect(segs[0]![0]).toBeCloseTo(0.3, 1);
    expect(segs[1]![1]).toBeCloseTo(1.8, 1);
  });
});

describe("visemesFromSpectrum", () => {
  it("returns nothing for silence", () => {
    expect(visemesFromSpectrum(new Uint8Array(512), 48000)).toEqual({});
  });

  it("opens the mouth for loud mid-band energy", () => {
    const spec = new Uint8Array(512).fill(200);
    const w = visemesFromSpectrum(spec, 48000);
    expect((w.aa ?? 0) + (w.O ?? 0) + (w.E ?? 0)).toBeGreaterThan(0.3);
  });
});
