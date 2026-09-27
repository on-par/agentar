/**
 * Pull the agent's final reply out of the payloads that agent harnesses
 * hand to their hooks, so it can be spoken aloud.
 */
import { readFile } from "node:fs/promises";

/** Claude Code Stop hook: JSON on stdin with `transcript_path` (and newer versions `last_assistant_message`). */
export async function claudeCodeReply(stdinJson: string): Promise<string | null> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdinJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Avoid speaking twice when a Stop hook re-enters.
  if (input.stop_hook_active === true) return null;
  if (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim()) {
    return input.last_assistant_message;
  }
  if (typeof input.transcript_path !== "string") return null;
  try {
    return lastAssistantText(await readFile(input.transcript_path, "utf8"));
  } catch {
    return null;
  }
}

/** Find the text of the last assistant message in a Claude Code JSONL transcript. */
export function lastAssistantText(jsonl: string): string | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" && entry.message?.role !== "assistant") continue;
    const content = entry.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join("\n")
          : "";
    if (text.trim()) return text;
  }
  return null;
}

/** Codex `notify` program: JSON payload passed as the last argv entry. */
export function codexReply(arg: string | undefined): string | null {
  if (!arg) return null;
  try {
    const payload = JSON.parse(arg) as Record<string, unknown>;
    if (payload.type !== "agent-turn-complete") return null;
    const msg = payload["last-assistant-message"];
    return typeof msg === "string" && msg.trim() ? msg : null;
  } catch {
    return null;
  }
}
