import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Bridge, BridgeOptions } from "@agentar/bridge";
import { isMood, type HealthResponse, type Mood, type RecordStartResponse, type RecordStopResponse } from "@agentar/core";
import { startBridgeWithModels } from "./bridge.js";

export interface RecordOptions {
  /** Path to a UTF-8 text file with what the avatar should say. */
  textFile: string;
  /** Destination file, resolved to an absolute path. */
  out: string;
  mood?: Mood;
}

export interface RecordDeps {
  startBridge: (opts: BridgeOptions) => Promise<Pick<Bridge, "url" | "close">>;
  launchChrome: (bin: string, args: string[]) => ChildProcess;
  fetch: typeof fetch;
  findChrome: () => string | null;
  settleMs: number;
  readyTimeoutMs: number;
  log: (line: string) => void;
  /** Path of the CLI entry point, passed through to the bridge. */
  cliPath?: string;
  /** Aborts the run (SIGINT/SIGTERM); cleanup still runs. */
  signal?: AbortSignal;
}

/** Error thrown by recordClip, with the tail of Chrome's stderr when there is one. */
export type RecordError = Error & { chromeLog?: string };

const MAX_TEXT = 5000;
const MAX_CHROME_LOG = 64 * 1024;
const POLL_MS = 200;
const TAIL_MS = 300;
const KILL_GRACE_MS = 3000;

export const RECORD_USAGE = "Usage: agentar record --text-file <path> --out <file.webm> [--mood M]";

export function parseRecordArgs(args: string[]): RecordOptions | { error: string } {
  let textFile: string | undefined;
  let out: string | undefined;
  let mood: Mood | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag !== "--text-file" && flag !== "--out" && flag !== "--mood") return { error: `Unknown option: ${flag}` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    i++;
    if (flag === "--text-file") textFile = value;
    else if (flag === "--out") out = value;
    else if (isMood(value)) mood = value;
    else return { error: `Unknown mood: ${value}` };
  }
  if (!textFile) return { error: "Missing --text-file" };
  if (!out) return { error: "Missing --out" };
  return { textFile, out: resolve(out), ...(mood ? { mood } : {}) };
}

function chromeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ];
  }
  if (platform === "win32") {
    const suffix = "\\Google\\Chrome\\Application\\chrome.exe";
    return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((dir): dir is string => !!dir).map((dir) => `${dir}${suffix}`);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
}

/** AGENTAR_CHROME wins (even if missing, so spawn reports it); else the first installed candidate. */
export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string | null {
  if (env.AGENTAR_CHROME) return env.AGENTAR_CHROME;
  return chromeCandidates(env, platform).find((p) => exists(p)) ?? null;
}

/**
 * Headless Chrome flags: SwiftShader gives software WebGL without a GPU, and the
 * autoplay policy lets audio start without a click. No --disable-gpu (breaks the
 * ANGLE SwiftShader path) and no --mute-audio (could silence the captured audio).
 */
export function headlessChromeArgs(url: string, userDataDir: string, platform: NodeJS.Platform = process.platform, isRoot: boolean = process.getuid?.() === 0): string[] {
  return [
    "--headless=new",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=1280,720",
    `--user-data-dir=${userDataDir}`,
    ...(platform === "linux" ? ["--disable-dev-shm-usage"] : []),
    ...(isRoot ? ["--no-sandbox"] : []),
    url,
  ];
}

function defaultDeps(): RecordDeps {
  return {
    startBridge: startBridgeWithModels,
    launchChrome: (bin, args) => spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] }),
    fetch: (...args) => fetch(...args),
    findChrome: () => findChrome(),
    settleMs: Number(process.env.AGENTAR_RECORD_SETTLE_MS ?? 2000),
    readyTimeoutMs: 30_000,
    log: (line) => console.error(line),
  };
}

function abortError(): Error {
  return new Error("Recording aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBody<T>(res: Response): Promise<T & { error?: string; path?: string }> {
  try {
    return (await res.json()) as T & { error?: string; path?: string };
  } catch {
    return {} as T & { error?: string; path?: string };
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function killChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await waitForExit(child, KILL_GRACE_MS))) child.kill("SIGKILL");
}

