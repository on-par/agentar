# Architecture

```
 Claude Code / Codex / scripts
   │  MCP (stdio)      hooks        HTTP
   ▼                   ▼            ▼
 packages/mcp ──► apps/bridge (localhost:7777) ◄── packages/cli
                    │  config store (~/.agentar/config.json)
                    │  TTS engines (system / edge / openai / elevenlabs / xai)
                    │  speech queue + audio cache
                    ▼  WebSocket /ws  (hello, config, speak, stop, mood, gesture)
                 apps/web  (one or more views: browser tab, OBS source)
                    │
                 packages/avatar  (three.js Stage + Avatar + SpeechPlayer)
                    │
                 packages/core   (config schema, protocol, lip-sync engine)
```

## Speech flow

1. An agent calls `POST /api/say` (directly, or through the MCP server or a hook).
2. The bridge queues the utterance and renders audio with the configured engine. The `browser` engine skips this step. Audio is served at `/api/audio/:id`.
3. The bridge broadcasts `{type: "speak", utterance}` to every view.
4. Each view plays the audio and animates the face. When playback ends, it sends back `speech-end`. The first report completes the utterance. A timeout covers views that disappear mid-sentence.
5. `wait: true` holds the HTTP response until then. This lets agents take turns with the user.

## Design choices

- **The bridge is the single source of truth.** Config changes from any view are saved and broadcast, so a browser tab and an OBS source always match.
- **@agentar/core has no dependencies.** The same lip-sync code runs in Node (tests) and in the browser.
- **The bridge accepts local callers only.** It binds to 127.0.0.1 and rejects browser requests from non-localhost origins, so web pages cannot drive your avatar.
- **Model-agnostic face driving.** The avatar prefers Oculus `viseme_*` morph targets. It falls back to ARKit blendshapes, then to VRM expressions.
