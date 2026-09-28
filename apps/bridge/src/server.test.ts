import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage, VoiceSettings } from "@agentar/core";
import { startBridge, type Bridge } from "./server.js";
import { parseSayVoices } from "./tts/system.js";
import type { TtsProvider } from "./tts/types.js";

class FakeTts implements TtsProvider {
  calls: string[] = [];
  /** The engine's binary is not installed. */
  missing = false;
  /** The engine is installed but cannot render (say, no internet). */
  broken = false;
  constructor(
    readonly id = "system",
    private readonly mime = "audio/wav",
  ) {}
  async unavailableReason() {
    return this.missing ? `${this.id} is not installed` : null;
  }
  async listVoices() {
    return [{ id: "Fake", name: "Fake", language: "en-US" }];
  }
  async synthesize(text: string, _voice: VoiceSettings) {
    if (this.missing || this.broken) throw new Error(`${this.id} failed`);
    this.calls.push(text);
    return { data: Buffer.from("RIFFfake"), mime: this.mime };
  }
}

let bridge: Bridge;
let home: string;
let tts: FakeTts;
let edge: FakeTts;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentar-test-"));
  tts = new FakeTts();
  edge = new FakeTts("edge", "audio/mpeg");
  bridge = await startBridge({ port: 0, homeDir: home, providers: { system: tts, edge }, log: () => undefined });
});

afterEach(async () => {
  await bridge.close();
  await rm(home, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) => fetch(`${bridge.url}${path}`, init);
const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Connect a fake avatar client that records messages. */
async function connectAvatar(): Promise<{ ws: WebSocket; messages: ServerMessage[]; next: (type: string) => Promise<ServerMessage> }> {
  const ws = new WebSocket(`${bridge.url.replace("http", "ws")}/ws`);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    messages.push(msg);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
  });
  const next = (type: string) => {
    const seen = messages.find((m) => m.type === type);
    if (seen) {
      messages.splice(messages.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise<ServerMessage>((resolve) => waiters.push({ type, resolve }));
  };
  await next("hello");
  return { ws, messages, next };
}

describe("bridge HTTP API", () => {
  it("reports health", async () => {
    const res = await api("/api/health");
    expect(await res.json()).toMatchObject({ ok: true, name: "agentar", clients: 0 });
  });

  it("refuses to speak when no avatar is connected", async () => {
    const res = await post("/api/say", { text: "hello" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "no-clients" });
  });

  it("validates say requests", async () => {
    expect((await post("/api/say", { text: "   " })).status).toBe(400);
    expect((await post("/api/say", { text: "x".repeat(6000) })).status).toBe(400);
  });

  it("merges and persists config updates", async () => {
    const res = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", appearance: { hair: "#aa3300" } }),
    });
    const config = await res.json();
    expect(config.name).toBe("Ada");
    expect(config.appearance.hair).toBe("#aa3300");
    expect(config.voice.provider).toBe("system");
  });

  it("blocks cross-origin browser requests", async () => {
    const res = await api("/api/say", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "text/plain" },
      body: "hi",
    });
    expect(res.status).toBe(403);
  });

  it("allows opted-in origins, such as a meeting-bot tunnel", async () => {
    const tunnel = "https://abc.trycloudflare.com";
    const open = await startBridge({ port: 0, homeDir: home, allowedOrigins: [`${tunnel}/`], log: () => undefined });
    try {
      const ok = await fetch(`${open.url}/api/health`, { headers: { Origin: tunnel } });
      expect(ok.status).toBe(200);
      const other = await fetch(`${open.url}/api/health`, { headers: { Origin: "https://evil.example" } });
      expect(other.status).toBe(403);
      const ws = new WebSocket(`${open.url.replace("http", "ws")}/ws`, { origin: tunnel });
      const hello = await new Promise<ServerMessage>((resolve, reject) => {
        ws.once("message", (raw) => resolve(JSON.parse(String(raw)) as ServerMessage));
        ws.once("error", reject);
      });
      expect(hello.type).toBe("hello");
      ws.close();
    } finally {
      await open.close();
    }
  });

  it("does not serve files outside the models directory", async () => {
    const res = await api("/models/..%2F..%2Fpackage.json");
    expect([403, 404]).toContain(res.status);
  });

  it("rejects uploads that are not glTF", async () => {
    const res = await api("/api/models?name=x.glb", { method: "POST", body: "not a model" });
    expect(res.status).toBe(400);
  });

  it("lists voices of the active provider", async () => {
    const body = await (await api("/api/voices")).json();
    expect(body).toMatchObject({ provider: "system", available: true, voices: [{ id: "Fake" }] });
  });
});

