/**
 * Chat: talking *to* your agent from the avatar page. Each named connector
 * (OpenClaw, Hermes, Grok Bot, Muse, or Advanced) knows how to reach one
 * kind of agent. The bridge makes the outbound calls, so API keys never
 * reach the browser. Persisted by the bridge under `chat` in
 * ~/.agentar/config.json, next to the avatar config.
 */
import { bool, isDict, oneOf, str, type Dict } from "./validate.js";

export const CHAT_CONNECTORS = ["openclaw", "hermes", "grok", "muse", "http"] as const;
export type ChatConnectorId = (typeof CHAT_CONNECTORS)[number];

/**
 * How the bridge talks to a connector:
 * - `openai`: an OpenAI-compatible `POST {baseUrl}/chat/completions` (the generic HTTP adapter)
 * - `agentmail`: email through AgentMail; replies arrive in the same thread
 * - `none`: no third-party chat API exists; the connector cannot chat
 */
export type ChatTransport = "openai" | "agentmail" | "none";

export type ChatSettingKey = "baseUrl" | "model" | "apiKey" | "inbox" | "to";

export interface ChatConnectorSettings {
  /** API base URL including the version, e.g. http://127.0.0.1:18789/v1. */
  baseUrl: string;
  model: string;
  /** Bearer token. Kept in the bridge; the browser only learns whether one is set. */
  apiKey: string;
  /** AgentMail: your own inbox id (its email address). */
  inbox: string;
  /** AgentMail: the agent's email address. */
  to: string;
}

export interface ChatConnectorInfo {
  id: ChatConnectorId;
  label: string;
  transport: ChatTransport;
  /** Settings shown in the Chat tab for this connector, in order. */
  fields: readonly ChatSettingKey[];
  defaults: ChatConnectorSettings;
  /** Label of the apiKey field, e.g. "Gateway token". */
  apiKeyLabel?: string;
  /** Environment variable the bridge reads when no key is saved. */
  apiKeyEnv?: string;
  /**
   * The agent keeps the conversation itself: send only the newest message
   * plus a stable conversation key, instead of the whole history.
   */
  sessionful?: boolean;
  /** One or two sentences on how to set the agent up. */
  help: string;
  /** Honest caveat shown in the Chat tab (experimental, or why it cannot chat). */
  gap?: string;
}

const EMPTY: ChatConnectorSettings = { baseUrl: "", model: "", apiKey: "", inbox: "", to: "" };

export const CHAT_CONNECTOR_INFO: Record<ChatConnectorId, ChatConnectorInfo> = {
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    transport: "openai",
    fields: ["baseUrl", "model", "apiKey"],
    defaults: { ...EMPTY, baseUrl: "http://127.0.0.1:18789/v1", model: "openclaw/default" },
    apiKeyLabel: "Gateway token",
    apiKeyEnv: "OPENCLAW_GATEWAY_TOKEN",
    sessionful: true,
    help:
      "Talks to your OpenClaw gateway's OpenAI-compatible endpoint. It is off by default: set gateway.http.endpoints.chatCompletions.enabled to true in ~/.openclaw/openclaw.json. Use model openclaw/<agentId> for a specific agent.",
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    transport: "openai",
    fields: ["baseUrl", "model", "apiKey"],
    defaults: { ...EMPTY, baseUrl: "http://127.0.0.1:8642/v1", model: "hermes-agent" },
    apiKeyLabel: "API server key",
    apiKeyEnv: "API_SERVER_KEY",
    help:
      "Talks to the Hermes Agent API server. Set API_SERVER_ENABLED=true and API_SERVER_KEY in ~/.hermes/.env, then run `hermes gateway`. The model name is your profile name (hermes-agent by default).",
  },
  grok: {
    id: "grok",
    label: "Grok Bot",
    transport: "agentmail",
    fields: ["inbox", "to", "apiKey", "baseUrl"],
    defaults: { ...EMPTY, baseUrl: "https://api.agentmail.to/v0" },
    apiKeyLabel: "AgentMail API key",
    apiKeyEnv: "AGENTMAIL_API_KEY",
    help:
      "Grok Bot has no public chat API. With the AgentMail plugin installed in Grok Bot, Agentar emails the bot from your own AgentMail inbox and waits for its reply in the same thread.",
    gap: "Experimental: replies come by email, can take minutes, and do not stream. Not yet tested against a live Grok Bot.",
  },
  muse: {
    id: "muse",
    label: "Muse (Meta)",
    transport: "none",
    fields: [],
    defaults: { ...EMPTY },
    help: "Muse can still speak through the avatar: have it POST replies to /api/say (see Connect).",
    gap:
      "Meta has no third-party chat API for the Meta AI assistant, so Agentar cannot chat with it. The Meta Model API (https://api.meta.ai/v1, model muse-spark-1.3) serves the raw Muse Spark model, not your assistant; to use that model, pick Advanced.",
  },
  http: {
    id: "http",
    label: "Advanced (generic HTTP)",
    transport: "openai",
    fields: ["baseUrl", "model", "apiKey"],
    defaults: { ...EMPTY, baseUrl: "http://127.0.0.1:8000/v1" },
    apiKeyLabel: "API key",
    help: "Any OpenAI-compatible chat completions server: a local model server, a gateway, or a cloud API. The bridge calls {base URL}/chat/completions.",
  },
};

