# Chat with your agent

The **Chat** tab lets you talk *to* your agent from the avatar page. Pick a connector, send a message, and the reply streams in. With **Speak replies** on, the avatar also says each reply through `POST /api/say`.

The bridge makes every call to the agent. The browser never sees your API keys, and CORS does not apply. Keys are saved in `~/.agentar/config.json` under `chat`. The bridge writes this file with owner-only permissions. The browser only learns whether a key is set. A saved key belongs to its base URL: if you change the URL without entering a key again, the saved key is removed, so a changed URL cannot send the key somewhere else. You can also set each connector's environment variable where the bridge runs.

## Connectors

| Connector | Status | How it connects |
| --- | --- | --- |
| **OpenClaw** | Works | OpenAI-compatible `POST /v1/chat/completions` on the gateway (`http://127.0.0.1:18789/v1`), streamed |
| **Hermes** | Works | OpenAI-compatible `POST /v1/chat/completions` on the Hermes API server (`http://127.0.0.1:8642/v1`), streamed |
| **Grok Bot** | Experimental | Email through AgentMail. Replies can take minutes and do not stream |
| **Muse (Meta)** | Not possible yet | Meta has no third-party chat API for the Meta AI assistant |
| **Advanced (generic HTTP)** | Works | Any OpenAI-compatible chat completions server |

OpenClaw, Hermes, and Advanced share one adapter: the generic HTTP client (`apps/bridge/src/chat/openai.ts`). It posts an OpenAI chat completion, reads the server-sent event stream, and falls back to a plain JSON body when a server ignores `stream`.

### OpenClaw

