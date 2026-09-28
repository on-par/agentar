import type { VoiceProvider } from "@agentar/core";

export interface FallbackStatus {
  /** The OS speech engine (`say`, `espeak-ng`, SAPI) is not installed. */
  systemMissing: boolean;
  /** The `edge-tts` CLI is installed. */
  edgeReady: boolean;
  /** `failed` was itself picked as a fallback, not chosen by the user. */
  viaFallback: boolean;
}

/**
 * Pick the voice engine to switch to after `failed` could not speak, or null
 * to report the error instead.
 *
 * Only the default `system` engine falls back on its own, and only when the
 * OS binary is missing (a fresh Linux box without espeak-ng): it moves to
 * edge-tts when installed, else to the browser's own voice. An edge-tts that
 * was picked this way and then fails moves on to the browser, which always
 * works. An engine the user chose keeps its error so they can fix it.
 */
export function chooseFallback(failed: VoiceProvider, status: FallbackStatus): "edge" | "browser" | null {
  if (failed === "system") return status.systemMissing ? (status.edgeReady ? "edge" : "browser") : null;
  if (failed === "edge" && status.viaFallback) return "browser";
  return null;
}
