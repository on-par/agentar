import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findChrome, headlessChromeArgs, parseRecordArgs, recordClip, type RecordDeps, type RecordError } from "./record.js";

describe("parseRecordArgs", () => {
  it("parses the flags and resolves --out to an absolute path", () => {
    expect(parseRecordArgs(["--text-file", "intro.txt", "--out", "clip.webm", "--mood", "happy"])).toEqual({
      textFile: "intro.txt",
      out: resolve("clip.webm"),
      mood: "happy",
    });
  });

  it("requires --out", () => {
    expect(parseRecordArgs(["--text-file", "intro.txt"])).toEqual({ error: "Missing --out" });
  });

  it("requires --text-file", () => {
    expect(parseRecordArgs(["--out", "clip.webm"])).toEqual({ error: "Missing --text-file" });
  });

  it("rejects a flag with no value", () => {
    expect(parseRecordArgs(["--text-file", "intro.txt", "--out"])).toEqual({ error: "--out needs a value" });
    expect(parseRecordArgs(["--text-file", "--out", "clip.webm"])).toEqual({ error: "--text-file needs a value" });
  });

  it("rejects an unknown flag", () => {
    expect(parseRecordArgs(["--text-file", "a.txt", "--out", "b.webm", "--fps", "30"])).toEqual({ error: "Unknown option: --fps" });
  });

  it("rejects a bad mood", () => {
    expect(parseRecordArgs(["--text-file", "a.txt", "--out", "b.webm", "--mood", "grumpy"])).toEqual({ error: "Unknown mood: grumpy" });
  });
});

