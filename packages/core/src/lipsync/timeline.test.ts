import { describe, expect, it } from "vitest";
import { buildTimelineFromText, sampleTimeline, wordAt } from "./timeline.js";

describe("buildTimelineFromText", () => {
  it("lays out keys in order with a positive duration", () => {
    const tl = buildTimelineFromText("Hello there, friend.");
    expect(tl.duration).toBeGreaterThan(0.3);
    for (let i = 1; i < tl.keys.length; i++) expect(tl.keys[i]!.start).toBeGreaterThanOrEqual(tl.keys[i - 1]!.start);
    expect(tl.words).toHaveLength(3);
  });

  it("scales to a target duration", () => {
    const tl = buildTimelineFromText("Testing one two three", { duration: 2 });
    expect(tl.duration).toBeCloseTo(2, 5);
    expect(tl.keys[tl.keys.length - 1]!.end).toBeLessThanOrEqual(2 + 1e-9);
  });

  it("speaks faster when rate is higher", () => {
    const slow = buildTimelineFromText("The quick brown fox", { rate: 1 });
    const fast = buildTimelineFromText("The quick brown fox", { rate: 2 });
    expect(fast.duration).toBeCloseTo(slow.duration / 2, 5);
  });

  it("places speech only inside voiced segments", () => {
    const segments: Array<[number, number]> = [[0.2, 1.0], [1.6, 2.4]];
    const tl = buildTimelineFromText("Hello world. How are you", { voicedSegments: segments });
    for (const k of tl.keys) {
      const inside = segments.some(([s, e]) => k.start >= s - 1e-9 && k.start <= e + 1e-9);
      expect(inside).toBe(true);
    }
    expect(tl.words[0]!.start).toBeCloseTo(0.2, 5);
  });
});

describe("sampleTimeline", () => {
  const tl = buildTimelineFromText("Papa", { duration: 1 });

  it("is silent before and after speech", () => {
    expect(sampleTimeline(tl, -1)).toEqual({});
    expect(sampleTimeline(tl, 5)).toEqual({});
  });

  it("activates the viseme under the playhead", () => {
    const first = tl.keys[0]!;
    const w = sampleTimeline(tl, (first.start + first.end) / 2);
    expect(w[first.viseme]).toBeGreaterThan(0.5);
  });

  it("finds the current word", () => {
    expect(wordAt(tl, 0.5)).toBe(0);
    expect(wordAt(tl, 3)).toBe(-1);
  });
});
