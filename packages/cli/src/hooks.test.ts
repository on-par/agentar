import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeReply, codexReply, lastAssistantText } from "./hooks.js";
import { installClaudeCode, installCodex } from "./install.js";

describe("hook payloads", () => {
  it("reads the last assistant text from a Claude Code transcript", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done." }] } }),
      "",
    ].join("\n");
    expect(lastAssistantText(jsonl)).toBe("All done.");
  });

  it("prefers last_assistant_message and skips re-entrant stops", async () => {
    expect(await claudeCodeReply(JSON.stringify({ last_assistant_message: "Hey" }))).toBe("Hey");
    expect(await claudeCodeReply(JSON.stringify({ stop_hook_active: true, last_assistant_message: "Hey" }))).toBeNull();
    expect(await claudeCodeReply("not json")).toBeNull();
  });

  it("parses Codex notify payloads", () => {
    expect(codexReply(JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "Done!" }))).toBe("Done!");
    expect(codexReply(JSON.stringify({ type: "other" }))).toBeNull();
  });
});

describe("installers", () => {
  it("adds the Claude Code Stop hook once, keeping other settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentar-install-"));
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    await installClaudeCode("/x/cli.js", file);
    expect(await installClaudeCode("/x/cli.js", file)).toMatch(/Already/);
    const settings = JSON.parse(await readFile(file, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[1].hooks[0].command).toBe('node "/x/cli.js" hook claude-code');
    await rm(dir, { recursive: true });
  });

  it("puts Codex notify before any TOML table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentar-install-"));
    const file = join(dir, "config.toml");
    await writeFile(file, 'model = "o4"\n\n[profiles.x]\nmodel = "y"\n');
    await installCodex("/x/cli.js", file);
    const toml = await readFile(file, "utf8");
    expect(toml.indexOf("notify =")).toBeLessThan(toml.indexOf("[profiles.x]"));
    expect(toml).toContain('[mcp_servers.agentar]\ncommand = "node"\nargs = ["/x/cli.js", "mcp"]');
    await rm(dir, { recursive: true });
  });
});
