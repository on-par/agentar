import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BUILTIN_MODELS,
  DEFAULT_PORT,
  GESTURES,
  PROTOCOL_VERSION,
  VOICE_PROVIDERS,
  isMood,
  type ClientMessage,
  type Gesture,
  type HealthResponse,
  type SayRequest,
  type ServerMessage,
  type VoiceProvider,
} from "@agentar/core";
import { defaultCliPath, defaultModelsDir, defaultWebDir } from "./models.js";
import { SpeechQueue, type RenderedAudio } from "./speech-queue.js";
import { ConfigStore, agentarHome } from "./store.js";
import { ElevenLabsTts, OpenAiTts, XaiTts } from "./tts/cloud.js";
import { EdgeTts } from "./tts/edge.js";
import { SystemTts } from "./tts/system.js";
import type { TtsProvider } from "./tts/types.js";

export const VERSION = "0.1.0";

export interface BridgeOptions {
  port?: number;
  /** Interface to bind. Default 127.0.0.1 (local only). */
  host?: string;
  /** Directory with the built web UI. Default apps/web/dist, or web/ in the npm package. */
  webDir?: string;
  /** Directory with built-in avatar models. Default assets/models, or ~/.agentar/builtin-models. */
  modelsDir?: string;
  /** Path of the CLI entry point, shown in the Connect tab's commands. */
  cliPath?: string;
  /** Where config and uploaded models live. Default ~/.agentar. */
  homeDir?: string;
  /** Override TTS engines (tests). */
  providers?: Partial<Record<VoiceProvider, TtsProvider>>;
  log?: (msg: string) => void;
}

export interface Bridge {
  server: Server;
  url: string;
  port: number;
  store: ConfigStore;
  queue: SpeechQueue;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".vrm": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

const MAX_JSON = 256 * 1024;
const MAX_MODEL = 150 * 1024 * 1024;
const MAX_TEXT = 5000;
const AUDIO_TTL_MS = 10 * 60 * 1000;

/** Start the bridge server. */
export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const port = opts.port ?? Number(process.env.AGENTAR_PORT ?? DEFAULT_PORT);
  const host = opts.host ?? process.env.AGENTAR_HOST ?? "127.0.0.1";
  const home = opts.homeDir ?? agentarHome();
  const webDir = opts.webDir ?? process.env.AGENTAR_WEB_DIR ?? defaultWebDir();
  const modelsDir = opts.modelsDir ?? process.env.AGENTAR_MODELS_DIR ?? defaultModelsDir(home);
  const cliPath = opts.cliPath ?? defaultCliPath();
  const userModelsDir = join(home, "models");
  const log = opts.log ?? ((m: string) => console.log(`[agentar] ${m}`));

  const store = await ConfigStore.open(join(home, "config.json"));
  const providers: Record<Exclude<VoiceProvider, "browser">, TtsProvider> = {
    system: opts.providers?.system ?? new SystemTts(),
    edge: opts.providers?.edge ?? new EdgeTts(),
    openai: opts.providers?.openai ?? new OpenAiTts(),
    elevenlabs: opts.providers?.elevenlabs ?? new ElevenLabsTts(),
    xai: opts.providers?.xai ?? new XaiTts(),
  };