describe("speaking", () => {
  it("renders audio, sends it to avatars, and completes on speech-end", async () => {
    const avatar = await connectAvatar();
    const pending = post("/api/say", { text: "Hello there", mood: "happy", wait: true });
    const speak = await avatar.next("speak");
    if (speak.type !== "speak") throw new Error("expected speak");
    expect(speak.utterance.text).toBe("Hello there");
    expect(speak.utterance.mood).toBe("happy");
    expect(speak.utterance.audio?.mime).toBe("audio/wav");

    const audio = await api(speak.utterance.audio!.url);
    expect(Buffer.from(await audio.arrayBuffer()).toString()).toBe("RIFFfake");

    avatar.ws.send(JSON.stringify({ type: "speech-end", id: speak.utterance.id }));
    const res = await pending;
    expect(await res.json()).toMatchObject({ id: speak.utterance.id, status: "spoken" });
    avatar.ws.close();
  });

  it("survives malformed avatar messages", async () => {
    const avatar = await connectAvatar();
    for (const raw of ["null", "42", '"text"', "[]"]) avatar.ws.send(raw);
    await new Promise((r) => setTimeout(r, 50));
    const res = await api("/api/health");
    expect(await res.json()).toMatchObject({ ok: true, clients: 1 });
    avatar.ws.close();
  });

  it("does not fail an utterance while another avatar is still speaking", async () => {
    const blocked = await connectAvatar();
    const speaking = await connectAvatar();
    const pending = post("/api/say", { text: "Hello there", wait: true });
    const speak = await speaking.next("speak");
    if (speak.type !== "speak") throw new Error("expected speak");
    const id = speak.utterance.id;

    blocked.ws.send(JSON.stringify({ type: "speech-end", id, error: "Audio is blocked" }));
    await new Promise((r) => setTimeout(r, 50));
    speaking.ws.send(JSON.stringify({ type: "speech-end", id }));
    expect(await (await pending).json()).toMatchObject({ id, status: "spoken" });
    blocked.ws.close();
    speaking.ws.close();
  });

  it("accepts plain-text bodies", async () => {
    const avatar = await connectAvatar();
    const res = await api("/api/say", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "Plain words" });
    expect(await res.json()).toMatchObject({ status: "queued" });
    expect(tts.calls).toEqual(["Plain words"]);
    avatar.ws.close();
  });

  it("interrupts the current utterance by default", async () => {
    const avatar = await connectAvatar();
    const first = post("/api/say", { text: "First", wait: true });
    await avatar.next("speak");
    await post("/api/say", { text: "Second" });
    expect(await (await first).json()).toMatchObject({ status: "interrupted" });
    expect((await avatar.next("stop")).type).toBe("stop");
    avatar.ws.close();
  });

  it("queues when interrupt is false", async () => {
    const avatar = await connectAvatar();
    await post("/api/say", { text: "One" });
    const s1 = await avatar.next("speak");
    const res2 = await post("/api/say", { text: "Two", interrupt: false });
    expect(await res2.json()).toMatchObject({ status: "queued" });
    if (s1.type !== "speak") throw new Error();
    avatar.ws.send(JSON.stringify({ type: "speech-end", id: s1.utterance.id }));
    const s2 = await avatar.next("speak");
    expect(s2.type === "speak" && s2.utterance.text).toBe("Two");
    avatar.ws.close();
  });

  it("skips rendering for the browser voice provider", async () => {
    await bridge.store.update({ voice: { provider: "browser" } });
    const avatar = await connectAvatar();
    await post("/api/say", { text: "Browser speaks" });
    const speak = await avatar.next("speak");
    expect(speak.type === "speak" && speak.utterance.audio).toBeUndefined();
    expect(tts.calls).toEqual([]);
    avatar.ws.close();
  });

  it("broadcasts gestures and moods", async () => {
    const avatar = await connectAvatar();
    await post("/api/gesture", { gesture: "nod" });
    expect(await avatar.next("gesture")).toEqual({ type: "gesture", gesture: "nod" });
    await post("/api/mood", { mood: "thinking" });
    expect(await avatar.next("mood")).toEqual({ type: "mood", mood: "thinking" });
    expect((await post("/api/gesture", { gesture: "dance" })).status).toBe(400);
    avatar.ws.close();
  });
});

