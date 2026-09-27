import type { VoiceInfo, VoiceSettings } from "@agentar/core";
import { TtsError, type SynthesisResult, type TtsProvider } from "./types.js";

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

/** OpenAI text-to-speech. Needs OPENAI_API_KEY. */
export class OpenAiTts implements TtsProvider {
  readonly id = "openai";

  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.AGENTAR_OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts",
    private readonly baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ) {}

  async unavailableReason(): Promise<string | null> {
    return this.apiKey ? null : "Set OPENAI_API_KEY in the environment that runs `agentar start`.";
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return OPENAI_VOICES.map((v) => ({ id: v, name: v[0]!.toUpperCase() + v.slice(1) }));
  }

  async synthesize(text: string, voice: VoiceSettings, signal?: AbortSignal): Promise<SynthesisResult> {
    if (!this.apiKey) throw new TtsError("OPENAI_API_KEY is not set");
    const res = await fetch(`${this.baseUrl}/audio/speech`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        voice: voice.voice || "coral",
        input: text,
        response_format: "mp3",
        speed: voice.rate,
      }),
    });
    if (!res.ok) throw new TtsError(`OpenAI TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return { data: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
}

/** ElevenLabs text-to-speech. Needs ELEVENLABS_API_KEY. */
export class ElevenLabsTts implements TtsProvider {
  readonly id = "elevenlabs";

  constructor(
    private readonly apiKey = process.env.ELEVENLABS_API_KEY,
    private readonly model = process.env.AGENTAR_ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
  ) {}

  async unavailableReason(): Promise<string | null> {
    return this.apiKey ? null : "Set ELEVENLABS_API_KEY in the environment that runs `agentar start`.";
  }

  async listVoices(): Promise<VoiceInfo[]> {
    if (!this.apiKey) return [];
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": this.apiKey } });
    if (!res.ok) throw new TtsError(`ElevenLabs voices failed (${res.status})`);
    const body = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; labels?: Record<string, string> }> };
    return (body.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, language: v.labels?.accent }));
  }

  async synthesize(text: string, voice: VoiceSettings, signal?: AbortSignal): Promise<SynthesisResult> {
    if (!this.apiKey) throw new TtsError("ELEVENLABS_API_KEY is not set");
    const voiceId = encodeURIComponent(voice.voice || "21m00Tcm4TlvDq8ikWAM");
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      signal,
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: this.model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.min(1.2, Math.max(0.7, voice.rate)) },
      }),
    });
    if (!res.ok) throw new TtsError(`ElevenLabs TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return { data: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
}

/** xAI (Grok) text-to-speech. Needs XAI_API_KEY from console.x.ai. */
export class XaiTts implements TtsProvider {
  readonly id = "xai";

  constructor(
    private readonly apiKey = process.env.XAI_API_KEY,
    private readonly baseUrl = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
  ) {}

  async unavailableReason(): Promise<string | null> {
    return this.apiKey ? null : "Set XAI_API_KEY in the environment that runs `agentar start`.";
  }

  async listVoices(): Promise<VoiceInfo[]> {
    if (!this.apiKey) return [];
    const res = await fetch(`${this.baseUrl}/tts/voices`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new TtsError(`xAI voices failed (${res.status})`);
    const body = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; language?: string | null }> };
    return (body.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, language: v.language ?? undefined }));
  }

  async synthesize(text: string, voice: VoiceSettings, signal?: AbortSignal): Promise<SynthesisResult> {
    if (!this.apiKey) throw new TtsError("XAI_API_KEY is not set");
    const res = await fetch(`${this.baseUrl}/tts`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voice.voice || "eve",
        language: "auto",
        output_format: { codec: "mp3" },
        speed: Math.min(1.5, Math.max(0.7, voice.rate)),
      }),
    });
    if (!res.ok) throw new TtsError(`xAI TTS failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return { data: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
}
