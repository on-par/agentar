# Using agentar in video calls

Until agentar has a native meeting bot (see the roadmap), use OBS to turn the avatar into a camera. Your agent (OpenClaw or any other) then shows up in **Zoom** or **Discord** (or Teams / Meet) as agentar.

## Quick path

- **Connect → Join a call** in the agentar page shows the stage URL with Copy and Open buttons, the four OBS steps below, and the audio setup.
- **OpenClaw**: install the [`agentar-join-a-call`](../skills/agentar-join-a-call/SKILL.md) skill, then ask OpenClaw to join your call as agentar:

  ```bash
  openclaw skills install <agentar>/skills/agentar-join-a-call
  ```

  The Connect tab shows this command with the real path. The skill first runs its helper, `scripts/setup-obs-scene.mjs`. If OBS is open with its WebSocket server on (OBS → Tools → WebSocket Server Settings, port 4455), the helper builds an **Agentar Stage** scene with the browser source and starts the Virtual Camera. It needs no packages. Set `OBS_WEBSOCKET_PASSWORD` if the server has a password. If OBS is not reachable, the helper prints the manual steps below.

  You can also run the helper yourself: `node skills/agentar-join-a-call/scripts/setup-obs-scene.mjs`.

The sections below are the detailed manual reference.

## Video

1. Install [OBS Studio](https://obsproject.com).
2. Add a **Browser** source. Set the URL to `http://localhost:7777/?stage=1`, the size to 1280×720, and turn on "Control audio via OBS".
3. Click **Start Virtual Camera**.
4. In Zoom or Discord (or Teams / Meet), choose **OBS Virtual Camera** as your camera.

`?stage=1` hides the panel and orbit controls. Add `&captions=1` to show subtitles.

## Audio

The browser source plays the agent's voice inside OBS. To send that voice into the meeting as a microphone:

- **macOS**: install [BlackHole](https://existential.audio/blackhole/). In OBS, set Settings → Audio → Monitoring Device to BlackHole. Set the browser source to "Monitor and Output". Then choose BlackHole as the microphone in the meeting app.
- **Windows**: use [VB-Cable](https://vb-audio.com/Cable/) the same way.

If your main agentar tab is also open, it plays audio too. Open it with `?mute=1` to keep that view silent.

## Speaking

The stage is only the camera. The agent still speaks through the bridge: `POST http://localhost:7777/api/say` with `{"text": "…"}`. Every open view, including the OBS browser source, says it with lip-sync.
