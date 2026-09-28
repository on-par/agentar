import type { VoiceProvider } from "@agentar/core";

export interface FallbackStatus {
  /** The OS speech engine (`say`, `espeak-ng`, SAPI) is not installed. */
  systemMissing: boolean;
  /** No Kokoro server answers at its configured URL. */
  kokoroMissing: boolean;
  /** The `edge-tts` CLI is installed. */
  edgeReady: boolean;
  /** `failed` was itself picked as a fallback, not chosen by the user. */
  viaFallback: boolean;
}

/**
 * Pick the voice engine to switch to after `failed` could not speak, or null
 * to report the error instead.
 *
 * The default `system` engine falls back on its own when the OS binary is
 * missing (a fresh Linux box without espeak-ng): it moves to edge-tts when
 * installed, else to the browser's own voice. An edge-tts that was picked this
 * way and then fails moves on to the browser, which always works.
 *
 * Kokoro needs a local server that may not be running. When none answers it
 * moves to the system engine, or along the same edge-tts → browser path when
 * that is missing too. A Kokoro server that answers but fails keeps its error,
 * as does any other engine the user chose, so they can fix it.
 */
export function chooseFallback(failed: VoiceProvider, status: FallbackStatus): "system" | "edge" | "browser" | null {
  const offline = status.edgeReady ? "edge" : "browser";
  if (failed === "kokoro") return status.kokoroMissing ? (status.systemMissing ? offline : "system") : null;
  if (failed === "system") return status.systemMissing ? offline : null;
  if (failed === "edge" && status.viaFallback) return "browser";
  return null;
}
