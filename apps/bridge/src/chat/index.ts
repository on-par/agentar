import {
  CHAT_CONNECTORS,
  CHAT_CONNECTOR_INFO,
  effectiveChatSettings,
  isChatConnector,
  type ChatConfig,
  type ChatConfigView,
  type ChatConnectorId,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
} from "@agentar/core";
import { AgentMailChat, type AgentMailOptions } from "./agentmail.js";
import { ChatError } from "./errors.js";
import { openAiChat, type ChatCallOptions } from "./openai.js";

export { ChatError, CHAT_ERROR_STATUS } from "./errors.js";
export { AgentMailChat } from "./agentmail.js";
export { openAiChat } from "./openai.js";

/** Extra help when a connector's chat endpoint answers 404. */
const NOT_FOUND_HINTS: Partial<Record<ChatConnectorId, string>> = {
  openclaw:
    "The endpoint is off by default: set gateway.http.endpoints.chatCompletions.enabled to true in ~/.openclaw/openclaw.json and restart the gateway.",
  hermes: "Set API_SERVER_ENABLED=true in ~/.hermes/.env and run `hermes gateway`.",
  http: "The base URL should end where /chat/completions starts, usually with /v1.",
};

const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 20_000;

export interface ChatServiceOptions {
  /** Where connector API keys are looked up when none is saved. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Give up on a reply after this long. Default 5 minutes (agents may run tools first). */
  timeoutMs?: number;
  agentMail?: AgentMailOptions;
}

/** Routes a chat request to the named connector's adapter. */
export class ChatService {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly agentMail: AgentMailChat;

  constructor(opts: ChatServiceOptions = {}) {
    this.env = opts.env ?? process.env;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.agentMail = new AgentMailChat(opts.agentMail);
  }

  /** The config as the browser may see it: keys replaced by flags. */
  view(config: ChatConfig): ChatConfigView {
    const connectors = Object.fromEntries(
      CHAT_CONNECTORS.map((id) => {
        const { apiKey, ...rest } = config.connectors[id];
        const fromEnv = !apiKey && Boolean(this.envKey(id));
        return [id, { ...rest, apiKeySet: Boolean(apiKey) || fromEnv, apiKeyFromEnv: fromEnv }];
      }),
    ) as ChatConfigView["connectors"];
    return { connector: config.connector, sayReplies: config.sayReplies, connectors };
  }

  async send(config: ChatConfig, req: ChatRequest, opts: ChatCallOptions = {}): Promise<ChatResponse> {
    const id = req.connector ?? config.connector;
    const info = CHAT_CONNECTOR_INFO[id];
    const settings = effectiveChatSettings(config, id);
    const apiKey = settings.apiKey || this.envKey(id) || "";
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const last = req.messages.at(-1)!;

    switch (info.transport) {
      case "none":
        throw new ChatError("unsupported", `${info.label} cannot chat through Agentar. ${info.gap ?? ""}`.trim());

      case "openai": {
        if (!settings.baseUrl) throw new ChatError("not-configured", `Set the ${info.label} base URL in the Chat settings.`);
        if (!settings.model) throw new ChatError("not-configured", `Set the ${info.label} model in the Chat settings.`);
        // A sessionful agent keeps the history itself; resending it would repeat every turn.
        const sessionful = info.sessionful && req.conversation;
        const reply = await openAiChat(
          {
            label: info.label,
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey,
            user: sessionful ? `agentar:${req.conversation}` : undefined,
            notFoundHint: NOT_FOUND_HINTS[id],
          },
          sessionful ? [last] : req.messages,
          { signal, onDelta: opts.onDelta },
        );
        return { connector: id, reply };
      }

      case "agentmail": {
        const missing = [!apiKey && `the ${info.apiKeyLabel}`, !settings.inbox && "your inbox", !settings.to && `the ${info.label} email address`].filter(
          (m): m is string => Boolean(m),
        );
        if (missing.length) throw new ChatError("not-configured", `Set ${listText(missing)} in the Chat settings.`);
        const reply = await this.agentMail.send(
          { label: info.label, baseUrl: settings.baseUrl, apiKey, inbox: settings.inbox, to: settings.to },
          last.content,
          req.conversation,
          signal,
        );
        opts.onDelta?.(reply);
        return { connector: id, reply };
      }
    }
  }

  private envKey(id: ChatConnectorId): string | undefined {
    const name = CHAT_CONNECTOR_INFO[id].apiKeyEnv;
    return name ? this.env[name] || undefined : undefined;
  }
}

/** "a", "a and b", "a, b, and c". */
function listText(items: string[]): string {
  return items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** Validate an untrusted POST /api/chat body. Returns an error message when it is unusable. */
export function parseChatRequest(body: unknown): ChatRequest | string {
  if (typeof body !== "object" || body === null) return "Send a JSON body with `messages`.";
  const b = body as Record<string, unknown>;
  if (b.connector !== undefined && !isChatConnector(b.connector)) {
    return `Unknown connector. Use one of: ${CHAT_CONNECTORS.join(", ")}.`;
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) {
    return `\`messages\` must be a list of 1 to ${MAX_MESSAGES} messages.`;
  }
  const messages: ChatMessage[] = [];
  for (const m of b.messages as unknown[]) {
    const { role, content } = (typeof m === "object" && m !== null ? m : {}) as Record<string, unknown>;
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string" || content.length > MAX_MESSAGE_CHARS) {
      return `Each message needs a role (system, user, assistant) and text content of at most ${MAX_MESSAGE_CHARS} characters.`;
    }
    messages.push({ role, content });
  }
  const last = messages.at(-1)!;
  if (last.role !== "user" || !last.content.trim()) return "The last message must be a non-empty user message.";
  if (b.conversation !== undefined && (typeof b.conversation !== "string" || !/^[\w.:-]{1,128}$/.test(b.conversation))) {
    return "`conversation` must be 1 to 128 letters, digits, `-`, `_`, `.` or `:`.";
  }
  return {
    ...(b.connector !== undefined ? { connector: b.connector as ChatConnectorId } : {}),
    messages,
    ...(typeof b.conversation === "string" ? { conversation: b.conversation } : {}),
    stream: b.stream === true,
  };
}