/**
 * Record one clip headlessly: a private bridge on an ephemeral port, headless
 * Chrome on its stage, then record/start → say(wait) → record/stop, and move the
 * file to opts.out. Chrome, the temp profile and the bridge are always cleaned up.
 */
export async function recordClip(opts: RecordOptions, deps: Partial<RecordDeps> = {}): Promise<RecordStopResponse & { out: string; warning?: string }> {
  const d: RecordDeps = { ...defaultDeps(), ...deps };
  const text = (await readFile(opts.textFile, "utf8")).trim();
  if (!text) throw new Error(`${opts.textFile} is empty`);
  if (text.length > MAX_TEXT) throw new Error(`${opts.textFile} is too long (${text.length} chars, max ${MAX_TEXT})`);
  const bin = d.findChrome();
  if (!bin) throw new Error("No Chrome or Chromium found. Install one or set AGENTAR_CHROME to its path.");

  let bridge: Pick<Bridge, "url" | "close"> | undefined;
  let child: ChildProcess | undefined;
  let profile: string | undefined;
  let chromeLog = "";
  try {
    if (d.signal?.aborted) throw abortError();
    bridge = await d.startBridge({ port: 0, log: () => undefined, ...(d.cliPath ? { cliPath: d.cliPath } : {}) });
    const base = bridge.url.replace(/\/$/, "");
    profile = await mkdtemp(join(tmpdir(), "agentar-chrome-"));
    child = d.launchChrome(bin, headlessChromeArgs(`${base}/?stage=1`, profile));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      chromeLog = (chromeLog + chunk).slice(-MAX_CHROME_LOG);
    });

    // Any step fails fast if Chrome dies or the run is aborted.
    const launched = child;
    const failed = new Promise<never>((_, reject) => {
      launched.once("error", (err) => reject(new Error(`Could not start Chrome (${bin}): ${err.message}`)));
      launched.once("exit", (code, signal) => reject(new Error(`Chrome exited early (code ${code ?? signal})`)));
      d.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    failed.catch(() => undefined);
    const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, failed]);

    const post = async <T>(path: string, body?: unknown): Promise<T> => {
      const res = await guard(
        d.fetch(`${base}${path}`, {
          method: "POST",
          ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        }),
      );
      const json = await guard(readBody<T>(res));
      if (!res.ok) {
        const msg = json.error ?? `${path} failed (HTTP ${res.status})`;
        throw new Error(json.path ? `${msg} (partial file at ${json.path})` : msg);
      }
      return json;
    };

    const deadline = Date.now() + d.readyTimeoutMs;
    for (;;) {
      const health = await guard(
        d
          .fetch(`${base}/api/health`)
          .then((r) => r.json() as Promise<HealthResponse>)
          .catch(() => null),
      );
      if (health && health.clients >= 1) break;
      if (Date.now() >= deadline) throw new Error("The headless page never connected");
      await guard(sleep(POLL_MS, d.signal));
    }
    await guard(sleep(d.settleMs, d.signal));

    const started = await post<RecordStartResponse>("/api/record/start");
    if (started.warning) d.log(`warning: ${started.warning}`);
    await post("/api/say", { text, mood: opts.mood, wait: true });
    await guard(sleep(TAIL_MS, d.signal));
    const stop = await post<RecordStopResponse>("/api/record/stop");

    await moveFile(stop.path, opts.out);
    const outMp4 = opts.out.toLowerCase().endsWith(".mp4");
    const outWebm = opts.out.toLowerCase().endsWith(".webm");
    if ((stop.mime.includes("mp4") && outWebm) || (stop.mime.includes("webm") && outMp4)) {
      d.log(`warning: the recording is ${stop.mime}, but ${opts.out} has a different extension`);
    }
    return { id: stop.id, path: stop.path, mime: stop.mime, bytes: stop.bytes, out: opts.out, ...(started.warning ? { warning: started.warning } : {}) };
  } catch (err) {
    const e = (err instanceof Error ? err : new Error(String(err))) as RecordError;
    const tail = chromeLog.trimEnd().split("\n").slice(-20).join("\n");
    if (tail) e.chromeLog = tail;
    throw e;
  } finally {
    if (child) await killChrome(child).catch(() => undefined);
    if (bridge) await bridge.close().catch(() => undefined);
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}
