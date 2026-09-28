#!/usr/bin/env node
// Builds an "Agentar Stage" scene in OBS (Browser Source → agentar stage view, 1280×720)
// and starts the Virtual Camera, over obs-websocket 5.x. No dependencies: Node 22+ ships
// a global WebSocket. If OBS is not reachable, prints the manual checklist and exits 1.
//
//   node setup-obs-scene.mjs [--agentar-url http://127.0.0.1:7777] [--obs-url ws://127.0.0.1:4455]
//                            [--password <pw>] [--no-virtualcam]
//
// Env: AGENTAR_URL, OBS_WEBSOCKET_URL, OBS_WEBSOCKET_PASSWORD.

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** Keep in sync with DEFAULT_PORT in @agentar/core (checked by the test). */
export const DEFAULT_AGENTAR_URL = "http://127.0.0.1:7777";
export const DEFAULT_OBS_URL = "ws://127.0.0.1:4455";
export const SCENE_NAME = "Agentar Stage";
export const INPUT_NAME = "Agentar Browser";
export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

/** obs-websocket 5.x op codes used here. */
export const OpCode = { Hello: 0, Identify: 1, Identified: 2, Request: 6, RequestResponse: 7 };
/** obs-websocket RequestStatus.ResourceNotFound. */
const RESOURCE_NOT_FOUND = 600;

export class ObsRequestError extends Error {
  constructor(requestType, code, comment) {
    super(`OBS ${requestType} failed (${code})${comment ? `: ${comment}` : ""}`);
    this.name = "ObsRequestError";
    this.code = code;
  }
}

export function stageUrl(agentarUrl = DEFAULT_AGENTAR_URL) {
  return `${agentarUrl.replace(/\/+$/, "")}/?stage=1`;
}

/** obs-websocket auth: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function authString(password, salt, challenge) {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

export function identifyMessage(hello, password) {
  const d = { rpcVersion: 1 };
  if (hello.authentication) {
    if (!password) throw new Error("OBS WebSocket needs a password. Set OBS_WEBSOCKET_PASSWORD or pass --password.");
    d.authentication = authString(password, hello.authentication.salt, hello.authentication.challenge);
  }
  return { op: OpCode.Identify, d };
}

export function requestMessage(requestType, requestId, requestData) {
  return { op: OpCode.Request, d: { requestType, requestId, ...(requestData ? { requestData } : {}) } };
}

/** "Control audio via OBS" is the browser source's reroute_audio setting. */
export function browserSourceSettings(url) {
  return { url, width: STAGE_WIDTH, height: STAGE_HEIGHT, reroute_audio: true };
}

export function manualChecklist(url) {
  return [
    "Set up OBS by hand:",
    "  1. Install OBS Studio (https://obsproject.com).",
    `  2. Add a Browser Source: URL ${url}, size ${STAGE_WIDTH}x${STAGE_HEIGHT}, turn on "Control audio via OBS".`,
    "  3. Click Start Virtual Camera.",
    "  4. In Zoom or Discord (or Teams / Meet), pick OBS Virtual Camera as the camera.",
    'Audio: OBS Settings → Audio → Monitoring Device = BlackHole (macOS) or VB-Cable (Windows); set the source to "Monitor and Output"; pick that device as the call microphone.',
    "To let this script do it: OBS → Tools → WebSocket Server Settings → Enable WebSocket server (port 4455).",
  ].join("\n");
}

/** Connect and identify. Resolves to `{ call(type, data), close() }`. */
export function connectObs({ url = DEFAULT_OBS_URL, password, WebSocketImpl = globalThis.WebSocket, timeoutMs = 3000 } = {}) {
  if (!WebSocketImpl) return Promise.reject(new Error("This Node has no WebSocket. Use Node 22 or newer."));
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url, "obswebsocket.json");
    const pending = new Map();
    let ready = false;
    const fail = (err) => {
      clearTimeout(timer);
      if (!ready) reject(err);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    const timer = setTimeout(() => {
      fail(new Error(`No answer from OBS at ${url} within ${timeoutMs} ms.`));
      ws.close();
    }, timeoutMs);

    const client = {
      call(requestType, requestData) {
        const requestId = randomUUID();
        return new Promise((res, rej) => {
          pending.set(requestId, { resolve: res, reject: rej, requestType });
          ws.send(JSON.stringify(requestMessage(requestType, requestId, requestData)));
        });
      },
      close() {
        ws.close();
      },
    };

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.op === OpCode.Hello) {
        try {
          ws.send(JSON.stringify(identifyMessage(msg.d, password)));
        } catch (err) {
          fail(err);
          ws.close();
        }
      } else if (msg.op === OpCode.Identified) {
        ready = true;
        clearTimeout(timer);
        resolve(client);
      } else if (msg.op === OpCode.RequestResponse) {
        const p = pending.get(msg.d.requestId);
        if (!p) return;
        pending.delete(msg.d.requestId);
        const status = msg.d.requestStatus ?? {};
        if (status.result) p.resolve(msg.d.responseData ?? {});
        else p.reject(new ObsRequestError(p.requestType, status.code, status.comment));
      }
    });
    ws.addEventListener("error", () => fail(new Error(`Could not reach OBS at ${url}. Is OBS open with its WebSocket server on?`)));
    ws.addEventListener("close", (ev) => {
      const why = ev?.code === 4009 ? "wrong OBS WebSocket password" : `OBS closed the connection${ev?.code ? ` (${ev.code})` : ""}`;
      fail(new Error(why));
    });
  });
}

