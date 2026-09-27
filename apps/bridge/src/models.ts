import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { BUILTIN_MODELS, DEFAULT_CONFIG } from "@agentar/core";
import { agentarHome } from "./store.js";

const MODELS_URL = "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars";

// This file sits at apps/bridge/{src,dist}/ in a checkout, and inside the
// bundled CLI at <package>/dist/ when installed from npm.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/** The built web UI: apps/web/dist in a checkout, or web/ next to the bundled CLI in the npm package. */
export function defaultWebDir(): string {
  const candidates = [join(REPO_ROOT, "apps/web/dist"), resolve(HERE, "../web")];
  return candidates.find((d) => existsSync(join(d, "index.html"))) ?? candidates[0]!;
}

/** Built-in avatar models: assets/models in a checkout, otherwise ~/.agentar/builtin-models. */
export function defaultModelsDir(home = agentarHome()): string {
  const repo = join(REPO_ROOT, "assets/models");
  return existsSync(join(repo, "README.md")) ? repo : join(home, "builtin-models");
}

/** The CLI entry point in a checkout, for commands shown in the Connect tab. */
export function defaultCliPath(): string {
  return join(REPO_ROOT, "packages/cli/dist/index.js");
}

export interface FetchModelsOptions {
  /** Also download the non-commercial sample avatars. */
  all?: boolean;
  /** Stay silent about models that are already present. */
  quiet?: boolean;
  log?: (msg: string) => void;
}

/**
 * Download the built-in avatar models into `dir`. By default only the CC0
 * default avatar. Files that are already present are skipped. Returns false
 * if any download failed.
 */
export async function fetchModels(dir: string, opts: FetchModelsOptions = {}): Promise<boolean> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const defaultId = DEFAULT_CONFIG.model.source === "builtin" ? DEFAULT_CONFIG.model.id : "";
  await mkdir(dir, { recursive: true });
  let ok = true;
  for (const m of BUILTIN_MODELS) {
    if (!opts.all && m.id !== defaultId) continue;
    const dest = join(dir, m.file);
    try {
      if ((await stat(dest)).size > 1000) {
        if (!opts.quiet) log(`✓ ${m.file} already present`);
        continue;
      }
    } catch {
      /* not downloaded yet */
    }
    log(`↓ ${m.file} (${m.license}) …`);
    try {
      const res = await fetch(`${MODELS_URL}/${m.file}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(`${dest}.part`));
      await rename(`${dest}.part`, dest);
      log(`✓ ${m.file} downloaded`);
    } catch (err) {
      await rm(`${dest}.part`, { force: true });
      log(`✗ ${m.file} failed: ${(err as Error).message}`);
      ok = false;
    }
  }
  return ok;
}
