import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Json = Record<string, unknown>;

/**
 * Add a Stop hook to Claude Code user settings that speaks each final reply.
 * Idempotent; keeps a .bak copy of the previous file.
 */
export async function installClaudeCode(cliPath: string, file = join(homedir(), ".claude", "settings.json")): Promise<string> {
  const command = `node ${JSON.stringify(cliPath)} hook claude-code`;
  let settings: Json = {};
  try {
    settings = JSON.parse(await readFile(file, "utf8")) as Json;
    await copyFile(file, `${file}.bak`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  const hooks = (settings.hooks ??= {}) as Json;
  const stop = (hooks.Stop ??= []) as Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>;
  if (JSON.stringify(stop).includes("hook claude-code")) return `Already installed in ${file}`;
  stop.push({ hooks: [{ type: "command", command }] });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return `Added a Stop hook to ${file}`;
}

/**
 * Configure Codex CLI (~/.codex/config.toml): a notify program that speaks
 * each finished turn, plus the MCP server. TOML top-level keys must precede
 * tables, so `notify` is inserted at the top of the file.
 */
export async function installCodex(cliPath: string, file = join(homedir(), ".codex", "config.toml")): Promise<string[]> {
  let toml = "";
  try {
    toml = await readFile(file, "utf8");
    await copyFile(file, `${file}.bak`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const notes: string[] = [];
  const q = (s: string) => JSON.stringify(s);
  if (/^\s*notify\s*=/m.test(toml)) {
    notes.push(`${file} already has a notify setting. Add agentar manually: notify = ["node", ${q(cliPath)}, "hook", "codex"]`);
  } else {
    toml = `notify = ["node", ${q(cliPath)}, "hook", "codex"]\n` + toml;
    notes.push("Added notify hook (speaks each finished turn).");
  }
  if (/^\s*\[mcp_servers\.agentar\]/m.test(toml)) {
    notes.push("MCP server already configured.");
  } else {
    toml += `${toml.endsWith("\n") || !toml ? "" : "\n"}\n[mcp_servers.agentar]\ncommand = "node"\nargs = [${q(cliPath)}, "mcp"]\n`;
    notes.push("Added [mcp_servers.agentar] (speak / set_mood / gesture tools).");
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, toml, "utf8");
  return notes;
}
