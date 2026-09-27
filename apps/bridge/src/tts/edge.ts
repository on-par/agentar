import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VoiceInfo, VoiceSettings } from "@agentar/core";
import { TtsError, type SynthesisResult, type TtsProvider } from "./types.js";

const run = promisify(execFile);

/**
 * Microsoft Edge's online neural voices, through the `edge-tts` CLI
 * (https://github.com/rany2/edge-tts). Needs no API key, but needs internet.
 * Install it with `pipx install edge-tts` or `uv tool install edge-tts`.
 */
export class EdgeTts implements TtsProvider {
  readonly id = "edge";
  private voicesCache: VoiceInfo[] | null = null;

  constructor(private readonly binary = process.env.AGENTAR_EDGE_TTS) {}

  async unavailableReason(): Promise<string | null> {
    return (await this.findBinary())
      ? null
      : "Install edge-tts (`pipx install edge-tts` or `uv tool install edge-tts`).";
  }

  async listVoices(): Promise<VoiceInfo[]> {
    if (this.voicesCache) return this.voicesCache;
    const { stdout } = await run(await this.requireBinary(), ["--list-voices"], { timeout: 30_000 });
    this.voicesCache = parseEdgeVoices(stdout);
    return this.voicesCache;
  }

  async synthesize(text: string, voice: VoiceSettings, signal?: AbortSignal): Promise<SynthesisResult> {
    const bin = await this.requireBinary();
    const dir = await mkdtemp(join(tmpdir(), "agentar-edge-"));
    const input = join(dir, "input.txt");
    const out = join(dir, "speech.mp3");
    try {
      // Text goes through a file and options use the `--name=value` form, so
      // nothing from the agent or the config can be read as a flag.
      await writeFile(input, text, "utf8");
      const args = [`--file=${input}`, `--write-media=${out}`, `--rate=${edgeRate(voice.rate)}`];
      if (voice.voice) args.push(`--voice=${voice.voice}`);
      await run(bin, args, { timeout: 60_000, signal });
      return { data: await readFile(out), mime: "audio/mpeg" };
    } catch (err) {
      throw new TtsError(`Edge TTS failed: ${(err as Error).message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async requireBinary(): Promise<string> {
    const bin = await this.findBinary();
    if (!bin) throw new TtsError("edge-tts not found");
    return bin;
  }

  /**
   * The bridge may be started from a hook or app with a short PATH, so also
   * look where pipx, uv, and Homebrew put their binaries.
   */
  private async findBinary(): Promise<string | null> {
    if (this.binary) return (await isExecutable(this.binary)) ? this.binary : null;
    try {
      const { stdout } = await run("which", ["edge-tts"]);
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* not on PATH */
    }
    for (const dir of [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
      const bin = join(dir, "edge-tts");
      if (await isExecutable(bin)) return bin;
    }
    return null;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, 1 /* X_OK */);
    return true;
  } catch {
    return false;
  }
}

/** Speaking rate multiplier → edge-tts `--rate` value, e.g. 1.25 → "+25%". */
export function edgeRate(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct < 0 ? "-" : "+"}${Math.abs(pct)}%`;
}

/**
 * Parse `edge-tts --list-voices`:
 *   Name                     Gender    ContentCategories  VoicePersonalities
 *   -----------------------  --------  -----------------  ------------------
 *   en-US-AriaNeural         Female    News, Novel        Positive, Confident
 */
export function parseEdgeVoices(stdout: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^((?:[a-z]{2,3}-)(?:[A-Za-z]+-)+)([A-Za-z]+?)(Multilingual)?Neural\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    const [, locale = "", short = "", multi, gender = ""] = m;
    const id = line.trim().split(/\s+/)[0]!;
    const label = multi ? `${short} Multilingual` : short;
    voices.push({ id, name: `${label}, ${gender.toLowerCase()}`, language: locale.slice(0, -1) });
  }
  return voices;
}
