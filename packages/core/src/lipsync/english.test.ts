import { describe, expect, it } from "vitest";
import { normalizeForLipSync, textToVisemes, wordToVisemes } from "./english.js";

const shapes = (w: string) => wordToVisemes(w).visemes.map((v) => v.viseme);

describe("wordToVisemes", () => {
  it("maps bilabials to PP", () => {
    expect(shapes("mom")).toEqual(["PP", "aa", "PP"]);
    expect(shapes("bob")[0]).toBe("PP");
  });

  it("handles common function words", () => {
    expect(shapes("the")).toEqual(["TH", "aa"]);
    expect(shapes("you")).toEqual(["I", "U"]);
  });

  it("merges repeated visemes instead of re-triggering", () => {
    const { visemes } = wordToVisemes("SEE");
    expect(visemes.map((v) => v.viseme)).toEqual(["SS", "I"]);
  });

  it("produces monotonically increasing start times", () => {
    const { visemes, duration } = wordToVisemes("agentar");
    for (let i = 1; i < visemes.length; i++) expect(visemes[i]!.start).toBeGreaterThan(visemes[i - 1]!.start);
    expect(duration).toBeGreaterThan(0);
  });
});

describe("textToVisemes", () => {
  it("splits words and records punctuation pauses", () => {
    const words = textToVisemes("Hello, world. Bye");
    expect(words.map((w) => w.word)).toEqual(["Hello", "world", "Bye"]);
    expect(words[0]!.pauseAfter).toBeGreaterThan(0);
    expect(words[1]!.pauseAfter).toBeGreaterThan(words[0]!.pauseAfter);
    expect(words[2]!.pauseAfter).toBe(0);
  });

  it("speaks numbers and symbols", () => {
    expect(normalizeForLipSync("I have 42 apples & 3.5 pears")).toBe(
      "I have forty two apples and three point five pears",
    );
  });

  it("ignores markup characters", () => {
    expect(textToVisemes("`npm` **run**").map((w) => w.word)).toEqual(["npm", "run"]);
  });
});
