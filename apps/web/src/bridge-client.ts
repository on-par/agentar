import type {
  AvatarConfig,
  ChatConfigView,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ClientMessage,
  SayRequest,
  SayResponse,
  ServerMessage,
  VoiceInfo,
  VoiceProvider,
} from "@agentar/core";

export type ConnectionState = "connecting" | "open" | "closed";

export interface ModelList {
  builtin: Array<{ id: string; label: string; license: string; url: string; available: boolean }>;
  user: Array<{ name: string; url: string }>;
}

export interface BridgeInfo {
  version: string;
  url: string;
  /** Absolute path of the agentar CLI entry point, for copy-paste commands. */
  cliPath: string;
}

export interface VoiceList {
  provider: VoiceProvider;
  available: boolean;
  reason?: string;
  voices: VoiceInfo[];
}

/**
 * Talks to the local bridge: a WebSocket for live events (with automatic
 * reconnect) and small REST helpers.
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  onMessage: (msg: ServerMessage) => void = () => undefined;
  onState: (state: ConnectionState) => void = () => undefined;

  connect(): void {
    this.closed = false;
    this.onState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onState("open");
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch (err) {
        console.error("[agentar] bad message", err);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.onState("closed");
      if (this.closed) return;
      const delay = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  async info(): Promise<BridgeInfo> {
    return json(await fetch("/api/info"));
  }

  async updateConfig(patch: unknown): Promise<AvatarConfig> {
    return json(await fetch("/api/config", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(patch) }));
  }

  async say(req: SayRequest): Promise<SayResponse> {
    const res = await fetch("/api/say", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(req) });
    return (await res.json()) as SayResponse;
  }

  async stop(): Promise<void> {
    await fetch("/api/stop", { method: "POST" });
  }

  async voices(provider: VoiceProvider): Promise<VoiceList> {
    return json(await fetch(`/api/voices?provider=${provider}`));
  }

  async models(): Promise<ModelList> {
    return json(await fetch("/api/models"));
  }

  async chatConfig(): Promise<ChatConfigView> {
    return json(await fetch("/api/chat/config"));
  }

  async updateChatConfig(patch: unknown): Promise<ChatConfigView> {
    return json(await fetch("/api/chat/config", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(patch) }));
  }

  /** Send a chat to the agent through the bridge. Reply text streams into `onDelta`. */
  async chat(req: Omit<ChatRequest, "stream">, onDelta: (text: string) => void, signal?: AbortSignal): Promise<ChatResponse> {
    const res = await fetch("/api/chat", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...req, stream: true }), signal });
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("ndjson")) return json(res);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ChatStreamEvent;
        if (event.type === "delta") onDelta(event.text);
        else if (event.type === "done") return { connector: event.connector, reply: event.reply };
        else throw new Error(event.error);
      }
      if (done) throw new Error("The bridge closed the chat before the reply finished.");
    }
  }

  async uploadModel(file: File): Promise<{ name: string; url: string }> {
    const res = await fetch(`/api/models?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
    return json(res);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}