export interface ChatConfig {
  /** The connector the Chat tab uses. */
  connector: ChatConnectorId;
  /** Speak each reply through the avatar (POST /api/say). */
  sayReplies: boolean;
  connectors: Record<ChatConnectorId, ChatConnectorSettings>;
}

/** What the bridge sends the browser: no keys, only whether one is available. */
export interface ChatConnectorSettingsView extends Omit<ChatConnectorSettings, "apiKey"> {
  apiKeySet: boolean;
  /** The key comes from the connector's environment variable. */
  apiKeyFromEnv: boolean;
}

export interface ChatConfigView {
  connector: ChatConnectorId;
  sayReplies: boolean;
  connectors: Record<ChatConnectorId, ChatConnectorSettingsView>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** POST /api/chat */
export interface ChatRequest {
  /** Default: the configured connector. */
  connector?: ChatConnectorId;
  /** The conversation so far, oldest first. The last one is the new user message. */
  messages: ChatMessage[];
  /** Stable id for this conversation (letters, digits, `-`, `_`, `.`, `:`). */
  conversation?: string;
  /** Answer with NDJSON ChatStreamEvent lines instead of one JSON body. */
  stream?: boolean;
}

export interface ChatResponse {
  connector: ChatConnectorId;
  reply: string;
}

export type ChatErrorCode = "bad-request" | "unsupported" | "not-configured" | "unreachable" | "auth" | "not-found" | "timeout" | "upstream" | "aborted";

export interface ChatErrorResponse {
  error: string;
  code: ChatErrorCode;
}

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | ({ type: "done" } & ChatResponse)
  | ({ type: "error" } & ChatErrorResponse);

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  connector: "openclaw",
  sayReplies: true,
  connectors: Object.fromEntries(CHAT_CONNECTORS.map((id) => [id, { ...CHAT_CONNECTOR_INFO[id].defaults }])) as Record<
    ChatConnectorId,
    ChatConnectorSettings
  >,
};

export function isChatConnector(v: unknown): v is ChatConnectorId {
  return typeof v === "string" && (CHAT_CONNECTORS as readonly string[]).includes(v);
}

/** Connectors may call http(s) URLs only. */
export function isAllowedChatUrl(url: string): boolean {
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(url);
}

function url(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const t = v.trim();
  return t === "" || (t.length <= 512 && isAllowedChatUrl(t)) ? t : fallback;
}

function settings(v: Dict, base: ChatConnectorSettings): ChatConnectorSettings {
  const baseUrl = url(v.baseUrl, base.baseUrl);
  // A saved key belongs to its server: moving the base URL forgets it unless
  // the same patch supplies one, so a changed URL cannot carry the key away.
  const keptKey = baseUrl === base.baseUrl ? base.apiKey : "";
  return {
    baseUrl,
    model: str(v.model, 128, base.model).trim(),
    apiKey: str(v.apiKey, 1024, keptKey).trim(),
    inbox: str(v.inbox, 256, base.inbox).trim(),
    to: str(v.to, 256, base.to).trim(),
  };
}

/**
 * Apply a (possibly partial, possibly untrusted) patch on top of a base chat
 * config. Omitted fields keep their value, so the browser can save settings
 * without knowing the stored key; an empty string clears a field. Changing
 * the base URL without a new key clears the saved key.
 */
export function mergeChatConfig(base: ChatConfig, patch: unknown): ChatConfig {
  const p = isDict(patch) ? patch : {};
  const c = isDict(p.connectors) ? p.connectors : {};
  return {
    connector: oneOf(p.connector, CHAT_CONNECTORS, base.connector),
    sayReplies: bool(p.sayReplies, base.sayReplies),
    connectors: Object.fromEntries(
      CHAT_CONNECTORS.map((id) => [id, settings(isDict(c[id]) ? c[id] : {}, base.connectors[id])]),
    ) as Record<ChatConnectorId, ChatConnectorSettings>,
  };
}

/** Parse a stored chat config, filling anything missing from the defaults. */
export function resolveChatConfig(input: unknown): ChatConfig {
  return mergeChatConfig(DEFAULT_CHAT_CONFIG, input);
}

/** The settings a connector will use: saved values, with empty fields filled from the defaults. */
export function effectiveChatSettings(config: ChatConfig, id: ChatConnectorId): ChatConnectorSettings {
  const saved = config.connectors[id];
  const d = CHAT_CONNECTOR_INFO[id].defaults;
  return {
    baseUrl: saved.baseUrl || d.baseUrl,
    model: saved.model || d.model,
    apiKey: saved.apiKey,
    inbox: saved.inbox,
    to: saved.to,
  };
}
