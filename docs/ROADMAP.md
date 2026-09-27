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

## Next

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

1. **Now**: use OBS Virtual Camera plus a virtual audio device. See [meetings.md](meetings.md).
2. **Bundled virtual camera**: an Electron or Tauri shell that renders offscreen and publishes a virtual camera and microphone directly.
3. **Meeting bot**: the agent joins as a participant through a meeting-bot API (Recall.ai, or the Zoom Meeting SDK / Teams bot framework). It streams the rendered avatar as video and the TTS audio as its microphone, and it sends transcribed meeting audio back to the agent.
