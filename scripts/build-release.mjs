#!/usr/bin/env node
// Assembles the publishable `agentar` npm package in release/agentar/:
//   dist/agentar.js  the CLI with the bridge, MCP server and core bundled in
//   web/             the built browser app (run `npm run build` first)
// The workspace packages stay private; only this folder is published.
// Usage: npm run build && npm run release:build && npm publish ./release/agentar
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release/agentar");
const readJson = async (p) => JSON.parse(await readFile(join(root, p), "utf8"));

const rootPkg = await readJson("package.json");
const bridgePkg = await readJson("apps/bridge/package.json");
const mcpPkg = await readJson("packages/mcp/package.json");

if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  console.error("apps/web/dist is missing. Run `npm run build` first.");
  process.exit(1);
}

// Runtime dependencies stay external and are installed by npm.
const dependencies = {
  ws: bridgePkg.dependencies.ws,
  "@modelcontextprotocol/sdk": mcpPkg.dependencies["@modelcontextprotocol/sdk"],
  zod: mcpPkg.dependencies.zod,
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, "packages/cli/src/index.ts")],
  outfile: join(out, "dist/agentar.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Resolve @agentar/* workspace packages to their TypeScript sources.
  conditions: ["development"],
  external: Object.keys(dependencies),
  legalComments: "linked",
  logLevel: "warning",
});

await cp(join(root, "apps/web/dist"), join(out, "web"), { recursive: true });
// OpenClaw skills ship next to the CLI so the Connect tab can point at them. Tests stay behind.
await cp(join(root, "skills"), join(out, "skills"), { recursive: true, filter: (src) => !src.endsWith(".test.ts") });
for (const f of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) await cp(join(root, f), join(out, f));

const pkg = {
  name: "agentar",
  version: rootPkg.version,
  description: rootPkg.description,
  keywords: ["ai", "agent", "avatar", "claude-code", "codex", "mcp", "text-to-speech", "lip-sync", "three.js"],
  license: rootPkg.license,
  repository: rootPkg.repository,
  homepage: rootPkg.homepage,
  bugs: rootPkg.bugs,
  type: "module",
  bin: { agentar: "dist/agentar.js" },
  files: ["dist", "web", "skills", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  engines: rootPkg.engines,
  dependencies,
};
await writeFile(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Built release/agentar (agentar@${pkg.version}).`);
