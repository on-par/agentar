import { ChatError, httpError, networkError, type ChatTarget } from "./errors.js";

export interface AgentMailTarget extends ChatTarget {
  /** AgentMail API base, e.g. https://api.agentmail.to/v0. */
  baseUrl: string;
  apiKey: string;
  /** Your own inbox id (its email address). Agentar sends from here. */
  inbox: string;
  /** The agent's email address, e.g. a Grok Bot with the AgentMail plugin. */
  to: string;
}

export interface AgentMailOptions {
  /** How often to check the thread for a reply. Default 3 s. */
  pollMs?: number;
  /** How long to wait for a reply. Default 3 minutes. */
  waitMs?: number;
}

interface Thread {
  threadId: string;
  /** The agent's latest reply; the next message answers it so the thread continues. */
  lastReplyId: string;
}

interface MailMessage {
  message_id?: string;
  from?: string;
  timestamp?: string;
  text?: string;
  extracted_text?: string;
}

/**
 * Chat by email through AgentMail (https://docs.agentmail.to). Sends the
 * user's message from your inbox to the agent's address, then polls the
 * thread until the agent replies. Later messages in the same conversation
 * reply to the agent's last message, so the agent sees one thread.
 * Asynchronous by nature: no streaming, and replies can take minutes.
 */
export class AgentMailChat {
  private readonly threads = new Map<string, Thread>();
  private readonly pollMs: number;
  private readonly waitMs: number;

  constructor(opts: AgentMailOptions = {}) {
    this.pollMs = opts.pollMs ?? 3000;
    this.waitMs = opts.waitMs ?? 180_000;
  }

  async send(target: AgentMailTarget, text: string, conversation: string | undefined, signal?: AbortSignal): Promise<string> {
    const base = `${target.baseUrl.replace(/\/+$/, "")}/inboxes/${encodeURIComponent(target.inbox)}`;
    const previous = conversation ? this.threads.get(conversation) : undefined;
    const sentAt = Date.now();
    const sent = previous
      ? await this.call<{ thread_id?: string }>(target, "POST", `${base}/messages/${encodeURIComponent(previous.lastReplyId)}/reply`, { text }, signal)
      : await this.call<{ thread_id?: string }>(target, "POST", `${base}/messages/send`, { to: target.to, subject: "Chat from Agentar", text }, signal);
    const threadId = sent.thread_id ?? previous?.threadId;
    if (!threadId) throw new ChatError("upstream", `${target.label}: AgentMail did not return a thread id.`);

    const deadline = Date.now() + this.waitMs;
    const own = target.inbox.toLowerCase();
    while (Date.now() < deadline) {
      await sleep(this.pollMs, target, signal);
      const thread = await this.call<{ messages?: MailMessage[] }>(target, "GET", `${base}/threads/${encodeURIComponent(threadId)}`, undefined, signal);
      // Replies: messages from someone else, newer than ours, that we have not returned before.
      // (Allow a little clock skew between this machine and AgentMail.)
      const replies = (thread.messages ?? []).filter(
        (m) =>
          m.message_id &&
          m.message_id !== previous?.lastReplyId &&
          !(m.from ?? "").toLowerCase().includes(own) &&
          Date.parse(m.timestamp ?? "") >= sentAt - 5000,
      );
      if (replies.length) {
        if (conversation) this.threads.set(conversation, { threadId, lastReplyId: replies.at(-1)!.message_id! });
        const reply = replies
          .map((m) => (m.extracted_text ?? m.text ?? "").trim())
          .filter(Boolean)
          .join("\n\n");
        if (!reply) throw new ChatError("upstream", `${target.label} replied without any text.`);
        return reply;
      }
    }
    throw new ChatError(
      "timeout",
      `${target.label} has not replied after ${Math.round(this.waitMs / 1000)} seconds. It may still answer by email: check the thread in AgentMail.`,
    );
  }

  private async call<T>(target: AgentMailTarget, method: string, url: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: { Authorization: `Bearer ${target.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw networkError(target, err);
    }
    if (!res.ok) throw await httpError({ ...target, notFoundHint: "Check the inbox id in the Chat settings." }, url, res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ChatError("upstream", `${target.label}: AgentMail answered with something that is not JSON.`);
    }
  }
}

/** Wait, but stop early (with a ChatError) when the request is cancelled or times out. */
function sleep(ms: number, target: ChatTarget, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(networkError(target, signal.reason));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(networkError(target, signal!.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
