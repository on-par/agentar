import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_PORT, GESTURES, MOODS, toSpeakable, type SayResponse } from "@agentar/core";

/** Base URL of the running bridge. Override with AGENTAR_URL. */
export function bridgeUrl(): string {
  return process.env.AGENTAR_URL ?? `http://localhost:${process.env.AGENTAR_PORT ?? DEFAULT_PORT}`;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const res = await fetch(`${bridgeUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } catch {
    throw new Error(`agentar bridge is not running at ${bridgeUrl()}. Start it with \`agentar start\`.`);
  }
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Build the MCP server (exported for tests). */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "agentar", version: "0.1.0" },
    {
      instructions:
        "agentar gives you a 3D talking body that the user can see and hear. Use `speak` for short, conversational " +
        "spoken summaries (one to three sentences) — not for code, file paths or long lists, which belong in the chat. " +
        "Use `set_mood` and `gesture` sparingly to match the tone.",
    },
  );

  server.registerTool(
    "speak",
    {
      title: "Speak aloud",
      description:
        "Say something out loud through the user's agentar avatar (text-to-speech with a lip-synced 3D face). " +
        "Keep it short and conversational; markdown is stripped automatically.",
      inputSchema: {
        text: z.string().min(1).max(5000).describe("What to say, in plain conversational language."),
        mood: z.enum(MOODS).optional().describe("Facial expression while speaking."),
        wait: z.boolean().optional().describe("Wait until the avatar finishes speaking before returning. Default false."),
      },
    },
    async ({ text: raw, mood, wait }) => {
      const spoken = toSpeakable(raw, { maxChars: 1200 });
      const { json } = await post("/api/say", { text: spoken, mood, wait: wait ?? false });
      const res = json as unknown as SayResponse;
      if (res.status === "no-clients") return { ...text(`Not spoken: ${res.error}`), isError: true };
      if (res.status === "error") return { ...text(`Speech failed: ${res.error}`), isError: true };
      return text(res.status === "spoken" ? "Spoken." : "Speaking.");
    },
  );

  server.registerTool(
    "set_mood",
    {
      title: "Set facial mood",
      description: "Change the avatar's resting facial expression.",
      inputSchema: { mood: z.enum(MOODS) },
    },
    async ({ mood }) => {
      await post("/api/mood", { mood });
      return text(`Mood set to ${mood}.`);
    },
  );

  server.registerTool(
    "gesture",
    {
      title: "Gesture",
      description:
        "Play a short gesture. Head: nod (yes/agree), shake (no), tilt (curious). Hands: wave (hello/bye), " +
        "high-five (celebrate a win), thumbs-up (approve), thumbs-down (disapprove), idea (one finger up), " +
        "shrug (not sure), namaste (thanks). Face and body: wink, laugh, surprised, bow.",
      inputSchema: { gesture: z.enum(GESTURES) },
    },
    async ({ gesture }) => {
      await post("/api/gesture", { gesture });
      return text(`Played ${gesture}.`);
    },
  );

  server.registerTool(
    "stop_speaking",
    { title: "Stop speaking", description: "Stop the avatar mid-sentence and clear queued speech.", inputSchema: {} },
    async () => {
      await post("/api/stop", {});
      return text("Stopped.");
    },
  );

  return server;
}

/** Run the MCP server over stdio (what `agentar mcp` does). */
export async function runMcpServer(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport());
}
