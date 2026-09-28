# Agentar

*Agentar (agent + avatar): give your AI agent a body.*

agentar is a customizable, realistic 3D avatar for the agent you already use: Claude Code, Codex, or anything that can run a command or call an HTTP endpoint. When your agent talks, agentar speaks the words with text-to-speech and moves the avatar's face in sync with the audio. It lip-syncs, blinks, glances around, nods, and shows moods.

It runs locally in your browser with [three.js](https://threejs.org) and WebGL. The default voice is your operating system's own speech engine, so you need no API keys or cloud account.

## For everyone

You need [Node.js](https://nodejs.org) 24 or newer. Then:

1. Start Agentar:
   - **macOS**: double-click `scripts/Agentar.command` in Finder.
   - **Linux**: run `scripts/agentar-start.sh` (or double-click it in your file manager).
   - **Windows**: double-click `scripts\agentar-start.cmd`.
   - **No checkout?** Run `npx agentar@0.1.0 start`.
2. Your browser opens the avatar. The first start installs and builds everything, so it takes a few minutes.
3. Click the page once, so the browser allows sound.
4. On the **Talk** tab, type something and press **Speak**.

To have your agent talk through the avatar, see [Talking agents](#talking-agents-people-path).

If your computer has no built-in speech engine (for example Linux without `espeak-ng`), Agentar switches to Microsoft Edge voices when [`edge-tts`](https://github.com/rany2/edge-tts) is installed, and to the browser's own voice otherwise.

## Quick start

```bash
npm install -g agentar
agentar start          # starts the bridge and opens http://localhost:7777
```

The first start downloads the default CC0 avatar (~37 MB) into `~/.agentar/builtin-models`. You can also run it once with `npx agentar start`.

From a checkout of this repo:

```bash
npm install
npm run build
npm start              # same as `agentar start`; the avatar goes into assets/models
```

Click the page once so the browser allows sound. Then press **Speak** on the Talk tab.

For development with hot reload:

```bash
npm run dev            # bridge on :7777 and Vite on http://localhost:5173
```

## Talking agents (people path)

**OpenClaw**, **Hermes**, **Grok Bot**, **Muse**, or any agent that can send a web request can make the avatar speak. Have the agent POST each reply to the bridge:

```bash
curl -X POST localhost:7777/api/say -H 'Content-Type: application/json' -d '{"text":"Hi! I am here.","mood":"happy"}'
```

Optional fields: `mood`, `wait: true` (answer after the avatar finishes speaking), and `interrupt: false` (queue the reply instead of cutting in). A plain-text body (`Content-Type: text/plain`) also works. The **Connect** tab shows this command with the correct address.

## Connect your agent (builders)

The **Connect** tab in the app shows these commands with the correct paths already filled in. From a checkout, use `node <repo>/packages/cli/dist/index.js` in place of `agentar`.

| Harness | Command | What you get |
| --- | --- | --- |
| Claude Code (tools) | `claude mcp add agentar -- agentar mcp` | Claude can call `speak`, `set_mood`, `gesture` and `stop_speaking` |
| Claude Code (every reply) | `agentar install claude-code` | A Stop hook reads each final reply aloud |
| Codex CLI | `agentar install codex` | `notify` hook and the MCP server in `~/.codex/config.toml` |
| Anything | `curl -X POST localhost:7777/api/say -d '{"text":"Hi!"}' -H 'Content-Type: application/json'` | Plain HTTP |

To get a global `agentar` command, run `npm link -w @agentar/cli`.

Before speaking, agentar rewrites markdown for the ear. It removes code blocks, links, and paths, and it trims long replies.

## Customize

- **Look**: body model (built-in or your own `.glb`/`.vrm` upload), and the colors of skin, hair, eyes, top, bottom, and shoes. Colors are re-tinted in the shader, so the texture detail stays. Also glasses, hats, and height.
- **Voice**: engine and voice, speed, pitch, and volume.
  - `system`: offline, uses the macOS `say`, Linux `espeak-ng`, or Windows SAPI voices. It is the default. If the engine is not installed, Agentar switches to `edge` (when installed) or `browser`, and saves that choice.
  - `browser`: the Web Speech API.
  - `edge`: Microsoft Edge's online neural voices. They sound much more natural than `say`. Install the free [`edge-tts`](https://github.com/rany2/edge-tts) CLI (`pipx install edge-tts` or `uv tool install edge-tts`). It needs internet, but no API key. If `edge-tts` is not on your `PATH`, set `AGENTAR_EDGE_TTS` to its full path.
  - `openai`: needs `OPENAI_API_KEY`.
  - `elevenlabs`: needs `ELEVENLABS_API_KEY`.
  - `xai`: Grok voices. Needs `XAI_API_KEY` from [console.x.ai](https://console.x.ai). API usage is billed separately from a Grok app subscription.
- **Behavior**: resting mood, expressiveness, idle motion, and eye contact.
- **Scene**: framing (head, bust, or full body), lighting, background, and captions.

The bridge saves your settings to `~/.agentar/config.json`. It applies them live to every open view.

## How lip-sync works

1. The bridge renders speech audio (WAV or MP3) and sends every connected view a `speak` event.
2. The browser decodes the audio. It computes a loudness envelope and finds the regions where speech is voiced.
3. The text is converted to **visemes** (mouth shapes) with English letter-to-sound rules. The visemes are laid out over the voiced regions, so pauses in the audio are pauses in the mouth.
4. Each frame samples the timeline with cross-fades (coarticulation). The audio loudness scales how wide the mouth opens. The result drives the model's `viseme_*` morph targets, with ARKit and VRM fallbacks.
5. The browser voice engine gives no access to its audio. In that case the timeline follows the clock and re-aligns on each word-boundary event.

## Repository layout

```
packages/core     Shared types, config schema, bridge protocol, text→viseme + audio analysis (no dependencies)
packages/avatar   three.js renderer: model loading, pose, idle life, moods, recoloring, accessories, speech player
apps/bridge       Local HTTP + WebSocket server: config storage, TTS engines, speech queue, static hosting
apps/web          Vite app: the avatar view plus the customization panel
packages/mcp      MCP server (stdio) exposing avatar tools to agents
packages/cli      `agentar` command: start, say, mcp, hooks, installers
docs/             Architecture, roadmap, video-call setup
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run build` | Builds every workspace in dependency order |
| `npm test` | Runs the Vitest suites (core, bridge, CLI) |
| `npm run typecheck` | Type-checks every workspace |
| `npm run dev` | Bridge (watch mode) + Vite dev server |
| `npm run fetch:models [-- --all]` | Downloads the avatar models |
| `npm run release:build` | Assembles the publishable `agentar` package in `release/agentar` (see [docs/RELEASING.md](docs/RELEASING.md)) |

## Video calls

Put `http://localhost:7777/?stage=1` in an OBS Browser Source, then start OBS's Virtual Camera. The avatar can then appear in Zoom, Teams, or Meet. See [docs/meetings.md](docs/meetings.md), and see [docs/ROADMAP.md](docs/ROADMAP.md) for plans to have the agent join calls itself.

## Credits

The lip-sync rules and the rest pose are adapted from [TalkingHead](https://github.com/met4citizen/TalkingHead) (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