describe("voice fallback", () => {
  /** Restart the bridge, as on a machine where the system engine is not installed. */
  async function restartWithoutSystemVoice(): Promise<void> {
    await bridge.close();
    tts = Object.assign(new FakeTts(), { missing: true });
    bridge = await startBridge({ port: 0, homeDir: home, providers: { system: tts, edge }, log: () => undefined });
  }

  const savedConfig = async () => JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { voice: VoiceSettings };

  it("switches a missing system engine to the browser on start and saves it", async () => {
    edge.missing = true;
    await restartWithoutSystemVoice();
    expect(bridge.store.get().voice.provider).toBe("browser");
    expect((await savedConfig()).voice.provider).toBe("browser");

    const avatar = await connectAvatar();
    const res = await post("/api/say", { text: "Hello" });
    expect(res.status).toBe(200);
    const speak = await avatar.next("speak");
    expect(speak.type === "speak" && speak.utterance.audio).toBeUndefined();
    avatar.ws.close();
  });

  it("prefers edge-tts over the browser when it is installed", async () => {
    await restartWithoutSystemVoice();
    expect(bridge.store.get().voice.provider).toBe("edge");

    const avatar = await connectAvatar();
    await post("/api/say", { text: "Hello" });
    const speak = await avatar.next("speak");
    expect(speak.type === "speak" && speak.utterance.audio?.mime).toBe("audio/mpeg");
    expect(edge.calls).toEqual(["Hello"]);
    avatar.ws.close();
  });

  it("falls back when the system engine disappears after start, and tells every view", async () => {
    const avatar = await connectAvatar();
    tts.missing = true;
    const res = await post("/api/say", { text: "Still here" });
    expect(res.status).toBe(200);
    const config = await avatar.next("config");
    expect(config.type === "config" && config.config.voice.provider).toBe("edge");
    const speak = await avatar.next("speak");
    expect(speak.type === "speak" && speak.utterance.audio?.mime).toBe("audio/mpeg");
    avatar.ws.close();
  });

  it("moves on to the browser when the fallback edge-tts cannot render", async () => {
    edge.broken = true;
    const avatar = await connectAvatar();
    tts.missing = true;
    const res = await post("/api/say", { text: "Hello" });
    expect(res.status).toBe(200);
    const speak = await avatar.next("speak");
    expect(speak.type === "speak" && speak.utterance.audio).toBeUndefined();
    expect(bridge.store.get().voice.provider).toBe("browser");
    avatar.ws.close();
  });

  describe("kokoro", () => {
    let kokoro: FakeTts;

    /** Restart the bridge with Kokoro chosen, as after picking it in the Voice tab. */
    async function restartWithKokoro(patch: { missing?: boolean; broken?: boolean } = {}): Promise<void> {
      await bridge.store.update({ voice: { provider: "kokoro", voice: "af_heart" } });
      await bridge.close();
      kokoro = Object.assign(new FakeTts("kokoro", "audio/mpeg"), patch);
      bridge = await startBridge({ port: 0, homeDir: home, providers: { system: tts, edge, kokoro }, log: () => undefined });
    }

    it("speaks with a running Kokoro server", async () => {
      await restartWithKokoro();
      expect(bridge.store.get().voice.provider).toBe("kokoro");
      const avatar = await connectAvatar();
      await post("/api/say", { text: "Hello" });
      const speak = await avatar.next("speak");
      expect(speak.type === "speak" && speak.utterance.audio?.mime).toBe("audio/mpeg");
      expect(kokoro.calls).toEqual(["Hello"]);
      expect(tts.calls).toEqual([]);
      avatar.ws.close();
    });

    it("switches to the system engine on start when no Kokoro server answers, and saves it", async () => {
      await restartWithKokoro({ missing: true });
      expect(bridge.store.get().voice).toMatchObject({ provider: "system", voice: "" });
      expect((await savedConfig()).voice.provider).toBe("system");
    });

    it("switches to edge-tts when neither Kokoro nor the system engine is available", async () => {
      tts.missing = true;
      await restartWithKokoro({ missing: true });
      expect(bridge.store.get().voice.provider).toBe("edge");
    });

    it("switches to the browser when nothing else is available", async () => {
      tts.missing = true;
      edge.missing = true;
      await restartWithKokoro({ missing: true });
      expect(bridge.store.get().voice.provider).toBe("browser");
    });

    it("falls back when the Kokoro server stops after start, and tells every view", async () => {
      await restartWithKokoro();
      const avatar = await connectAvatar();
      kokoro.missing = true;
      const res = await post("/api/say", { text: "Still here" });
      expect(res.status).toBe(200);
      const config = await avatar.next("config");
      expect(config.type === "config" && config.config.voice.provider).toBe("system");
      const speak = await avatar.next("speak");
      expect(speak.type === "speak" && speak.utterance.audio?.mime).toBe("audio/wav");
      expect(tts.calls).toEqual(["Still here"]);
      avatar.ws.close();
    });

    it("reports errors from a running Kokoro server instead of switching", async () => {
      await restartWithKokoro({ broken: true });
      const avatar = await connectAvatar();
      const res = await post("/api/say", { text: "Hello" });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ status: "error", error: "kokoro failed" });
      expect(bridge.store.get().voice.provider).toBe("kokoro");
      avatar.ws.close();
    });

    it("lists why Kokoro is unavailable without switching", async () => {
      await restartWithKokoro();
      kokoro.missing = true;
      const body = await (await api("/api/voices?provider=kokoro")).json();
      expect(body).toMatchObject({ provider: "kokoro", available: false, reason: "kokoro is not installed", voices: [] });
      expect(bridge.store.get().voice.provider).toBe("kokoro");
    });
  });

  it("reports errors from an installed engine instead of switching", async () => {
    const avatar = await connectAvatar();
    tts.broken = true;
    const res = await post("/api/say", { text: "Hello" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "error", error: "system failed" });
    expect(bridge.store.get().voice.provider).toBe("system");
    avatar.ws.close();
  });
});

