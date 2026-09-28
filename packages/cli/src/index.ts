#!/usr/bin/env node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, isMood, toSpeakable } from "@agentar/core";
import { clearDaemonState, daemonPaths, daemonStatus, spawnDaemon, stopDaemon, waitForDaemon, writeDaemonState } from "./daemon.js";
import { claudeCodeReply, codexReply } from "./hooks.js";
import { installClaudeCode, installCodex } from "./install.js";

const CLI_PATH = fileURLToPath(import.meta.url);
const BRIDGE = process.env.AGENTAR_URL ?? `http://localhost:${process.env.AGENTAR_PORT ?? DEFAULT_PORT}`;

const HELP = `agentar (agent + avatar) — give your AI agent a body

Usage:
  agentar start [--port N] [--no-open] [--daemon]
                                          Start the bridge and open the avatar in your browser
                                          (--daemon keeps it running after the terminal closes)
  agentar status                         Show whether the background bridge (--daemon) is running
  agentar stop                           Stop the background bridge started with --daemon
  agentar say <text> [--mood M] [--wait] Make the avatar speak
  agentar hush                           Stop speaking
  agentar fetch-models [--all]           Download the built-in avatars (--all adds non-commercial samples)
  agentar mcp                            Run the MCP server (stdio) for Claude Code / Codex
  agentar hook claude-code               Claude Code Stop hook (reads JSON on stdin)
  agentar hook codex <json>              Codex notify hook
  agentar install claude-code            Speak every Claude Code reply (adds a Stop hook)
  agentar install codex                  Configure Codex notify + MCP server

Environment:
  AGENTAR_PORT (default ${DEFAULT_PORT}), AGENTAR_URL, AGENTAR_HOME (default ~/.agentar),
  OPENAI_API_KEY, ELEVENLABS_API_KEY, XAI_API_KEY for cloud voices,
  AGENTAR_EDGE_TTS (path to edge-tts, if it is not on PATH),
  AGENTAR_ALLOWED_ORIGINS (extra browser origins, such as a meeting-bot tunnel).
  AGENTAR_HOME/agentar.pid and AGENTAR_HOME/agentar.log track the --daemon process.`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "start":
      return start(rest);
    case "say":
      return say(rest);
    case "status": {
      const s = await daemonStatus();
      if (s.running) {
        console.log(`agentar is running (pid ${s.state.pid}) → ${s.state.url}`);
        return 0;
      }
      console.log("agentar is not running");
      return 1;
    }
    case "stop": {
      const s = await stopDaemon();
      console.log(s.running ? `agentar stopped (pid ${s.state.pid})` : "agentar is not running");
      return 0;
    }
    case "hush":
      await fetch(`${BRIDGE}/api/stop`, { method: "POST" });
      return 0;
    case "fetch-models": {
      const { defaultModelsDir, fetchModels } = await import("@agentar/bridge");
      return (await fetchModels(process.env.AGENTAR_MODELS_DIR ?? defaultModelsDir(), { all: rest.includes("--all") })) ? 0 : 1;
    }
    case "mcp": {
      const { runMcpServer } = await import("@agentar/mcp");
      await runMcpServer();
      return -1; // keep running
    }
    case "hook":
      return hook(rest);
    case "install":
      return install(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

async function start(args: string[]): Promise<number> {
  if (args.includes("--daemon")) return startDaemon(args.filter((a) => a !== "--daemon"));
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
  const { defaultModelsDir, fetchModels, startBridge } = await import("@agentar/bridge");
  // First run: download the default (CC0) avatar so the page has something to show.
  const modelsDir = process.env.AGENTAR_MODELS_DIR ?? defaultModelsDir();
  await fetchModels(modelsDir, { quiet: true });
  const bridge = await startBridge({ ...(port ? { port } : {}), modelsDir, cliPath: CLI_PATH });
  console.log(`\n  agentar is running → ${bridge.url}\n  OBS / virtual camera view → ${bridge.url}/?stage=1\n`);
  if (!args.includes("--no-open")) openBrowser(bridge.url);
  const daemonMode = process.env.AGENTAR_DAEMON === "1";
  if (daemonMode) {
    await writeDaemonState({ pid: process.pid, port: bridge.port, url: bridge.url, startedAt: new Date().toISOString() });
    process.on("SIGHUP", () => undefined);
  }
  const shutdown = () =>
    void bridge
      .close()
      .then(() => (daemonMode ? clearDaemonState(process.pid) : undefined))
      .then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return -1;
}

async function startDaemon(args: string[]): Promise<number> {
  if (process.platform === "win32") {
    console.error("agentar start --daemon is not supported on Windows yet; run agentar start in its own terminal.");
    return 1;
  }
  const existing = await daemonStatus();
  if (existing.running) {
    console.error(`agentar is already running (pid ${existing.state.pid}) → ${existing.state.url}`);
    return 1;
  }
  const pid = await spawnDaemon(CLI_PATH, args);
  const state = await waitForDaemon(pid);
  if (!state) {
    console.error(`agentar daemon failed to start; see ${daemonPaths().logFile}`);
    return 1;
  }
  console.log(`\n  agentar is running in the background (pid ${state.pid}) → ${state.url}\n  OBS / virtual camera view → ${state.url}/?stage=1\n  Stop it with: agentar stop\n`);
  if (!args.includes("--no-open")) openBrowser(state.url);
  return 0;
}

async function say(args: string[]): Promise<number> {
  const words: string[] = [];
  let mood: string | undefined;
  let wait = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mood") mood = args[++i];
    else if (args[i] === "--wait") wait = true;
    else words.push(args[i]!);
  }
  const text = words.join(" ").trim();
  if (!text) {
    console.error("Usage: agentar say <text> [--mood happy] [--wait]");
    return 1;
  }
  const res = await speak(text, isMood(mood) ? mood : undefined, wait);
  if (!res.ok) console.error(res.error);
  return res.ok ? 0 : 1;
}

async function speak(text: string, mood?: string, wait = false): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${BRIDGE}/api/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mood, wait }),
    });
    const body = (await res.json()) as { status: string; error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error ?? body.status };
  } catch {
    return { ok: false, error: `agentar is not running at ${BRIDGE}. Start it with: agentar start` };
  }
}

/** Hooks must never break the agent: always exit 0 and stay quiet. */
async function hook(args: string[]): Promise<number> {
  const [kind, payload] = args;
  let reply: string | null = null;
  if (kind === "claude-code") reply = await claudeCodeReply(await readStdin());
  else if (kind === "codex") reply = codexReply(payload ?? args[args.length - 1]);
  if (reply) await speak(toSpeakable(reply));
  return 0;
}

async function install(args: string[]): Promise<number> {
  const [target] = args;
  if (target === "claude-code") {
    console.log(await installClaudeCode(CLI_PATH));
    console.log(`\nFor tools Claude can call itself (speak, set_mood, gesture), also run:\n  claude mcp add agentar -- node ${JSON.stringify(CLI_PATH)} mcp`);
    return 0;
  }
  if (target === "codex") {
    for (const note of await installCodex(CLI_PATH)) console.log(note);
    return 0;
  }
  console.error("Usage: agentar install <claude-code|codex>");
  return 1;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [url], () => undefined);
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
