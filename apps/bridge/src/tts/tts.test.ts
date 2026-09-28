import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type VoiceSettings } from "@agentar/core";
import { XaiTts } from "./cloud.js";
import { EdgeTts, edgeRate, parseEdgeVoices } from "./edge.js";
import { chooseFallback } from "./fallback.js";

const voice = (patch: Partial<VoiceSettings> = {}): VoiceSettings => ({ ...DEFAULT_CONFIG.voice, ...patch });

describe("parseEdgeVoices", () => {
  it("parses the edge-tts voice table", () => {
    const out = [
      "Name                               Gender    ContentCategories      VoicePersonalities",
      "---------------------------------  --------  ---------------------  --------------------------------------",
      "en-US-AriaNeural                   Female    News, Novel            Positive, Confident",
      "en-US-AndrewMultilingualNeural     Male      Conversation, Copilot  Warm, Confident, Authentic, Honest",
      "zh-CN-liaoning-XiaobeiNeural       Female    Dialect                Humorous",
      "",
    ].join("\n");
    expect(parseEdgeVoices(out)).toEqual([
      { id: "en-US-AriaNeural", name: "Aria, female", language: "en-US" },
      { id: "en-US-AndrewMultilingualNeural", name: "Andrew Multilingual, male", language: "en-US" },
      { id: "zh-CN-liaoning-XiaobeiNeural", name: "Xiaobei, female", language: "zh-CN-liaoning" },
    ]);
  });
});

describe("chooseFallback", () => {
  const status = (patch: Partial<Parameters<typeof chooseFallback>[1]> = {}) => ({ systemMissing: true, edgeReady: false, viaFallback: false, ...patch });

  it("moves a missing system engine to edge-tts when it is installed", () => {
    expect(chooseFallback("system", status({ edgeReady: true }))).toBe("edge");
  });

  it("moves a missing system engine to the browser when edge-tts is not installed", () => {
    expect(chooseFallback("system", status())).toBe("browser");
  });

  it("keeps the error when the system engine is installed but failed", () => {
    expect(chooseFallback("system", status({ systemMissing: false, edgeReady: true }))).toBeNull();
  });

  it("moves a fallback edge-tts that fails on to the browser", () => {
    expect(chooseFallback("edge", status({ viaFallback: true }))).toBe("browser");
  });

  it("keeps the error for engines the user chose", () => {
    for (const p of ["edge", "openai", "elevenlabs", "xai"] as const) expect(chooseFallback(p, status())).toBeNull();
  });
});

describe("edgeRate", () => {
  it("formats the rate multiplier as a signed percentage", () => {
    expect(edgeRate(1)).toBe("+0%");
    expect(edgeRate(1.25)).toBe("+25%");
    expect(edgeRate(0.5)).toBe("-50%");
  });
});

describe("EdgeTts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentar-edge-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a missing binary", async () => {
    const reason = await new EdgeTts(join(dir, "missing")).unavailableReason();
    expect(reason).toMatch(/edge-tts/);
  });

  it("passes text through a file and returns MP3 audio", async () => {
    // A stand-in for edge-tts: saves its arguments and the text, then writes fake audio.
    const bin = join(dir, "edge-tts");
    await writeFile(
      bin,
      [
        "#!/bin/sh",
        `for a in "$@"; do echo "$a"; done > "${dir}/args"`,
        'for a in "$@"; do case "$a" in --file=*) cp "${a#--file=}" "' + dir + '/text";; --write-media=*) printf ID3fake > "${a#--write-media=}";; esac; done',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    const tts = new EdgeTts(bin);
    expect(await tts.unavailableReason()).toBeNull();

    const result = await tts.synthesize(`Don't "break" --this`, voice({ voice: "en-US-AriaNeural", rate: 1.2 }));
    expect(result).toEqual({ data: Buffer.from("ID3fake"), mime: "audio/mpeg" });
    expect(await readFile(join(dir, "text"), "utf8")).toBe(`Don't "break" --this`);
    const args = (await readFile(join(dir, "args"), "utf8")).trim().split("\n");
    expect(args).toContain("--rate=+20%");
    expect(args).toContain("--voice=en-US-AriaNeural");
  });
});

describe("XaiTts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("needs XAI_API_KEY", async () => {
    expect(await new XaiTts("").unavailableReason()).toMatch(/XAI_API_KEY/);
  });

  it("lists voices", async () => {
    const fetchMock = vi.fn(async () => Response.json({ voices: [{ voice_id: "eve", name: "Eve", language: "en" }, { voice_id: "rex", name: "Rex", language: null }] }));
    vi.stubGlobal("fetch", fetchMock);
    const voices = await new XaiTts("key", "https://xai.test/v1").listVoices();
    expect(voices).toEqual([
      { id: "eve", name: "Eve", language: "en" },
      { id: "rex", name: "Rex", language: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://xai.test/v1/tts/voices", { headers: { Authorization: "Bearer key" } });
  });

  it("requests MP3 speech with a clamped speed", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(Buffer.from("ID3fake")));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new XaiTts("key", "https://xai.test/v1").synthesize("Hello", voice({ voice: "ara", rate: 2 }));
    expect(result).toEqual({ data: Buffer.from("ID3fake"), mime: "audio/mpeg" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://xai.test/v1/tts");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Hello",
      voice_id: "ara",
      language: "auto",
      output_format: { codec: "mp3" },
      speed: 1.5,
    });
  });

  it("surfaces API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    await expect(new XaiTts("key").synthesize("Hi", voice())).rejects.toThrow(/xAI TTS failed \(401\): bad key/);
  });
});