describe("chat", () => {
  let upstream: Server;
  let upstreamUrl: string;
  let requests: Array<{ url: string; auth?: string; body: any }>;

  beforeEach(async () => {
    requests = [];
    upstream = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      if (req.headers.authorization !== "Bearer gw") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "unauthorized" } }));
      }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const t of ["Hi ", "there"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hi there" } }] }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  });

  afterEach(async () => {
    await new Promise((r) => upstream.close(r));
  });

  const saveChat = (patch: unknown) =>
    api("/api/chat/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const hi = [{ role: "user", content: "Hello" }];

  it("saves connector settings without ever returning the key", async () => {
    const res = await saveChat({ connector: "hermes", sayReplies: false, connectors: { openclaw: { baseUrl: upstreamUrl, apiKey: "gw" } } });
    const view = await res.json();
    expect(view).toMatchObject({ connector: "hermes", sayReplies: false, connectors: { openclaw: { baseUrl: upstreamUrl, apiKeySet: true } } });
    expect(JSON.stringify(view)).not.toContain('"gw"');
    expect(JSON.stringify(await (await api("/api/chat/config")).json())).not.toContain('"gw"');

    // Saving other fields keeps the key; the avatar config (broadcast to every view) never carries chat settings.
    await saveChat({ connectors: { openclaw: { model: "openclaw/main" } } });
    expect(bridge.store.getChat().connectors.openclaw).toMatchObject({ apiKey: "gw", model: "openclaw/main" });
    expect(await (await api("/api/config")).json()).not.toHaveProperty("chat");

    const file = join(home, "config.json");
    expect(JSON.parse(await readFile(file, "utf8")).chat.connectors.openclaw.apiKey).toBe("gw");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
  });

  it("proxies a chat to OpenClaw and returns the reply", async () => {
    await saveChat({ connectors: { openclaw: { baseUrl: upstreamUrl, apiKey: "gw" } } });
    const res = await post("/api/chat", { messages: hi, conversation: "c1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connector: "openclaw", reply: "Hi there" });
    expect(requests[0]).toMatchObject({ url: "/v1/chat/completions", auth: "Bearer gw", body: { model: "openclaw/default", user: "agentar:c1" } });
  });

  it("streams replies as NDJSON", async () => {
    await saveChat({ connectors: { openclaw: { baseUrl: upstreamUrl, apiKey: "gw" } } });
    const res = await post("/api/chat", { messages: hi, stream: true });
    expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toEqual([
      { type: "delta", text: "Hi " },
      { type: "delta", text: "there" },
      { type: "done", connector: "openclaw", reply: "Hi there" },
    ]);
  });

  it("returns a real status code when a streamed chat fails before any text", async () => {
    await saveChat({ connectors: { openclaw: { baseUrl: upstreamUrl, apiKey: "wrong" } } });
    const res = await post("/api/chat", { messages: hi, stream: true });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "auth", error: expect.stringMatching(/OpenClaw refused the request \(401\)/) });
  });

  it("reports a gateway that is not running", async () => {
    await new Promise((r) => upstream.close(r));
    await saveChat({ connectors: { hermes: { baseUrl: upstreamUrl, apiKey: "k" } } });
    const res = await post("/api/chat", { connector: "hermes", messages: hi });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "unreachable", error: expect.stringMatching(/Could not reach Hermes .*connection refused/) });
    upstream = createServer().listen(0); // for afterEach
  });

  it("answers unsupported and unknown connectors clearly", async () => {
    const muse = await post("/api/chat", { connector: "muse", messages: hi });
    expect(muse.status).toBe(501);
    expect(await muse.json()).toMatchObject({ code: "unsupported" });

    const unknown = await post("/api/chat", { connector: "skynet", messages: hi });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "bad-request", error: expect.stringMatching(/Unknown connector/) });

    expect((await post("/api/chat", { messages: [] })).status).toBe(400);
  });

  it("blocks cross-origin chat requests", async () => {
    const res = await api("/api/chat", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: hi }),
    });
    expect(res.status).toBe(403);
    expect((await api("/api/chat/config", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });
});

