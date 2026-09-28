---
name: agentar-join-a-call
description: Join Zoom or Discord (or Teams/Meet) with the agentar 3D avatar as your webcam, using OBS Virtual Camera. Speak through agentar's /api/say.
homepage: https://github.com/on-par/agentar/blob/main/docs/meetings.md
metadata: {"openclaw":{"requires":{"bins":["node"]}}}
---

# Agentar: join a call

Use this skill when the user asks you to join, show up in, or be on camera in a Zoom, Discord, Teams, or Google Meet call as agentar (their avatar). OBS Studio turns the agentar stage view into a webcam called **OBS Virtual Camera**. You speak by sending text to agentar, and the avatar says it with lip-sync.

You cannot click "Join" inside Zoom or Discord yourself. You get the camera ready and tell the user what to pick. The user joins the call.

## 1. Make sure agentar is running

Check the bridge (default port 7777):

```bash
curl -s http://127.0.0.1:7777/api/info
```

If that fails, ask the user to start agentar (`agentar start --daemon`, so the bridge keeps running for the whole call even after the terminal closes — or the double-click launcher in agentar's `scripts/` folder). Do not continue until `/api/info` answers.

The stage URL (the camera view, with no side panel) is:

```
http://127.0.0.1:7777/?stage=1
```

If agentar uses another port, change it everywhere below.

## 2. Set up OBS: try the helper first

If OBS is open and its WebSocket server is on (OBS → Tools → WebSocket Server Settings → Enable, port 4455), run:

```bash
node {baseDir}/scripts/setup-obs-scene.mjs
```

The helper builds an **Agentar Stage** scene with a 1280×720 Browser Source on the stage URL. It turns on "Control audio via OBS", sets the source to "Monitor and Output", switches OBS to the scene, and starts the Virtual Camera. It needs no packages (Node 22 or newer).

- If OBS has a WebSocket password, set `OBS_WEBSOCKET_PASSWORD` in the environment. Do not put the password on the command line.
- Options: `--agentar-url http://127.0.0.1:7777`, `--obs-url ws://127.0.0.1:4455`, `--no-virtualcam`.
- Exit code 0: OBS is ready. Go to step 4.
- Exit code 1: OBS is not reachable or a request failed. The helper prints the manual checklist. Use step 3.

## 3. Fallback: walk the user through OBS by hand

Give the user these steps:

1. Install OBS Studio from https://obsproject.com.
2. Add a **Browser** source. Set the URL to `http://127.0.0.1:7777/?stage=1`, the size to **1280×720**, and turn on **Control audio via OBS**.
3. Click **Start Virtual Camera**.
4. In **Zoom** or **Discord** (or Teams / Meet), choose **OBS Virtual Camera** as the camera.

The agentar page also shows these steps in **Connect → Join a call**, with a copy button for the stage URL.

## 4. Pick the camera and the microphone in the call

Tell the user:

- **Camera**: choose **OBS Virtual Camera**. Zoom: Settings → Video → Camera. Discord: User Settings → Voice & Video → Camera.
- **Microphone** (so the call hears the avatar's voice):
  - **macOS**: install BlackHole (https://existential.audio/blackhole/). In OBS, set Settings → Audio → Monitoring Device to BlackHole. Set the browser source to **Monitor and Output** (the helper already does this). Choose BlackHole as the microphone in the call.
  - **Windows**: do the same with VB-Cable (https://vb-audio.com/Cable/).
- If the normal agentar tab is also open, it plays the voice too. Open it with `?mute=1` to stop the echo.

## 5. Speak in the call

The stage is only the camera. You still speak through agentar's HTTP API:

```bash
curl -s -X POST http://127.0.0.1:7777/api/say \
  -H "Content-Type: application/json" \
  -d '{"text":"Hi everyone, I just joined.","mood":"happy"}'
```

- Send one short reply per request. Plain sentences sound best. Do not send code or markdown.
- Optional fields: `"mood"`, `"wait": true` (the request returns after the avatar stops talking), `"interrupt": false` (queue the reply instead of cutting in).

## Limits

- This skill does not join the meeting for you. There is no meeting bot yet.
- It does not hear the call. What other people say does not reach you unless the user relays it.
- Everything runs locally. OBS and agentar must run on the same computer as the meeting app.
