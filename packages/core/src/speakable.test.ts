import { describe, expect, it } from "vitest";
import { toSpeakable } from "./speakable.js";

describe("toSpeakable", () => {
  it("strips markdown and summarises code", () => {
    const md = "## Done\n\nI updated **two** files:\n\n- `src/app.ts`\n- [docs](https://x.y/z)\n\n```ts\nconst a = 1;\n```";
    expect(toSpeakable(md)).toBe("Done. I updated two files: app.ts. docs. I've included a code snippet.");
  });

  it("replaces bare urls", () => {
    expect(toSpeakable("See https://example.com/page for more")).toBe("See a link for more");
  });

  it("truncates long replies at a sentence", () => {
    const long = "This is a sentence. ".repeat(100);
    const out = toSpeakable(long, { maxChars: 100 });
    expect(out.endsWith("The full details are in the chat.")).toBe(true);
    expect(out.length).toBeLessThan(150);
  });
});
