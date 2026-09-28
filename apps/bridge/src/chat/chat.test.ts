import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CHAT_CONFIG, mergeChatConfig, type ChatConfig } from "@agentar/core";
import { AgentMailChat, ChatError, ChatService, openAiChat, parseChatRequest } from "./index.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: any;
}

/** A throwaway HTTP server standing in for an agent gateway. */
async function fakeUpstream(handler: (req: Seen, res: ServerResponse) => void): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(s);
    handler(s, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const completion = (text: string) => ({ choices: [{ index: 0, message: { role: "assistant", content: text } }] });

/** A port nothing listens on. */
async function closedPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`;
}

const hi = [{ role: "user" as const, content: "Hi" }];

describe("openAiChat (generic HTTP adapter)", () => {
  it("posts an OpenAI chat completion and returns the reply", async () => {
    const up = await fakeUpstream((_req, res) => json(res, 200, completion("Hello from the agent")));
    const reply = await openAiChat({ label: "OpenClaw", baseUrl: `${up.url}/v1/`, model: "openclaw/default", apiKey: "tok", user: "agentar:c1" }, hi);
    expect(reply).toBe("Hello from the agent");
    const [req] = up.seen;
    expect(req).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(req!.headers.authorization).toBe("Bearer tok");
    expect(req!.body).toEqual({ model: "openclaw/default", messages: hi, stream: false, user: "agentar:c1" });
  });

  it("streams server-sent events and skips named events", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
      res.write(chunk("Hel"));
      res.write(`event: hermes.tool.progress\ndata: ${JSON.stringify({ choices: [{ delta: { content: "IGNORED" } }] })}\n\n`);
      res.write(": keep-alive\n\n");
      res.write(chunk("lo") + "data: [DONE]\n\n");
      res.end();
    });
    const deltas: string[] = [];
    const reply = await openAiChat({ label: "Hermes", baseUrl: up.url, model: "hermes-agent" }, hi, { onDelta: (t) => deltas.push(t) });
    expect(reply).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(up.seen[0]!.body.stream).toBe(true);
    expect(up.seen[0]!.headers.authorization).toBeUndefined();
  });

  it("reads a plain JSON body when the server ignores stream", async () => {
    const up = await fakeUpstream((_req, res) => json(res, 200, completion("Whole reply")));
    const deltas: string[] = [];
    expect(await openAiChat({ label: "X", baseUrl: up.url, model: "m" }, hi, { onDelta: (t) => deltas.push(t) })).toBe("Whole reply");
    expect(deltas).toEqual(["Whole reply"]);
  });

  it("explains auth, missing endpoint, upstream and empty-reply failures", async () => {
    const cases: Array<[number, unknown, string, RegExp]> = [
      [401, { error: { message: "bad token" } }, "auth", /refused the request \(401\).*bad token/],
      [404, { error: "Not Found" }, "not-found", /no chat endpoint .*\/chat\/completions \(404\)\. Enable it/],
      [500, { error: { message: "model crashed" } }, "upstream", /error \(500\): model crashed/],
      [200, completion("  "), "upstream", /empty reply/],
    ];
    for (const [status, body, code, message] of cases) {
      const up = await fakeUpstream((_req, res) => json(res, status, body));
      const err = await openAiChat({ label: "OpenClaw", baseUrl: up.url, model: "m", notFoundHint: "Enable it." }, hi).catch((e) => e);
      expect(err).toBeInstanceOf(ChatError);
      expect(err).toMatchObject({ code });
      expect(err.message).toMatch(message);
    }
  });

  it("reports an agent that is not running", async () => {
    const baseUrl = await closedPort();
    const err = await openAiChat({ label: "OpenClaw", baseUrl, model: "m" }, hi).catch((e) => e);
    expect(err).toMatchObject({ code: "unreachable" });
    expect(err.message).toBe(`Could not reach OpenClaw at ${baseUrl} (connection refused). Is it running?`);
  });

  it("times out", async () => {
    const up = await fakeUpstream(() => undefined); // never answers
    const err = await openAiChat({ label: "Slow", baseUrl: up.url, model: "m" }, hi, { signal: AbortSignal.timeout(50) }).catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    up.server.closeAllConnections();
  });
});

describe("AgentMailChat (Grok Bot)", () => {
  const INBOX = "me@agentmail.to";
  const BOT = "grok@acme.agentmail.to";

  /** A fake AgentMail API where the bot answers after `delay` polls. */
  async function fakeAgentMail(botText: string | null, delay = 1) {
    let polls = 0;
    const thread: Array<Record<string, string>> = [];
    let n = 0;
    let replies = 0;
    const add = (from: string, text: string) => {
      const m = { message_id: `m${++n}`, from, timestamp: new Date().toISOString(), text: `${text}\n\n> quoted`, extracted_text: text };
      thread.push(m);
      return m;
    };
    const up = await fakeUpstream((req, res) => {
      if (req.method === "POST") {
        const m = add(`Me <${INBOX}>`, req.body.text);
        polls = 0;
        return json(res, 200, { message_id: m.message_id, thread_id: "t1" });
      }
      if (++polls >= delay && botText && thread.at(-1)!.from.includes(INBOX)) add(`Grok Bot <${BOT}>`, `${botText} #${++replies}`);
      json(res, 200, { thread_id: "t1", messages: thread });
    });
    return { ...up, target: { label: "Grok Bot", baseUrl: `${up.url}/v0`, apiKey: "am_key", inbox: INBOX, to: BOT } };
  }

  it("emails the bot, waits for its reply, and continues the thread", async () => {
    const mail = await fakeAgentMail("Sure thing", 2);
    const chat = new AgentMailChat({ pollMs: 5, waitMs: 2000 });
    expect(await chat.send(mail.target, "First question", "c1")).toBe("Sure thing #1");
    expect(await chat.send(mail.target, "Second question", "c1")).toBe("Sure thing #2");

    const posts = mail.seen.filter((s) => s.method === "POST");
    expect(posts[0]).toMatchObject({ url: `/v0/inboxes/${encodeURIComponent(INBOX)}/messages/send`, body: { to: BOT, text: "First question" } });
    expect(posts[0]!.headers.authorization).toBe("Bearer am_key");
    // The follow-up replies to the bot's last message, so it stays in one thread.
    expect(posts[1]).toMatchObject({ url: `/v0/inboxes/${encodeURIComponent(INBOX)}/messages/m2/reply`, body: { text: "Second question" } });
    expect(mail.seen.some((s) => s.method === "GET" && s.url === `/v0/inboxes/${encodeURIComponent(INBOX)}/threads/t1`)).toBe(true);
  });

  it("gives up honestly when no reply arrives", async () => {
    const mail = await fakeAgentMail(null);
    const err = await new AgentMailChat({ pollMs: 5, waitMs: 40 }).send(mail.target, "Hello?", "c1").catch((e) => e);
    expect(err).toMatchObject({ code: "timeout" });
    expect(err.message).toMatch(/has not replied .* check the thread in AgentMail/);
  });

  it("maps a wrong API key to an auth error", async () => {
    const up = await fakeUpstream((_req, res) => json(res, 401, { name: "Unauthorized", message: "Invalid API key" }));
    const err = await new AgentMailChat({ pollMs: 5 })
      .send({ label: "Grok Bot", baseUrl: up.url, apiKey: "x", inbox: INBOX, to: BOT }, "Hi", undefined)
      .catch((e) => e);
    expect(err).toMatchObject({ code: "auth" });
    expect(err.message).toMatch(/Invalid API key/);
  });
});

