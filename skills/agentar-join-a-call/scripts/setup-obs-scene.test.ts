import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "@agentar/core";
import {
  authString,
  browserSourceSettings,
  connectObs,
  DEFAULT_AGENTAR_URL,
  identifyMessage,
  INPUT_NAME,
  manualChecklist,
  OpCode,
  requestMessage,
  SCENE_NAME,
  setupAgentarStage,
  stageUrl,
} from "./setup-obs-scene.mjs";

type Msg = { op: number; d: Record<string, any> };
type Handler = (d: Record<string, any>) => { ok: true; data?: unknown } | { ok: false; code: number; comment?: string };

/** In-memory stand-in for OBS's obs-websocket 5.x server. */
function fakeObs(opts: { auth?: { salt: string; challenge: string }; password?: string; handlers?: Record<string, Handler> } = {}) {
  const requests: Array<{ requestType: string; requestData?: any }> = [];
  class FakeWebSocket {
    listeners: Record<string, Array<(ev: any) => void>> = {};
    constructor(
      readonly url: string,
      readonly protocol: string,
    ) {
      queueMicrotask(() => this.emit("message", { op: OpCode.Hello, d: { rpcVersion: 1, ...(opts.auth ? { authentication: opts.auth } : {}) } }));
    }
    addEventListener(type: string, fn: (ev: any) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type: string, payload?: Msg | { code: number }) {
      const ev = type === "message" ? { data: JSON.stringify(payload) } : payload;
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    send(raw: string) {
      const msg = JSON.parse(raw) as Msg;
      queueMicrotask(() => {
        if (msg.op === OpCode.Identify) {
          if (opts.auth && msg.d.authentication !== authString(opts.password!, opts.auth.salt, opts.auth.challenge)) return this.emit("close", { code: 4009 });
          return this.emit("message", { op: OpCode.Identified, d: { negotiatedRpcVersion: 1 } });
        }
        if (msg.op === OpCode.Request) {
          const { requestType, requestId, requestData } = msg.d;
          requests.push({ requestType, requestData });
          const r = opts.handlers?.[requestType]?.(requestData ?? {}) ?? { ok: true };
          this.emit("message", {
            op: OpCode.RequestResponse,
            d: r.ok
              ? { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData: r.data }
              : { requestType, requestId, requestStatus: { result: false, code: r.code, comment: r.comment } },
          });
        }
      });
    }
    close() {}
  }
  return { WebSocketImpl: FakeWebSocket, requests };
}

describe("pure helpers", () => {
  it("defaults to the agentar bridge port", () => {
    expect(new URL(DEFAULT_AGENTAR_URL).port).toBe(String(DEFAULT_PORT));
    expect(stageUrl()).toBe(`http://127.0.0.1:${DEFAULT_PORT}/?stage=1`);
    expect(stageUrl("http://localhost:9000/")).toBe("http://localhost:9000/?stage=1");
  });

  it("computes obs-websocket auth as base64(sha256(base64(sha256(pw+salt))+challenge))", () => {
    const secret = createHash("sha256").update("pw" + "salt").digest("base64");
    const expected = createHash("sha256").update(secret + "chal").digest("base64");
    expect(authString("pw", "salt", "chal")).toBe(expected);
  });

  it("builds Identify with and without auth", () => {
    expect(identifyMessage({}, undefined)).toEqual({ op: OpCode.Identify, d: { rpcVersion: 1 } });
    const auth = { salt: "s", challenge: "c" };
    expect(identifyMessage({ authentication: auth }, "pw").d.authentication).toBe(authString("pw", "s", "c"));
    expect(() => identifyMessage({ authentication: auth }, undefined)).toThrow(/password/);
  });

  it("builds Request messages", () => {
    expect(requestMessage("GetVersion", "1")).toEqual({ op: OpCode.Request, d: { requestType: "GetVersion", requestId: "1" } });
    expect(requestMessage("CreateScene", "2", { sceneName: "x" }).d.requestData).toEqual({ sceneName: "x" });
  });

  it("sizes the browser source at 1280×720 with OBS-controlled audio", () => {
    expect(browserSourceSettings("u")).toEqual({ url: "u", width: 1280, height: 720, reroute_audio: true });
  });

  it("prints a checklist that covers Zoom, Discord, and virtual audio", () => {
    const text = manualChecklist("http://127.0.0.1:7777/?stage=1");
    for (const s of ["OBS Studio", "http://127.0.0.1:7777/?stage=1", "1280x720", "Start Virtual Camera", "Zoom", "Discord", "OBS Virtual Camera", "BlackHole", "VB-Cable"]) {
      expect(text).toContain(s);
    }
  });
});

describe("connectObs", () => {
  it("identifies with a password when OBS asks for one", async () => {
    const { WebSocketImpl } = fakeObs({ auth: { salt: "s", challenge: "c" }, password: "secret" });
    const obs = await connectObs({ password: "secret", WebSocketImpl });
    expect(await obs.call("GetVersion")).toEqual({});
  });

  it("rejects a wrong password", async () => {
    const { WebSocketImpl } = fakeObs({ auth: { salt: "s", challenge: "c" }, password: "secret" });
    await expect(connectObs({ password: "nope", WebSocketImpl })).rejects.toThrow(/wrong OBS WebSocket password/);
  });

  it("rejects when OBS is unreachable", async () => {
    class Unreachable {
      private onError?: () => void;
      constructor() {
        queueMicrotask(() => this.onError?.());
      }
      addEventListener(type: string, fn: () => void) {
        if (type === "error") this.onError = fn;
      }
      send() {}
      close() {}
    }
    await expect(connectObs({ WebSocketImpl: Unreachable })).rejects.toThrow(/Could not reach OBS/);
  });
});

describe("setupAgentarStage", () => {
  const url = "http://127.0.0.1:7777/?stage=1";

  it("creates the scene and browser source on a fresh OBS, then starts the virtual camera", async () => {
    const { WebSocketImpl, requests } = fakeObs({
      handlers: {
        GetSceneList: () => ({ ok: true, data: { scenes: [{ sceneName: "Scene" }] } }),
        GetInputSettings: () => ({ ok: false, code: 600, comment: "No source was found" }),
        CreateInput: () => ({ ok: true, data: { inputUuid: "u", sceneItemId: 7 } }),
        GetVideoSettings: () => ({ ok: true, data: { baseWidth: 1920, baseHeight: 1080 } }),
        GetVirtualCamStatus: () => ({ ok: true, data: { outputActive: false } }),
      },
    });
    const obs = await connectObs({ WebSocketImpl });
    const result = await setupAgentarStage(obs, { url });

    expect(result).toEqual({ sceneCreated: true, inputCreated: true, sceneItemId: 7, virtualCam: "started" });
    const byType = Object.fromEntries(requests.map((r) => [r.requestType, r.requestData]));
    expect(byType.CreateScene).toEqual({ sceneName: SCENE_NAME });
    expect(byType.CreateInput).toMatchObject({
      sceneName: SCENE_NAME,
      inputName: INPUT_NAME,
      inputKind: "browser_source",
      inputSettings: { url, width: 1280, height: 720, reroute_audio: true },
    });
    expect(byType.SetSceneItemTransform).toMatchObject({ sceneItemId: 7, sceneItemTransform: { boundsWidth: 1920, boundsHeight: 1080 } });
    expect(byType.SetInputAudioMonitorType).toEqual({ inputName: INPUT_NAME, monitorType: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT" });
    expect(byType.SetCurrentProgramScene).toEqual({ sceneName: SCENE_NAME });
    expect(requests.map((r) => r.requestType)).toContain("StartVirtualCam");
  });

  it("updates an existing setup in place and leaves a running virtual camera alone", async () => {
    const { WebSocketImpl, requests } = fakeObs({
      handlers: {
        GetSceneList: () => ({ ok: true, data: { scenes: [{ sceneName: SCENE_NAME }] } }),
        GetInputSettings: () => ({ ok: true, data: { inputSettings: { url: "old" } } }),
        GetSceneItemId: () => ({ ok: true, data: { sceneItemId: 3 } }),
        GetVideoSettings: () => ({ ok: true, data: { baseWidth: 1280, baseHeight: 720 } }),
        GetVirtualCamStatus: () => ({ ok: true, data: { outputActive: true } }),
      },
    });
    const obs = await connectObs({ WebSocketImpl });
    const result = await setupAgentarStage(obs, { url });

    expect(result).toEqual({ sceneCreated: false, inputCreated: false, sceneItemId: 3, virtualCam: "already running" });
    const types = requests.map((r) => r.requestType);
    expect(types).not.toContain("CreateScene");
    expect(types).not.toContain("CreateInput");
    expect(types).not.toContain("StartVirtualCam");
    expect(requests.find((r) => r.requestType === "SetInputSettings")?.requestData).toMatchObject({ inputName: INPUT_NAME, overlay: true, inputSettings: { url } });
  });

  it("re-adds an existing source that was removed from the scene", async () => {
    const { WebSocketImpl, requests } = fakeObs({
      handlers: {
        GetSceneList: () => ({ ok: true, data: { scenes: [{ sceneName: SCENE_NAME }] } }),
        GetSceneItemId: () => ({ ok: false, code: 600 }),
        CreateSceneItem: () => ({ ok: true, data: { sceneItemId: 9 } }),
        GetVideoSettings: () => ({ ok: true, data: { baseWidth: 1280, baseHeight: 720 } }),
      },
    });
    const obs = await connectObs({ WebSocketImpl });
    const result = await setupAgentarStage(obs, { url, startVirtualCam: false });

    expect(result.sceneItemId).toBe(9);
    expect(result.virtualCam).toBe("skipped");
    expect(requests.map((r) => r.requestType)).not.toContain("GetVirtualCamStatus");
  });

  it("surfaces unexpected OBS errors", async () => {
    const { WebSocketImpl } = fakeObs({
      handlers: {
        GetSceneList: () => ({ ok: true, data: { scenes: [] } }),
        GetInputSettings: () => ({ ok: false, code: 204, comment: "Invalid request type" }),
      },
    });
    const obs = await connectObs({ WebSocketImpl });
    await expect(setupAgentarStage(obs, { url })).rejects.toThrow(/GetInputSettings failed \(204\)/);
  });
});
