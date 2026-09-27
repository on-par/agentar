import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage, VoiceSettings } from "@agentar/core";
import { startBridge, type Bridge } from "./server.js";
import { parseSayVoices } from "./tts/system.js";
import type { TtsProvider } from "./tts/types.js";

class FakeTts implements TtsProvider {
  readonly id = "system";
  calls: string[] = [];
  async unavailableReason() {
    return null;
  }
  async listVoices() {
    return [{ id: "Fake", name: "Fake", language: "en-US" }];
  }
  async synthesize(text: string, _voice: VoiceSettings) {
    this.calls.push(text);
    return { data: Buffer.from("RIFFfake"), mime: "audio/wav" };
  }
}

let bridge: Bridge;
let home: string;
let tts: FakeTts;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agentar-test-"));
  tts = new FakeTts();
  bridge = await startBridge({ port: 0, homeDir: home, providers: { system: tts }, log: () => undefined });
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

describe("parseSayVoices", () => {
  it("parses macOS voice list lines", () => {
    const out = "Albert              en_US    # Hello! My name is Albert.\nEddy (English (UK)) en_GB    # Hello! My name is Eddy.\n";
    expect(parseSayVoices(out)).toEqual([
      { id: "Albert", name: "Albert", language: "en-US" },
      { id: "Eddy (English (UK))", name: "Eddy (English (UK))", language: "en-GB" },
    ]);
  });
});