Docs: [OpenAI Chat Completions endpoint](https://docs.openclaw.ai/gateway/openai-http-api).

1. The endpoint is **off by default**. Turn it on in `~/.openclaw/openclaw.json`, then restart the gateway:

   ```json5
   { gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } } }
   ```

2. In the Chat tab, paste the gateway token (`gateway.auth.token`) into **Gateway token**. You can instead set `OPENCLAW_GATEWAY_TOKEN` where the bridge runs.
3. Keep the defaults, or change them:
   - **Base URL** is `http://127.0.0.1:18789/v1`.
   - **Model** is `openclaw/default`, the default agent. Use `openclaw/<agentId>` for a specific agent.

OpenClaw keeps each conversation in an agent session. Agentar sends the OpenAI `user` field as `agentar:<conversation id>`, and it sends only the new message. The gateway derives a stable session from `user`, so it already holds the earlier turns. **New chat** starts a new session.

If the gateway answers 404, the chat endpoint is still turned off. The error message in the Chat tab says so.

### Hermes

Docs: [Hermes Agent API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).

1. Add these lines to `~/.hermes/.env`, then run `hermes gateway`:

   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=choose-a-secret
   ```

2. In the Chat tab, paste the same key into **API server key**. You can instead set `API_SERVER_KEY` where the bridge runs.
3. Keep the defaults, or change them:
   - **Base URL** is `http://127.0.0.1:8642/v1`.
   - **Model** is `hermes-agent`, or your profile name if you set one.

The chat completions endpoint of Hermes is stateless, so Agentar sends the whole conversation each time. Hermes also streams `hermes.tool.progress` events. Agentar skips them and shows only the reply text.

### Grok Bot (experimental)

Grok Bot has no public chat API. It can use email through its official [AgentMail](https://www.agentmail.to/blog/give-grok-bot-email-address) plugin. Agentar uses the [AgentMail API](https://docs.agentmail.to) to email the bot from your own inbox and wait for its reply:

1. In Grok Bot, install the AgentMail plugin. The bot gets an address such as `bot@yourworkspace.agentmail.to`.
2. Create an AgentMail inbox for yourself and an API key.
3. In the Chat tab, fill in the three fields:
   - **Your AgentMail inbox**, for example `you@agentmail.to`.
   - **Grok Bot email address**.
   - **AgentMail API key**. You can instead set `AGENTMAIL_API_KEY` where the bridge runs.

The first message starts a thread with the subject "Chat from Agentar". Later messages reply to the bot's last reply, so the whole conversation stays in one thread. The bridge checks the thread every 3 seconds, for up to 3 minutes. If no reply arrives in that time, the Chat tab says so. The bot may still answer later by email.

**Limits:** replies arrive by email, so they can take minutes and do not stream. The AgentMail calls are covered by tests against a fake AgentMail server, but nobody has tested this connector with a live Grok Bot yet. xAI's own API (`api.x.ai/v1/chat/completions`) serves the raw Grok model, not your Grok Bot. To chat with that model, use Advanced.

### Muse (Meta): not possible yet

Meta offers no third-party API for chatting with the Meta AI assistant, so the Muse connector cannot chat. The Chat tab says this and disables **Send**. Agentar does not fake a connection.

What still works:

- **Avatar speech.** Anything that can send a web request can make the avatar speak Muse's words with `POST /api/say` (see [Talking agents](../README.md#talking-agents-people-path)).
- **The raw Muse Spark model.** The [Meta Model API](https://dev.meta.ai/docs/) serves this model at `https://api.meta.ai/v1` (model `muse-spark-1.3`, OpenAI-compatible). It is the bare model, not your assistant with its memory and apps. To use it, pick **Advanced** and enter that base URL, the model, and your `MODEL_API_KEY`.

### Advanced (generic HTTP)

Advanced works with any server that implements OpenAI chat completions: a local model server (llama.cpp, Ollama, vLLM, LM Studio), a gateway, or a cloud API. Set **Base URL** to the address that comes before `/chat/completions`, which usually ends in `/v1`. Then set the model and, if the server needs one, the key. Agentar sends the whole conversation each time.

## HTTP API

Scripts can use the chat endpoints directly. As with every bridge endpoint, only local callers are accepted.

```bash
curl -X POST localhost:7777/api/chat -H 'Content-Type: application/json' \
  -d '{"connector":"openclaw","messages":[{"role":"user","content":"Hi!"}]}'
# {"connector":"openclaw","reply":"Hello! ..."}
```

**`POST /api/chat`** request body:

| Field | Required | Meaning |
| --- | --- | --- |
| `messages` | Yes | The conversation, oldest first, as `{role, content}` objects. The last one must be a `user` message. |
| `connector` | No | `openclaw`, `hermes`, `grok`, `muse`, or `http`. Default: the connector selected in the Chat tab. |
| `conversation` | No | A stable id that keeps a session going (OpenClaw, Grok Bot). |
| `stream` | No | Set to `true` to get NDJSON lines instead of one JSON body: `{"type":"delta","text":...}` for each piece of the reply, then `{"type":"done","reply":...}` or `{"type":"error","error":...,"code":...}`. |

**Errors** return JSON of the form `{"error": "...", "code": "..."}`:

| HTTP status | `code` | Meaning |
| --- | --- | --- |
| 400 | `bad-request` | The request body is invalid, or the connector name is unknown. |
| 400 | `not-configured` | A connector setting is missing. |
| 501 | `unsupported` | The connector cannot chat (Muse). |
| 502 | `unreachable` | The agent is not running, or it refused the connection. |
| 502 | `auth` | The agent rejected the key or token. |
| 502 | `not-found` | The chat endpoint does not exist, for example because it is turned off. |
| 502 | `upstream` | The agent returned any other error. |
| 504 | `timeout` | No reply arrived within 5 minutes. For Grok Bot, the limit is 3 minutes. |

When `stream` is true and the call fails before any reply text arrives, the error still comes back with its real status code.

**`GET /api/chat/config`** returns the chat settings without keys. For each connector, it shows `apiKeySet` and `apiKeyFromEnv` instead of the key.

**`PUT /api/chat/config`** saves a partial patch, for example `{"connector":"hermes","connectors":{"hermes":{"apiKey":"..."}}}`. Fields you leave out keep their saved value. An empty string clears a field.
