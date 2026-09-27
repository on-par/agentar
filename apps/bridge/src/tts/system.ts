import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VoiceInfo, VoiceSettings } from "@agentar/core";
import { TtsError, type SynthesisResult, type TtsProvider } from "./types.js";

const run = promisify(execFile);

/**
 * Offline TTS using the operating system's voices. Needs no API key:
 *  - macOS: `say` (install extra/enhanced voices in System Settings → Accessibility → Spoken Content)
 *  - Linux: `espeak-ng` (or `espeak`)
 *  - Windows: System.Speech via PowerShell
 */
export class SystemTts implements TtsProvider {
  readonly id = "system";
  private voicesCache: VoiceInfo[] | null = null;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async unavailableReason(): Promise<string | null> {
    try {
      if (this.platform === "darwin") await run("which", ["say"]);
      else if (this.platform === "win32") await run("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Speech"]);
      else await this.linuxBinary();
      return null;
    } catch {
      return this.platform === "linux"
        ? "Install espeak-ng (e.g. `sudo apt install espeak-ng`) or choose another voice provider."
        : "The system speech engine is not available.";
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    if (this.voicesCache) return this.voicesCache;
    let voices: VoiceInfo[] = [];
    if (this.platform === "darwin") {
      const { stdout } = await run("say", ["-v", "?"]);
      voices = parseSayVoices(stdout);
    } else if (this.platform === "win32") {
      const { stdout } = await run("powershell", [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture }",
      ]);
      voices = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [name = "", language] = l.split("|");
          return { id: name, name, language };
        });
    } else {
      const bin = await this.linuxBinary();
      const { stdout } = await run(bin, ["--voices"]);
      voices = stdout
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length >= 4)
        .map((p) => ({ id: p[3]!, name: p[3]!, language: p[1] }));
    }
    this.voicesCache = voices;
    return voices;
  }

  async synthesize(text: string, voice: VoiceSettings): Promise<SynthesisResult> {
    const dir = await mkdtemp(join(tmpdir(), "agentar-tts-"));
    const input = join(dir, "input.txt");
    const out = join(dir, "speech.wav");
    try {
      // Text goes through a file, never through a shell, so quotes and
      // other characters in agent output are harmless.
      await writeFile(input, text, "utf8");
      if (this.platform === "darwin") {
        const args = ["-f", input, "-o", out, "--file-format=WAVE", "--data-format=LEI16@22050", "-r", String(Math.round(185 * voice.rate))];
        if (voice.voice) args.unshift("-v", voice.voice);
        await run("say", args, { timeout: 60_000 });
      } else if (this.platform === "win32") {
        const script = [
          "Add-Type -AssemblyName System.Speech",
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
          voice.voice ? `$s.SelectVoice($env:AGENTAR_VOICE)` : "",
          `$s.Rate = ${Math.max(-10, Math.min(10, Math.round((voice.rate - 1) * 10)))}`,
          "$s.SetOutputToWaveFile($env:AGENTAR_OUT)",
          "$s.Speak([IO.File]::ReadAllText($env:AGENTAR_IN))",
          "$s.Dispose()",
        ].join("; ");
        await run("powershell", ["-NoProfile", "-Command", script], {
          timeout: 60_000,
          env: { ...process.env, AGENTAR_VOICE: voice.voice, AGENTAR_OUT: out, AGENTAR_IN: input },
        });
      } else {
        const bin = await this.linuxBinary();
        const args = ["-w", out, "-s", String(Math.round(170 * voice.rate)), "-f", input];
        if (voice.voice) args.unshift("-v", voice.voice);
        await run(bin, args, { timeout: 60_000 });
      }
      return { data: await readFile(out), mime: "audio/wav" };
    } catch (err) {
      throw new TtsError(`System TTS failed: ${(err as Error).message}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async linuxBinary(): Promise<string> {
    for (const bin of ["espeak-ng", "espeak"]) {
      try {
        await run("which", [bin]);
        return bin;
      } catch {
        /* try next */
      }
    }
    throw new TtsError("espeak-ng not found");
  }
}

/** Parse `say -v ?` output: "Name (Variant)   en_US    # sample text". */
export function parseSayVoices(stdout: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
    if (m) voices.push({ id: m[1]!.trim(), name: m[1]!.trim(), language: m[2]!.replace("_", "-") });
  }
  return voices;
}