describe("recording", () => {
  it("refuses to start with no avatar connected", async () => {
    const res = await post("/api/record/start", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/No avatar page is open/) });
  });

  it("records a clip end to end", async () => {
    const avatar = await connectAvatar();
    const startRes = await post("/api/record/start", {});
    expect(startRes.status).toBe(200);
    const { id } = await startRes.json();
    expect(id).toEqual(expect.any(String));

    const started = await avatar.next("record-start");
    expect(started).toEqual({ type: "record-start", id });

    const chunk1 = await api(`/api/record/${id}/chunk`, { method: "POST", headers: { "Content-Type": "video/webm" }, body: "abc" });
    expect(await chunk1.json()).toMatchObject({ ok: true, bytes: 3 });
    const chunk2 = await api(`/api/record/${id}/chunk`, { method: "POST", headers: { "Content-Type": "video/webm" }, body: "def" });
    expect(await chunk2.json()).toMatchObject({ ok: true, bytes: 3 });

    const stopping = post("/api/record/stop", {});
    const stopped = await avatar.next("record-stop");
    expect(stopped).toEqual({ type: "record-stop", id });

    const final = await api(`/api/record/${id}/chunk?final=1`, { method: "POST", headers: { "Content-Type": "video/webm" }, body: "" });
    expect(await final.json()).toMatchObject({ ok: true, bytes: 0 });

    const stopRes = await stopping;
    expect(stopRes.status).toBe(200);
    const body = await stopRes.json();
    expect(body).toMatchObject({ id, mime: "video/webm", bytes: 6 });
    expect(body.path).toContain(join(home, "recordings"));
    expect(await readFile(body.path, "utf8")).toBe("abcdef");

    const before = await stat(body.path);
    const second = await post("/api/record/stop", {});
    expect(second.status).toBe(409);
    const after = await stat(body.path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    avatar.ws.close();
  });

  it("fails a pending stop with 502 when the avatar reports record-error", async () => {
    const avatar = await connectAvatar();
    const { id } = await (await post("/api/record/start", {})).json();
    await avatar.next("record-start");
    await api(`/api/record/${id}/chunk`, { method: "POST", headers: { "Content-Type": "video/webm" }, body: "abc" });

    const stopping = post("/api/record/stop", {});
    await avatar.next("record-stop");
    avatar.ws.send(JSON.stringify({ type: "record-error", id, error: "camera went away" }));

    const res = await stopping;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "camera went away" });
    avatar.ws.close();
  });

  it("warns that the browser voice cannot be captured", async () => {
    await bridge.store.update({ voice: { provider: "browser" } });
    const avatar = await connectAvatar();
    const res = await post("/api/record/start", {});
    expect(await res.json()).toMatchObject({ status: "recording", warning: expect.stringMatching(/browser voice cannot be captured/) });
    avatar.ws.close();
  });
});

