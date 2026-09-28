# Using agentar in video calls

There are two ways to put agentar in a call:

- **OBS camera** (the main path): OBS turns the avatar into a webcam on your computer. You join the call, and your agent (OpenClaw or any other) shows up as agentar in **Zoom** or **Discord** (or Teams / Meet). This is the only way to show agentar's face in Discord.
- **Meeting bot (Recall spike)**: a Recall.ai bot joins **Zoom** (or Meet / Teams / Webex) as its own participant, with agentar as its camera and voice. See [Meeting bot (Recall spike)](#meeting-bot-recall-spike).

## Quick path

- Start agentar with `agentar start --daemon` so the bridge outlives your terminal for the whole call; run `agentar stop` afterwards to free the port. See [Run it in the background](../README.md#run-it-in-the-background).
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

## Meeting bot (Recall spike)

A [Recall.ai](https://www.recall.ai) bot joins the meeting as its own participant. Recall's [Output Media](https://docs.recall.ai/docs/stream-media) loads a webpage in the bot's browser and sends it into the call as the bot's camera (1280×720 at 15 fps) and microphone. Point it at the agentar stage, and the avatar's face and voice come from the bot, not from your computer.

This is a spike. It is documented, but not yet proven against a live Zoom call.

### What you need

- A Recall.ai account and API key. Bots are billed per hour.
- agentar running on your computer (`agentar start`).
- A public HTTPS tunnel to agentar's port 7777, so Recall's browser can open the stage.

### 1. Open a tunnel

Tunnel **all** of port 7777, not only the page. The stage loads its scripts, models, and speech audio (`/api/audio/…`) from the same address and gets speak events over the `/ws` WebSocket.

```bash
cloudflared tunnel --url http://127.0.0.1:7777
```

cloudflared prints a URL such as `https://random-words.trycloudflare.com`. Keep it running for the whole call.

ngrok also works (`ngrok http 7777`), but the free plan shows a warning page to browsers, which the bot cannot click through. Use a paid ngrok plan or cloudflared.

### 2. Let the tunnel talk to agentar

agentar only accepts browser connections from `localhost`. Start it with the tunnel address allowed (no trailing path):

```bash
AGENTAR_ALLOWED_ORIGINS=https://random-words.trycloudflare.com agentar start
```

Open `https://random-words.trycloudflare.com/?stage=1` in your own browser to check that the avatar loads. This is your stage URL (`STAGE_PUBLIC_URL`).

In the Voice settings, pick an engine that makes audio on your computer (System, Edge, Kokoro, or a cloud voice). **Browser (Web Speech)** does not work in the bot, because the bot's browser never gets a click and may have no voices.

### 3. Create the bot

Fill in your values and send a Create Bot request. The region in the URL (`us-west-2`) must match your Recall account.

```bash
export RECALL_API_KEY=your-recall-api-key
STAGE_PUBLIC_URL='https://random-words.trycloudflare.com/?stage=1'
MEETING_URL='https://us02web.zoom.us/j/1234567890'

curl -X POST https://us-west-2.recall.ai/api/v1/bot/ \
  -H "Authorization: $RECALL_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "meeting_url": "$MEETING_URL",
  "bot_name": "agentar",
  "output_media": {
    "camera": { "kind": "webpage", "config": { "url": "$STAGE_PUBLIC_URL" } }
  },
  "variant": { "zoom": "web_gpu" }
}
EOF
```

- `"variant": { "zoom": "web_gpu" }` is required. agentar renders with WebGL, and only the `web_gpu` browser has it. Add `"google_meet"` or `"microsoft_teams"` keys for those platforms.
- Add `&captions=1` to the stage URL to show subtitles.
- Do not also set `automatic_video_output` or `automatic_audio_output`. Recall does not allow them with Output Media.

The same payload is in [`skills/agentar-recall-zoom/create-bot.example.json`](../skills/agentar-recall-zoom/create-bot.example.json). Admit the bot in Zoom if the meeting has a waiting room.

### 4. Speak

Your agent speaks the same way as always, through the bridge on your computer:

```bash
curl -X POST http://127.0.0.1:7777/api/say -H 'Content-Type: application/json' -d '{"text":"Hello from Agentar"}'
```

The bridge sends the speech to every open view, including the stage in the bot's browser. The bot plays it into the call with lip-sync. If you are in the same call on this computer, open your own agentar tab with `?mute=1` so you do not hear the voice twice.

To end, remove the bot from the call in Zoom (or with Recall's Leave Call endpoint), then stop the tunnel.

### Limits

- **No Discord or Slack Huddles.** Recall does not support them. For Discord, use the OBS camera above.
- **Paid.** `web_gpu` bots cost about $1.50 per hour on Recall's pay-as-you-go plan (see Recall's [Output Media docs](https://docs.recall.ai/docs/stream-media)).
- **Public tunnel.** Anyone with the tunnel URL can reach your whole agentar bridge: make the avatar speak, change settings, and use your chat connectors. Do not share the URL, and stop the tunnel after the call.
- **HTTPS only.** Recall's browser needs a public HTTPS address. `localhost` does not work.
- **Audio autoplay.** The bot's browser allows audio without a click, so bridge voices play. This is not yet proven live. If the bot is silent, make sure the voice is not Browser (Web Speech).
- **One way.** The bot does not send what people say in the call back to your agent yet.
- **Not tested in CI.** A live check needs a paid Recall account and a real meeting.
