import type { VoiceInfo, VoiceSettings } from "@agentar/core";
import { TtsError, type SynthesisResult, type TtsProvider } from "./types.js";

export const KOKORO_DEFAULT_BASE_URL = "http://127.0.0.1:8880/v1";

/** Language of a Kokoro voice, from the first letter of its id (`af_heart` → en-US). */
const KOKORO_LANGUAGES: Record<string, string> = {
  a: "en-US",
  b: "en-GB",
  e: "es",
  f: "fr",
  h: "hi",
  i: "it",
  j: "ja",
  p: "pt-BR",
  z: "zh",
};

/**
 * The Kokoro server's OpenAI-compatible base URL. `AGENTAR_KOKORO_BASE_URL`
 * wins; otherwise `KOKORO_API_URL` (the full speech URL used by OpenClaw's
 * kokoro-tts skill) is accepted with its `/audio/speech` suffix removed.
 */
export function kokoroBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.AGENTAR_KOKORO_BASE_URL?.trim();
  if (own) return own.replace(/\/+$/, "");
  const skill = env.KOKORO_API_URL?.trim();
  if (skill) return skill.replace(/\/+$/, "").replace(/\/audio\/speech$/, "");
  return KOKORO_DEFAULT_BASE_URL;
}

/** `af_heart` → "Heart, female" (en-US). Ids that do not follow the pattern are kept as is. */
export function kokoroVoiceInfo(id: string): VoiceInfo {
  const m = /^([a-z])([fm])_([a-z0-9_]+)$/.exec(id);
  if (!m) return { id, name: id };
  const name = m[3]!.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, name: `${name}, ${m[2] === "f" ? "female" : "male"}`, language: KOKORO_LANGUAGES[m[1]!] };
}

/**
 * Kokoro neural voices from a local Kokoro-FastAPI server (or any server with
 * the same OpenAI-compatible `/audio/speech` API). Runs offline; no API key.
 */
export class KokoroTts implements TtsProvider {
  readonly id = "kokoro";

  constructor(
    private readonly baseUrl = kokoroBaseUrl(),
    private readonly model = process.env.AGENTAR_KOKORO_MODEL || "kokoro",
    /** How long to wait for the server to answer an availability check. */
    private readonly probeMs = 2000,
  ) {}

  /** Ready when anything answers at the base URL; the voice list may still be missing. */
  async unavailableReason(): Promise<string | null> {
    try {
      await fetch(`${this.baseUrl}/audio/voices`, { signal: AbortSignal.timeout(this.probeMs) });
      return null;
    } catch {
      return (
        `No Kokoro server at ${this.baseUrl}. Start one with ` +
        "`docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`, or set AGENTAR_KOKORO_BASE_URL."
      );
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await fetch(`${this.baseUrl}/audio/voices`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new TtsError(`Kokoro voices failed (${res.status})`);
    const body = (await res.json()) as { voices?: Array<string | { id: string; name?: string; language?: string }> };
    return (body.voices ?? []).map((v) =>
      typeof v === "string" ? kokoroVoiceInfo(v) : { ...kokoroVoiceInfo(v.id), ...(v.name ? { name: v.name } : {}), ...(v.language ? { language: v.language } : {}) },
    );
  }

  async synthesize(text: string, voice: VoiceSettings, signal?: AbortSignal): Promise<SynthesisResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/audio/speech`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          voice: voice.voice || "af_heart",
          input: text,
          response_format: "mp3",
          speed: voice.rate,
        }),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TtsError(`Cannot reach the Kokoro server at ${this.baseUrl}`);
    }
    if (!res.ok) throw new TtsError(`Kokoro TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg";
    return { data: Buffer.from(await res.arrayBuffer()), mime };
  }
}
