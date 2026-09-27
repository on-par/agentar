import type { VoiceInfo, VoiceSettings } from "@agentar/core";

export interface SynthesisResult {
  data: Buffer;
  mime: string;
}

/**
 * A text-to-speech engine that renders audio on the bridge. The browser then
 * plays the file and lip-syncs to it. (The "browser" provider is the
 * exception: it speaks inside the page and never reaches the bridge.)
 */
export interface TtsProvider {
  readonly id: string;
  /** Human-readable reason this provider cannot be used, or null if ready. */
  unavailableReason(): Promise<string | null>;
  listVoices(): Promise<VoiceInfo[]>;
  synthesize(text: string, voice: VoiceSettings, signal?: AbortSignal): Promise<SynthesisResult>;
}

export class TtsError extends Error {}