const notFound = (err) => err instanceof ObsRequestError && err.code === RESOURCE_NOT_FOUND;

/**
 * Create or refresh the "Agentar Stage" scene, fit the browser source to the canvas,
 * route its audio to the monitoring device, switch to it, and start the Virtual Camera.
 */
export async function setupAgentarStage(obs, { url = stageUrl(), startVirtualCam = true } = {}) {
  const { scenes = [] } = await obs.call("GetSceneList");
  const sceneCreated = !scenes.some((s) => s.sceneName === SCENE_NAME);
  if (sceneCreated) await obs.call("CreateScene", { sceneName: SCENE_NAME });

  const inputSettings = browserSourceSettings(url);
  let inputCreated = false;
  try {
    await obs.call("GetInputSettings", { inputName: INPUT_NAME });
  } catch (err) {
    if (!notFound(err)) throw err;
    inputCreated = true;
  }

  let sceneItemId;
  if (inputCreated) {
    ({ sceneItemId } = await obs.call("CreateInput", {
      sceneName: SCENE_NAME,
      inputName: INPUT_NAME,
      inputKind: "browser_source",
      inputSettings,
      sceneItemEnabled: true,
    }));
  } else {
    await obs.call("SetInputSettings", { inputName: INPUT_NAME, inputSettings, overlay: true });
    try {
      ({ sceneItemId } = await obs.call("GetSceneItemId", { sceneName: SCENE_NAME, sourceName: INPUT_NAME }));
    } catch (err) {
      if (!notFound(err)) throw err;
      ({ sceneItemId } = await obs.call("CreateSceneItem", { sceneName: SCENE_NAME, sourceName: INPUT_NAME, sceneItemEnabled: true }));
    }
  }

  // Scale the 1280×720 source to fill whatever canvas size OBS uses, without touching OBS settings.
  const { baseWidth = STAGE_WIDTH, baseHeight = STAGE_HEIGHT } = await obs.call("GetVideoSettings");
  await obs.call("SetSceneItemTransform", {
    sceneName: SCENE_NAME,
    sceneItemId,
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      alignment: 5, // top-left
      boundsType: "OBS_BOUNDS_SCALE_INNER",
      boundsAlignment: 0,
      boundsWidth: baseWidth,
      boundsHeight: baseHeight,
    },
  });
  await obs.call("SetInputAudioMonitorType", { inputName: INPUT_NAME, monitorType: "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT" });
  await obs.call("SetCurrentProgramScene", { sceneName: SCENE_NAME });

  let virtualCam = "skipped";
  if (startVirtualCam) {
    const { outputActive } = await obs.call("GetVirtualCamStatus");
    if (!outputActive) await obs.call("StartVirtualCam");
    virtualCam = outputActive ? "already running" : "started";
  }
  return { sceneCreated, inputCreated, sceneItemId, virtualCam };
}

async function agentarIsUp(agentarUrl) {
  try {
    const res = await fetch(`${agentarUrl.replace(/\/+$/, "")}/api/info`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, log = console) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "agentar-url": { type: "string", default: env.AGENTAR_URL ?? DEFAULT_AGENTAR_URL },
      "obs-url": { type: "string", default: env.OBS_WEBSOCKET_URL ?? DEFAULT_OBS_URL },
      password: { type: "string", default: env.OBS_WEBSOCKET_PASSWORD },
      "no-virtualcam": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const url = stageUrl(values["agentar-url"]);
  if (values.help) {
    log.log("Usage: node setup-obs-scene.mjs [--agentar-url URL] [--obs-url ws://HOST:PORT] [--password PW] [--no-virtualcam]");
    log.log(manualChecklist(url));
    return 0;
  }

  if (!(await agentarIsUp(values["agentar-url"]))) {
    log.warn(`Warning: agentar is not answering at ${values["agentar-url"]}. Start it (agentar start) before the call, then refresh the "${INPUT_NAME}" source in OBS.`);
  }

  let obs;
  try {
    obs = await connectObs({ url: values["obs-url"], password: values.password });
    const result = await setupAgentarStage(obs, { url, startVirtualCam: !values["no-virtualcam"] });
    log.log(`OBS is ready: scene "${SCENE_NAME}" shows ${url} (${result.sceneCreated ? "created" : "updated"}). Virtual Camera: ${result.virtualCam}.`);
    log.log("Next: in Zoom or Discord (or Teams / Meet), pick OBS Virtual Camera as the camera.");
    log.log("Audio: set OBS Monitoring Device to BlackHole (macOS) or VB-Cable (Windows) and pick it as the call microphone.");
    return 0;
  } catch (err) {
    log.error(`OBS setup failed: ${err.message}`);
    log.error(manualChecklist(url));
    return 1;
  } finally {
    obs?.close();
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = await main();
