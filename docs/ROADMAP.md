# Roadmap

## v0.1 (this release)

- Realistic humanoid avatar (CC0 MPFB model), rendered with three.js and PBR lighting
- Customization: model upload (GLB/VRM), shader-based recoloring, glasses, hats, height, scene, and lighting
- Voices: offline OS TTS, Web Speech, Microsoft Edge (via `edge-tts`), OpenAI, ElevenLabs, xAI Grok
- Lip-sync from text plus real audio (voiced-region alignment and loudness gating), with Oculus, ARKit, and VRM fallbacks
- Idle life: blinks, saccades, breathing, head sway, and moods
- Gestures: head (nod, shake, tilt), hands (wave, high five, thumbs up/down, idea, shrug, namaste; Mixamo rigs only), and face and body (wink, laugh, surprised, bow)
- Hats and glasses fitted to each model's measured head shape
- Agent integration: MCP server, Claude Code Stop hook, Codex notify hook, and an HTTP API
- OBS stage view for virtual cameras

## Shipped since v0.1

- **Consumer simple start**: double-click launchers in `scripts/` (`Agentar.command`, `agentar-start.sh`, `agentar-start.cmd`) that install, build, and open the avatar.
- **TTS fallback**: when the OS speech engine is missing, the bridge switches to Edge voices or the browser's own voice instead of failing.
- **Talking agents (people path)** in the Connect tab and README: OpenClaw, Hermes, Grok Bot, and Muse speak through `POST /api/say`.
- **Chat B: chat with named connectors**: a Chat tab and `POST /api/chat`, so people can talk to their agent from the avatar page. There are named connectors for OpenClaw, Hermes, Grok Bot, and Muse, plus Advanced (generic HTTP):
  - OpenClaw, Hermes, and Advanced share one OpenAI-compatible adapter and stream their replies.
  - Grok Bot is experimental and goes through AgentMail email.
  - Muse is shown as a gap, because Meta has no chat API for the assistant.
  - **Speak replies** has the avatar say each reply.
  - See [chat.md](chat.md).
- **Cut C — OBS-assisted Join-a-call**: a first-class **Join a call** panel in the Connect tab (stage URL, OBS checklist, BlackHole / VB-Cable audio) and the OpenClaw skill [`skills/agentar-join-a-call`](../skills/agentar-join-a-call/SKILL.md), so an agent shows up in Zoom or Discord with agentar as its webcam through OBS Virtual Camera. The skill's zero-dependency obs-websocket helper builds the "Agentar Stage" scene and starts the Virtual Camera when OBS is reachable.

## Next

Ship sequence (locked): **Cut A** (shipped, [#1](https://github.com/on-par/agentar/pull/1)) → **Chat B** (shipped, [#2](https://github.com/on-par/agentar/pull/2)) → **Cut C** (OBS-assisted Join-a-call, this PR) → native Electron virtual cam → meeting bot.

- **Chat follow-ups**:
  - Test Grok Bot against a live bot and tune its polling.
  - Add a real Muse connector if Meta opens an assistant API.
  - Consider the A2A protocol for agent-to-agent peers.
  - Consider OpenClaw's `/v1/responses` endpoint.


- **Better lip-sync accuracy**
  - Use provider timestamps (ElevenLabs `with-timestamps`, Azure viseme events) when they are available.
  - Add a phoneme recognizer (for example wav2vec2 in ONNX) for audio that arrives without text.
  - Add languages other than English.
- **Streaming speech**: stream TTS audio sentence by sentence, so the avatar starts talking before the whole reply is rendered.
- **Local neural voices**: Kokoro or Piper running in the bridge, for natural offline voices.
- **Listening**: push-to-talk speech-to-text in the page, sent to the agent. The avatar shows a "listening" pose while the user speaks.
- **Body language**: hand gestures while talking, weight shifts, and emotion inferred from the text of the reply.
- **Character builder**: parametric faces and bodies (for example through MPFB/MakeHuman targets) and a PG wardrobe of swappable outfits and hairstyles, instead of only recoloring.
- **Presets and sharing**: save several characters and export or import them as a single file.

## Meetings (Zoom, Teams, Meet)

1. **Now**: OBS Virtual Camera plus a virtual audio device, set up from **Connect → Join a call** or the OpenClaw `agentar-join-a-call` skill. See [meetings.md](meetings.md).
2. **Bundled virtual camera**: an Electron or Tauri shell that renders offscreen and publishes a virtual camera and microphone directly.
3. **Meeting bot**: the agent joins as a participant through a meeting-bot API (Recall.ai, or the Zoom Meeting SDK / Teams bot framework). It streams the rendered avatar as video and the TTS audio as its microphone, and it sends transcribed meeting audio back to the agent.