describe("findChrome", () => {
  it("prefers AGENTAR_CHROME even when it does not exist", () => {
    expect(findChrome({ AGENTAR_CHROME: "/opt/chrome" }, "linux", () => false)).toBe("/opt/chrome");
  });

  it("checks the darwin candidates in order", () => {
    const seen: string[] = [];
    const found = findChrome({}, "darwin", (p) => {
      seen.push(p);
      return p.includes("Chromium");
    });
    expect(found).toBe("/Applications/Chromium.app/Contents/MacOS/Chromium");
    expect(seen[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("checks the linux candidates in order", () => {
    const seen: string[] = [];
    expect(findChrome({}, "linux", (p) => (seen.push(p), false))).toBeNull();
    expect(seen).toEqual(["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]);
    expect(findChrome({}, "linux", (p) => p === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
  });

  it("builds the win32 candidates from env", () => {
    expect(findChrome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", () => true)).toBe("C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("returns null when nothing exists", () => {
    expect(findChrome({}, "darwin", () => false)).toBeNull();
  });
});

describe("headlessChromeArgs", () => {
  const url = "http://127.0.0.1:5555/?stage=1";

  it("uses SwiftShader and allows autoplay, with the url last", () => {
    const args = headlessChromeArgs(url, "/tmp/p", "darwin", false);
    expect(args).toEqual(expect.arrayContaining(["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--user-data-dir=/tmp/p"]));
    expect(args.at(-1)).toBe(url);
  });

  it("adds --no-sandbox only as root and --disable-dev-shm-usage only on linux", () => {
    expect(headlessChromeArgs(url, "/tmp/p", "darwin", false)).not.toContain("--no-sandbox");
    expect(headlessChromeArgs(url, "/tmp/p", "darwin", true)).toContain("--no-sandbox");
    expect(headlessChromeArgs(url, "/tmp/p", "darwin", false)).not.toContain("--disable-dev-shm-usage");
    expect(headlessChromeArgs(url, "/tmp/p", "linux", false)).toContain("--disable-dev-shm-usage");
  });

  it("never disables the GPU path or mutes audio", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const args = headlessChromeArgs(url, "/tmp/p", platform, true);
      expect(args).not.toContain("--disable-gpu");
      expect(args).not.toContain("--mute-audio");
    }
  });
});

describe("recordClip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentar-record-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeChrome() {
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> };
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
      return true;
    });
    return child;
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  async function setup(stopResponse?: (src: string) => Response) {
    const textFile = join(dir, "intro.txt");
    await writeFile(textFile, "  Hello from headless\n");
    const src = join(dir, "rec.webm");
    await writeFile(src, "WEBMDATA");
    const close = vi.fn(async () => undefined);
    const startBridge = vi.fn(async () => ({ url: "http://127.0.0.1:5555", close }));
    const chrome = fakeChrome();
    const launchChrome = vi.fn(() => chrome as unknown as ChildProcess);
    const calls: { path: string; body?: unknown }[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/api/health") return json(200, { ok: true, name: "agentar", version: "0.1.0", clients: 1 });
      if (path === "/api/record/start") return json(200, { id: "r1", status: "recording" });
      if (path === "/api/say") return json(200, { status: "done" });
      if (path === "/api/record/stop") return stopResponse ? stopResponse(src) : json(200, { id: "r1", path: src, mime: "video/webm", bytes: 8 });
      return json(404, { error: "nope" });
    });
    const deps: Partial<RecordDeps> = {
      startBridge,
      launchChrome,
      fetch: fetchFn as unknown as typeof fetch,
      findChrome: () => "/fake/chrome",
      settleMs: 0,
      readyTimeoutMs: 1000,
      log: () => undefined,
    };
    return { textFile, src, close, startBridge, chrome, launchChrome, calls, deps };
  }

  it("records start → say(wait) → stop and moves the file to --out", async () => {
    const { textFile, close, chrome, launchChrome, calls, deps } = await setup();
    const out = join(dir, "nested", "intro.webm");
    const result = await recordClip({ textFile, out, mood: "happy" }, deps);
    expect(result).toEqual({ id: "r1", path: join(dir, "rec.webm"), mime: "video/webm", bytes: 8, out });
    expect(await readFile(out, "utf8")).toBe("WEBMDATA");
    const posts = calls.filter((c) => c.path !== "/api/health");
    expect(posts.map((c) => c.path)).toEqual(["/api/record/start", "/api/say", "/api/record/stop"]);
    expect(posts[1]!.body).toEqual({ text: "Hello from headless", mood: "happy", wait: true });
    const args = launchChrome.mock.calls[0]! as unknown as [string, string[]];
    expect(args[0]).toBe("/fake/chrome");
    expect(args[1].at(-1)).toBe("http://127.0.0.1:5555/?stage=1");
    expect(chrome.kill).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("still cleans up when stop fails, and reports the partial file", async () => {
    const { textFile, close, chrome, deps } = await setup((src) => json(504, { error: "Timed out waiting for the recording", path: src }));
    chrome.stderr.write("[ERROR:gpu] something noisy\n");
    const err = (await recordClip({ textFile, out: join(dir, "x.webm") }, deps).catch((e: unknown) => e)) as RecordError;
    expect(err.message).toContain("Timed out waiting for the recording (partial file at");
    expect(err.chromeLog).toContain("something noisy");
    expect(chrome.kill).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("fails when Chrome exits before recording finishes", async () => {
    const { textFile, close, chrome, deps } = await setup();
    deps.fetch = (async () => {
      chrome.exitCode = 1;
      chrome.emit("exit", 1, null);
      return json(200, { ok: true, name: "agentar", version: "0.1.0", clients: 0 });
    }) as unknown as typeof fetch;
    await expect(recordClip({ textFile, out: join(dir, "x.webm") }, deps)).rejects.toThrow("Chrome exited early (code 1)");
    expect(close).toHaveBeenCalled();
  });

  it("rejects an empty text file before starting the bridge", async () => {
    const { startBridge, deps } = await setup();
    const empty = join(dir, "empty.txt");
    await writeFile(empty, "  \n");
    await expect(recordClip({ textFile: empty, out: join(dir, "x.webm") }, deps)).rejects.toThrow("is empty");
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("rejects before starting the bridge when no Chrome is found", async () => {
    const { textFile, startBridge, deps } = await setup();
    await expect(recordClip({ textFile, out: join(dir, "x.webm") }, { ...deps, findChrome: () => null })).rejects.toThrow("AGENTAR_CHROME");
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("aborts and cleans up when the signal fires", async () => {
    const { textFile, close, chrome, deps } = await setup();
    const ac = new AbortController();
    deps.fetch = (async () => {
      ac.abort();
      return json(200, { ok: true, name: "agentar", version: "0.1.0", clients: 0 });
    }) as unknown as typeof fetch;
    await expect(recordClip({ textFile, out: join(dir, "x.webm") }, { ...deps, signal: ac.signal })).rejects.toThrow("Recording aborted");
    expect(chrome.kill).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