  let publicUrl = "";
  const audio = new Map<string, { data: Buffer; mime: string; expires: number }>();
  const clients = new Map<WebSocket, { id: string }>();

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  };

  const queue = new SpeechQueue({
    clientCount: () => clients.size,
    speechRate: () => store.get().voice.rate,
    broadcast,
    render: async (id, text, signal): Promise<RenderedAudio | null> => {
      const voice = store.get().voice;
      if (voice.provider === "browser") return null;
      const { data, mime } = await providers[voice.provider].synthesize(text, voice, signal);
      const now = Date.now();
      for (const [k, v] of audio) if (v.expires < now) audio.delete(k);
      audio.set(id, { data, mime, expires: now + AUDIO_TTL_MS });
      return { url: `/api/audio/${id}`, mime };
    },
  });

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = (err as { status?: number }).status;
      if (!status) log(`error: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) sendJson(res, status ?? 500, { error: status ? (err as Error).message : "Internal error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (!originAllowed(req)) return sendJson(res, 403, { error: "Cross-origin requests are not allowed" });

    if (path === "/api/health" && method === "GET") {
      const body: HealthResponse = { ok: true, name: "agentar", version: VERSION, clients: clients.size };
      return sendJson(res, 200, body);
    }

    if (path === "/api/info" && method === "GET") {
      return sendJson(res, 200, { version: VERSION, url: publicUrl, cliPath });
    }

    if (path === "/api/config") {
      if (method === "GET") return sendJson(res, 200, store.get());
      if (method === "PUT" || method === "PATCH") {
        const patch = await readJson(req);
        const config = await store.update(patch);
        broadcast({ type: "config", config });
        return sendJson(res, 200, config);
      }
    }

    if (path === "/api/say" && method === "POST") {
      const body = await readSayBody(req);
      if (!body) return sendJson(res, 400, { error: "Provide non-empty `text` (max 5000 chars)." });
      const result = await queue.say(body);
      const status = result.status === "error" ? 502 : result.status === "no-clients" ? 409 : 200;
      return sendJson(res, status, result);
    }

    if (path === "/api/stop" && method === "POST") {
      queue.stop();
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/mood" && method === "POST") {
      const body = (await readJson(req)) as { mood?: unknown; persist?: unknown };
      if (!isMood(body.mood)) return sendJson(res, 400, { error: "Unknown mood" });
      if (body.persist) {
        broadcast({ type: "config", config: await store.update({ behavior: { mood: body.mood } }) });
      } else {
        broadcast({ type: "mood", mood: body.mood });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/gesture" && method === "POST") {
      const body = (await readJson(req)) as { gesture?: unknown };
      if (typeof body.gesture !== "string" || !(GESTURES as readonly string[]).includes(body.gesture)) {
        return sendJson(res, 400, { error: `gesture must be one of ${GESTURES.join(", ")}` });
      }
      broadcast({ type: "gesture", gesture: body.gesture as Gesture });
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/voices" && method === "GET") {
      const p = url.searchParams.get("provider") ?? store.get().voice.provider;
      if (!(VOICE_PROVIDERS as readonly string[]).includes(p)) return sendJson(res, 400, { error: "Unknown provider" });
      if (p === "browser") return sendJson(res, 200, { provider: p, available: true, voices: [] });
      const provider = providers[p as Exclude<VoiceProvider, "browser">];
      const reason = await provider.unavailableReason();
      if (reason) return sendJson(res, 200, { provider: p, available: false, reason, voices: [] });
      try {
        return sendJson(res, 200, { provider: p, available: true, voices: await provider.listVoices() });
      } catch (err) {
        return sendJson(res, 200, { provider: p, available: false, reason: (err as Error).message, voices: [] });
      }
    }

    const audioMatch = /^\/api\/audio\/([\w-]+)$/.exec(path);
    if (audioMatch && method === "GET") {
      const clip = audio.get(audioMatch[1]!);
      if (!clip) return sendJson(res, 404, { error: "Audio expired" });
      res.writeHead(200, { "Content-Type": clip.mime, "Content-Length": clip.data.length, "Cache-Control": "no-store" });
      res.end(clip.data);
      return;
    }

    if (path === "/api/models" && method === "GET") {
      const builtin = await Promise.all(
        BUILTIN_MODELS.map(async (m) => ({
          id: m.id,
          label: m.label,
          license: m.license,
          url: `/models/${m.file}`,
          available: await exists(join(modelsDir, m.file)),
        })),
      );
      let user: Array<{ name: string; url: string }> = [];
      try {
        user = (await readdir(userModelsDir))
          .filter((f) => /\.(glb|vrm)$/i.test(f))
          .map((f) => ({ name: f, url: `/models/user/${encodeURIComponent(f)}` }));
      } catch {
        /* no uploads yet */
      }
      return sendJson(res, 200, { builtin, user });
    }

    if (path === "/api/models" && method === "POST") {
      const name = sanitizeFileName(url.searchParams.get("name") ?? "");
      if (!name) return sendJson(res, 400, { error: "Pass ?name=<file>.glb or .vrm" });
      const data = await readBody(req, MAX_MODEL);
      if (data.subarray(0, 4).toString("latin1") !== "glTF") return sendJson(res, 400, { error: "Not a binary glTF (.glb/.vrm) file" });
      await mkdir(userModelsDir, { recursive: true });
      await writeFile(join(userModelsDir, name), data);
      log(`saved custom model ${name} (${(data.length / 1e6).toFixed(1)} MB)`);
      return sendJson(res, 201, { name, url: `/models/user/${encodeURIComponent(name)}` });
    }

    if (path.startsWith("/models/user/")) {
      await serveFile(res, userModelsDir, decodeURIComponent(path.slice("/models/user/".length)));
      return;
    }
    if (path.startsWith("/models/")) {
      await serveFile(res, modelsDir, decodeURIComponent(path.slice("/models/".length)));
      return;
    }

    if (path.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });

    // Web UI (single-page app)
    if (method === "GET") {
      const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      if (await serveFile(res, webDir, rel, true)) return;
      if (await serveFile(res, webDir, "index.html", true)) return;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><title>agentar</title><body style="font-family:system-ui;background:#111;color:#eee;padding:2rem">` +
          `<h1>agentar bridge is running</h1><p>The web UI is not built yet. Run <code>npm run build</code>, ` +
          `or use <code>npm run dev</code> and open <a style="color:#8cf" href="http://localhost:5173">http://localhost:5173</a>.</p>`,
      );
      return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
  }

  async function serveFile(res: ServerResponse, root: string, rel: string, quiet = false): Promise<boolean> {
    const full = normalize(join(root, rel));
    if (!full.startsWith(normalize(root) + sep)) {
      if (!quiet) sendJson(res, 403, { error: "Forbidden" });
      return false;
    }
    let info;
    try {
      info = await stat(full);
    } catch {
      if (!quiet) {
        sendJson(res, 404, {
          error: rel.endsWith(".glb") ? "Model not found. Run `agentar fetch-models` to download the built-in avatars." : "Not found",
        });
      }
      return false;
    }
    if (!info.isFile()) {
      if (!quiet) sendJson(res, 404, { error: "Not found" });
      return false;
    }
    const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    const immutable = full.includes(`${sep}assets${sep}`) && full.startsWith(normalize(webDir));
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": info.size,
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(full).pipe(res);
    return true;
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== "/ws" || !originAllowed(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const clientId = randomUUID();
    clients.set(ws, { id: clientId });
    log(`avatar connected (${clients.size} total)`);
    ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, config: store.get(), clientId } satisfies ServerMessage));
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      // A throw in this listener would crash the bridge, so ignore anything that is not an object.
      if (typeof msg !== "object" || msg === null) return;
      if (msg.type === "speech-end" && typeof msg.id === "string") {
        queue.speechEnded(msg.id, Boolean(msg.interrupted), typeof msg.error === "string" ? msg.error : undefined);
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      log(`avatar disconnected (${clients.size} left)`);
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const actualPort = (server.address() as { port: number }).port;
  const url = (publicUrl = `http://${host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host}:${actualPort}`);
  log(`bridge listening on ${url}`);

  return {
    server,
    url,
    port: actualPort,
    store,
    queue,
    close: () =>
      new Promise<void>((r) => {
        queue.stop();
        for (const ws of clients.keys()) ws.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
}

/**
 * Only same-machine pages may call the API from a browser. Requests without
 * an Origin header (curl, agents, the MCP server) are allowed; the server
 * binds to 127.0.0.1 so only local processes can reach it.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return !origin;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(req, MAX_JSON)).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Accept JSON ({text, mood, wait, interrupt}) or a plain-text body. */
async function readSayBody(req: IncomingMessage): Promise<SayRequest | null> {
  const type = req.headers["content-type"] ?? "";
  let body: Record<string, unknown>;
  if (type.startsWith("text/plain")) {
    body = { text: (await readBody(req, MAX_JSON)).toString("utf8") };
  } else {
    const parsed = await readJson(req);
    body = typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) return null;
  const out: SayRequest = { text };
  if (isMood(body.mood)) out.mood = body.mood;
  if (typeof body.wait === "boolean") out.wait = body.wait;
  if (typeof body.interrupt === "boolean") out.interrupt = body.interrupt;
  return out;
}

function sanitizeFileName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\w.\- ]/g, "_").slice(0, 100);
  return /\.(glb|vrm)$/i.test(clean) && !clean.startsWith(".") ? clean : null;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
