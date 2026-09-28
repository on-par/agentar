---
name: agentar-recall-zoom
description: (Spike) Send a Recall.ai meeting bot into a Zoom call with the agentar avatar as its camera and voice. Speak through agentar's /api/say.
homepage: https://github.com/on-par/agentar/blob/main/docs/meetings.md#meeting-bot-recall-spike
metadata: {"openclaw":{"requires":{"bins":["curl"],"env":["RECALL_API_KEY"]}}}
---

# Agentar: Recall meeting bot (spike)

Use this skill when the user asks for agentar to join a **Zoom** call (or Meet / Teams / Webex) as its own participant. A Recall.ai bot joins the meeting and shows the agentar stage page as its camera and microphone. For **Discord**, do not use this skill: Recall does not support Discord. Use `agentar-join-a-call` (OBS) instead.

This is a spike. Tell the user it costs about $1.50 per hour on Recall and is not yet proven live.

## 1. Check the setup

The user must do these steps (see `docs/meetings.md`, "Meeting bot (Recall spike)"):

1. Run a public HTTPS tunnel to port 7777: `cloudflared tunnel --url http://127.0.0.1:7777`.
2. Start agentar with the tunnel allowed: `AGENTAR_ALLOWED_ORIGINS=https://<tunnel-host> agentar start`.
3. Pick a voice other than Browser (Web Speech).

Ask for the tunnel URL and the meeting URL. The stage URL is the tunnel URL plus `/?stage=1`. Check that it answers:

```bash
curl -s https://<tunnel-host>/api/health
```

`RECALL_API_KEY` must be set in the environment. Do not ask the user to paste the key into the chat.

## 2. Create the bot

Send the payload from `{baseDir}/create-bot.example.json` with the real meeting and stage URLs. Use the Recall region of the user's account (default `us-west-2`):

```bash
MEETING_URL='https://us02web.zoom.us/j/1234567890'
STAGE_PUBLIC_URL='https://<tunnel-host>/?stage=1'

curl -s -X POST https://us-west-2.recall.ai/api/v1/bot/ \
  -H "Authorization: $RECALL_API_KEY" -H "Content-Type: application/json" -d @- <<EOF
{
  "meeting_url": "$MEETING_URL",
  "bot_name": "agentar",
  "output_media": { "camera": { "kind": "webpage", "config": { "url": "$STAGE_PUBLIC_URL" } } },
  "variant": { "zoom": "web_gpu" }
}
EOF
```

Keep `"variant": { "zoom": "web_gpu" }`. The avatar needs WebGL, and only `web_gpu` has it. Save the bot `id` from the reply. Tell the user to admit the bot if the meeting has a waiting room.

## 3. Speak in the call

```bash
curl -s -X POST http://127.0.0.1:7777/api/say \
  -H "Content-Type: application/json" \
  -d '{"text":"Hi everyone, I just joined."}'
```

Send one short reply per request, in plain sentences.

## Limits

- You cannot hear the call. People's speech does not reach you unless the user relays it.
- The tunnel exposes the whole agentar bridge. Remind the user to stop the tunnel after the call.
- Reference: https://docs.recall.ai/docs/stream-media
