import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergeConfig, resolveConfig, type AvatarConfig } from "@agentar/core";

/** Where agentar keeps user data. Override with AGENTAR_HOME. */
export function agentarHome(): string {
  return process.env.AGENTAR_HOME ?? join(homedir(), ".agentar");
}

/** Loads and persists the avatar config as JSON. */
export class ConfigStore {
  private config: AvatarConfig;

  private constructor(private readonly file: string, initial: AvatarConfig) {
    this.config = initial;
  }

  static async open(file = join(agentarHome(), "config.json")): Promise<ConfigStore> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      raw = undefined; // missing or corrupt: start from defaults
    }
    return new ConfigStore(file, resolveConfig(raw));
  }

  get(): AvatarConfig {
    return this.config;
  }

  async update(patch: unknown): Promise<AvatarConfig> {
    this.config = mergeConfig(this.config, patch);
    await mkdir(dirname(this.file), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.config, null, 2) + "\n", "utf8");
    await rename(tmp, this.file);
    return this.config;
  }
}