describe("join", () => {
  const room = { url: "wss://example.livekit.cloud", token: "secret-jwt" };

  /** Answer the next join sent to `avatar` with a join-result. */
  async function answerJoin(avatar: Awaited<ReturnType<typeof connectAvatar>>, result: Record<string, unknown>) {
    const msg = await avatar.next("join");
    if (msg.type !== "join") throw new Error("expected join");
    // next() leaves messages it handed to a waiter in the list; drop this one so the next join is fresh.
    const i = avatar.messages.indexOf(msg);
    if (i >= 0) avatar.messages.splice(i, 1);
    avatar.ws.send(JSON.stringify({ type: "join-result", id: msg.id, ...result }));
    return msg;
  }

  it("refuses to join when no avatar page is open", async () => {
    const res = await post("/api/join", room);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/No avatar page is open/) });
  });

  it("rejects a join without a token or a room URL", async () => {
    const avatar = await connectAvatar();
    expect((await post("/api/join", { url: room.url })).status).toBe(400);
    expect((await post("/api/join", { url: room.url, token: "  " })).status).toBe(400);
    expect((await post("/api/join", { url: "not a url", token: room.token })).status).toBe(400);
    expect((await post("/api/join", { url: "file:///etc/passwd", token: room.token })).status).toBe(400);
    expect(avatar.messages.some((m) => m.type === "join")).toBe(false);
    avatar.ws.close();
  });

  it("joins once the avatar page reports it connected and published", async () => {
    const avatar = await connectAvatar();
    const pending = post("/api/join", room);
    const msg = await answerJoin(avatar, { ok: true, room: "r" });
    expect(msg).toEqual({ type: "join", id: expect.any(String), url: room.url, token: room.token });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: (msg as { id: string }).id, status: "joined", room: "r" });
    avatar.ws.close();
  });

  it("rejects a join with invalid credentials instead of reporting joined", async () => {
    const avatar = await connectAvatar();
    const pending = post("/api/join", { ...room, token: "bad" });
    await answerJoin(avatar, { ok: false, error: "invalid token" });
    const res = await pending;
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid token" });
    // A failed join does not block the next one.
    const retry = post("/api/join", room);
    await answerJoin(avatar, { ok: true, room: "r" });
    expect((await retry).status).toBe(200);
    avatar.ws.close();
  });

  it("refuses a second join until leave, then joins again", async () => {
    const avatar = await connectAvatar();
    const first = post("/api/join", room);
    await answerJoin(avatar, { ok: true, room: "r" });
    expect((await first).status).toBe(200);

    expect((await post("/api/join", room)).status).toBe(409);

    const left = await post("/api/leave", {});
    expect(left.status).toBe(200);
    expect(await left.json()).toEqual({ ok: true });
    expect(await avatar.next("leave")).toEqual({ type: "leave" });

    const again = post("/api/join", room);
    await answerJoin(avatar, { ok: true, room: "r" });
    expect((await again).status).toBe(200);
    avatar.ws.close();
  });

  it("treats leave without a join as a no-op", async () => {
    const res = await post("/api/leave", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "not-joined" });
  });

  it("ignores a join-result from a page the join was not sent to", async () => {
    const other = await connectAvatar();
    const avatar = await connectAvatar();
    const pending = post("/api/join", room);
    const msg = await avatar.next("join");
    if (msg.type !== "join") throw new Error("expected join");
    other.ws.send(JSON.stringify({ type: "join-result", id: msg.id, ok: true, room: "spoofed" }));
    await new Promise((r) => setTimeout(r, 50));
    avatar.ws.send(JSON.stringify({ type: "join-result", id: msg.id, ok: false, error: "invalid token" }));
    expect((await pending).status).toBe(502);
    other.ws.close();
    avatar.ws.close();
  });

  it("fails a pending join with 502 when the avatar page disconnects", async () => {
    const avatar = await connectAvatar();
    const pending = post("/api/join", room);
    await avatar.next("join");
    avatar.ws.close();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/disconnected/) });
  });

  it("forgets the room when the joined avatar page disconnects, so leave is a no-op", async () => {
    const avatar = await connectAvatar();
    const pending = post("/api/join", room);
    await answerJoin(avatar, { ok: true, room: "r" });
    expect((await pending).status).toBe(200);
    avatar.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await (await post("/api/leave", {})).json()).toEqual({ ok: true, status: "not-joined" });
  });

  it("times out a join the avatar page never answers, and tells it to leave", async () => {
    const quick = await startBridge({ port: 0, homeDir: home, providers: { system: tts, edge }, joinTimeoutMs: 50, log: () => undefined });
    try {
      const ws = new WebSocket(`${quick.url.replace("http", "ws")}/ws`);
      const seen: ServerMessage[] = [];
      await new Promise<void>((resolve) =>
        ws.on("message", (raw) => {
          seen.push(JSON.parse(String(raw)) as ServerMessage);
          resolve();
        }),
      );
      const res = await fetch(`${quick.url}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(room) });
      expect(res.status).toBe(504);
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.map((m) => m.type)).toEqual(["hello", "join", "leave"]);
      ws.close();
    } finally {
      await quick.close();
    }
  });

  it("warns on join that the browser voice cannot be captured", async () => {
    await bridge.store.update({ voice: { provider: "browser" } });
    const avatar = await connectAvatar();
    const pending = post("/api/join", room);
    await answerJoin(avatar, { ok: true, room: "r" });
    expect(await (await pending).json()).toMatchObject({ status: "joined", warning: expect.stringMatching(/browser voice cannot be captured/) });
    avatar.ws.close();
  });

  it("never logs the join token", async () => {
    const lines: string[] = [];
    const logged = await startBridge({ port: 0, homeDir: home, providers: { system: tts, edge }, log: (m) => lines.push(m) });
    try {
      const ws = new WebSocket(`${logged.url.replace("http", "ws")}/ws`);
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as ServerMessage;
        if (msg.type === "join") ws.send(JSON.stringify({ type: "join-result", id: msg.id, ok: true, room: "r" }));
      });
      await new Promise((r) => ws.once("open", r));
      const res = await fetch(`${logged.url}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(room) });
      expect(res.status).toBe(200);
      expect(lines.some((l) => l.includes("joined room r"))).toBe(true);
      expect(lines.join("\n")).not.toContain(room.token);
      ws.close();
    } finally {
      await logged.close();
    }
  });

  describe("reconnect", () => {
    const status = async () => (await api("/api/status")).json();
    const settle = () => new Promise((r) => setTimeout(r, 50));

    async function joinWith(avatar: Awaited<ReturnType<typeof connectAvatar>>) {
      const pending = post("/api/join", room);
      await answerJoin(avatar, { ok: true, room: "r" });
      expect((await pending).status).toBe(200);
    }

    it("reports not-joined status with no join", async () => {
      const res = await api("/api/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, clients: 0, room: { state: "not-joined" } });
    });

    it("tracks the room going disconnected while rejoining and connected again", async () => {
      const avatar = await connectAvatar();
      await joinWith(avatar);
      expect(await status()).toEqual({
        ok: true,
        clients: 1,
        room: { state: "connected", rejoining: false, room: "r", since: expect.any(String) },
      });

      avatar.ws.send(JSON.stringify({ type: "room-state", state: "disconnected", rejoining: true, room: "r" }));
      await settle();
      expect((await status()).room).toMatchObject({ state: "disconnected", rejoining: true, room: "r" });

      avatar.ws.send(JSON.stringify({ type: "room-state", state: "connected", rejoining: false, room: "r" }));
      await settle();
      expect((await status()).room).toMatchObject({ state: "connected", rejoining: false, room: "r" });
      avatar.ws.close();
    });

    it("ignores room-state from another page or without an active join", async () => {
      const other = await connectAvatar();
      other.ws.send(JSON.stringify({ type: "room-state", state: "disconnected", rejoining: true }));
      await settle();
      expect((await status()).room).toEqual({ state: "not-joined" });

      const avatar = await connectAvatar();
      await joinWith(avatar);
      other.ws.send(JSON.stringify({ type: "room-state", state: "disconnected", rejoining: true }));
      await settle();
      expect((await status()).room).toMatchObject({ state: "connected" });
      other.ws.close();
      avatar.ws.close();
    });

    it("shows the error once the page gives up, and not-joined after leave", async () => {
      const avatar = await connectAvatar();
      await joinWith(avatar);
      avatar.ws.send(
        JSON.stringify({ type: "room-state", state: "disconnected", rejoining: false, room: "r", error: "Could not rejoin the room after a network drop" }),
      );
      await settle();
      const body = await status();
      expect(body.room).toMatchObject({ state: "disconnected", rejoining: false, error: "Could not rejoin the room after a network drop" });
      expect(JSON.stringify(body)).not.toContain(room.token);

      expect((await post("/api/leave", {})).status).toBe(200);
      expect((await status()).room).toEqual({ state: "not-joined" });
      avatar.ws.close();
    });

    it("never puts the token in the status body", async () => {
      const avatar = await connectAvatar();
      await joinWith(avatar);
      expect(await (await api("/api/status")).text()).not.toContain(room.token);
      avatar.ws.close();
    });
  });
});

describe("parseSayVoices", () => {
  it("parses macOS voice list lines", () => {
    const out = "Albert              en_US    # Hello! My name is Albert.\nEddy (English (UK)) en_GB    # Hello! My name is Eddy.\n";
    expect(parseSayVoices(out)).toEqual([
      { id: "Albert", name: "Albert", language: "en-US" },
      { id: "Eddy (English (UK))", name: "Eddy (English (UK))", language: "en-GB" },
    ]);
  });
});
