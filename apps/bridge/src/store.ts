import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergeChatConfig, mergeConfig, resolveChatConfig, resolveConfig, type AvatarConfig, type ChatConfig } from "@agentar/core";

/** Where agentar keeps user data. Override with AGENTAR_HOME. */
export function agentarHome(): string {
  return process.env.AGENTAR_HOME ?? join(homedir(), ".agentar");
}

/**
 * Loads and persists the avatar config as JSON. The chat settings live in
 * the same file under `chat`, but apart from the avatar config: they may
 * hold API keys, and the avatar config is broadcast to every view.
 */
export class ConfigStore {
  private config: AvatarConfig;
  private chat: ChatConfig;

  private constructor(
    private readonly file: string,
    initial: AvatarConfig,
    chat: ChatConfig,
  ) {
    this.config = initial;
    this.chat = chat;
  }

  static async open(file = join(agentarHome(), "config.json")): Promise<ConfigStore> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      raw = undefined; // missing or corrupt: start from defaults
    }
    const chat = typeof raw === "object" && raw !== null ? (raw as { chat?: unknown }).chat : undefined;
    return new ConfigStore(file, resolveConfig(raw), resolveChatConfig(chat));
  }

  get(): AvatarConfig {
    return this.config;
  }

  getChat(): ChatConfig {
    return this.chat;
  }

  async update(patch: unknown): Promise<AvatarConfig> {
    this.config = mergeConfig(this.config, patch);
    await this.save();
    return this.config;
  }

  async updateChat(patch: unknown): Promise<ChatConfig> {
    this.chat = mergeChatConfig(this.chat, patch);
    await this.save();
    return this.chat;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written file.
    // Owner-only, because the chat settings may contain API keys.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...this.config, chat: this.chat }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.file);
  }
}