describe("ChatService", () => {
  const config = (patch: unknown): ChatConfig => mergeChatConfig(DEFAULT_CHAT_CONFIG, patch);

  it("refuses Muse honestly instead of pretending", async () => {
    const err = await new ChatService().send(config({}), { connector: "muse", messages: hi }).catch((e) => e);
    expect(err).toMatchObject({ code: "unsupported" });
    expect(err.message).toMatch(/Muse \(Meta\) cannot chat through Agentar\. Meta has no third-party chat API/);
  });

  it("sends OpenClaw only the new message plus a session key, with the env token", async () => {
    const up = await fakeUpstream((_req, res) => json(res, 200, completion("ok")));
    const service = new ChatService({ env: { OPENCLAW_GATEWAY_TOKEN: "gw-token" } });
    const messages = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
    ];
    const res = await service.send(config({ connectors: { openclaw: { baseUrl: `${up.url}/v1` } } }), { messages, conversation: "abc" });
    expect(res).toEqual({ connector: "openclaw", reply: "ok" });
    expect(up.seen[0]!.headers.authorization).toBe("Bearer gw-token");
    expect(up.seen[0]!.body).toMatchObject({ model: "openclaw/default", user: "agentar:abc", messages: [{ role: "user", content: "three" }] });
  });

  it("sends Hermes the whole history with its saved key", async () => {
    const up = await fakeUpstream((_req, res) => json(res, 200, completion("ok")));
    const messages = [
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
    ];
    await new ChatService({ env: {} }).send(config({ connectors: { hermes: { baseUrl: up.url, apiKey: "hk" } } }), {
      connector: "hermes",
      messages,
      conversation: "abc",
    });
    expect(up.seen[0]!.headers.authorization).toBe("Bearer hk");
    expect(up.seen[0]!.body).toMatchObject({ model: "hermes-agent", messages });
    expect(up.seen[0]!.body.user).toBeUndefined();
  });

  it("asks for missing Grok Bot settings", async () => {
    const err = await new ChatService({ env: {} }).send(config({}), { connector: "grok", messages: hi }).catch((e) => e);
    expect(err).toMatchObject({ code: "not-configured" });
    expect(err.message).toBe("Set the AgentMail API key, your inbox, and the Grok Bot email address in the Chat settings.");
  });

  it("never shows keys in the browser view", () => {
    const view = new ChatService({ env: { API_SERVER_KEY: "from-env" } }).view(config({ connectors: { openclaw: { apiKey: "secret" } } }));
    expect(JSON.stringify(view)).not.toMatch(/secret|from-env/);
    expect(view.connectors.openclaw).toMatchObject({ apiKeySet: true, apiKeyFromEnv: false, baseUrl: "http://127.0.0.1:18789/v1" });
    expect(view.connectors.hermes).toMatchObject({ apiKeySet: true, apiKeyFromEnv: true });
    expect(view.connectors.http).toMatchObject({ apiKeySet: false, apiKeyFromEnv: false });
  });
});

describe("parseChatRequest", () => {
  it("accepts a valid request", () => {
    expect(parseChatRequest({ connector: "hermes", messages: hi, conversation: "c-1", stream: true })).toEqual({
      connector: "hermes",
      messages: hi,
      conversation: "c-1",
      stream: true,
    });
  });

  it("rejects bad input with a readable message", () => {
    expect(parseChatRequest(null)).toMatch(/JSON body/);
    expect(parseChatRequest({ connector: "skynet", messages: hi })).toMatch(/Unknown connector/);
    expect(parseChatRequest({ messages: [] })).toMatch(/1 to 100/);
    expect(parseChatRequest({ messages: [{ role: "tool", content: "x" }] })).toMatch(/role/);
    expect(parseChatRequest({ messages: [{ role: "assistant", content: "x" }] })).toMatch(/last message/);
    expect(parseChatRequest({ messages: hi, conversation: "has spaces" })).toMatch(/conversation/);
  });
});
