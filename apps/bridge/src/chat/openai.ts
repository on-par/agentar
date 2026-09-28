import type { ChatMessage } from "@agentar/core";
import { ChatError, errorText, httpError, networkError, type ChatTarget } from "./errors.js";

export interface OpenAiChatTarget extends ChatTarget {
  /** Base URL including the API version, e.g. http://127.0.0.1:18789/v1. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra request headers some gateways use (agent id, session key). */
  headers?: Record<string, string>;
  /** Stable conversation key, sent as the OpenAI `user` field. */
  user?: string;
}

export interface ChatCallOptions {
  signal?: AbortSignal;
  /** Receive reply text as it streams in. Without it the request is not streamed. */
  onDelta?: (text: string) => void;
}

/**
 * The shared "generic HTTP" chat client: one OpenAI-style
 * `POST {baseUrl}/chat/completions` call. OpenClaw, Hermes and the Advanced
 * connector all go through here. Streams (SSE) when `onDelta` is given, and
 * falls back to reading a plain JSON body when the server ignores `stream`.
 */
export async function openAiChat(target: OpenAiChatTarget, messages: ChatMessage[], opts: ChatCallOptions = {}): Promise<string> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const stream = Boolean(opts.onDelta);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream, application/json" : "application/json",
    ...target.headers,
  };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  const body: Record<string, unknown> = { model: target.model, messages, stream };
  if (target.user) body.user = target.user;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
  } catch (err) {
    throw networkError(target, err);
  }

  if (!res.ok) throw await httpError(target, url, res);

  try {
    const type = res.headers.get("content-type") ?? "";
    const reply = type.includes("text/event-stream") && res.body ? await readSse(res.body, opts.onDelta) : await readJsonReply(res, opts.onDelta);
    if (!reply.trim()) throw new ChatError("upstream", `${target.label} sent an empty reply.`);
    return reply;
  } catch (err) {
    if (err instanceof ChatError) throw err;
    throw networkError(target, err);
  }
}

async function readJsonReply(res: Response, onDelta?: (text: string) => void): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ChatError("upstream", "The agent answered with something that is not JSON.");
  }
  const reply = messageText(body);
  if (reply && onDelta) onDelta(reply);
  return reply;
}

/**
 * Read an OpenAI-style server-sent event stream and return the whole reply.
 * Named events (Hermes sends `event: hermes.tool.progress`) are skipped:
 * only unnamed `data:` events carry completion chunks.
 */
async function readSse(stream: ReadableStream<Uint8Array>, onDelta?: (text: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let event = "";
  const handle = (line: string): boolean => {
    if (line === "") {
      event = ""; // a blank line ends the event
      return false;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      return false;
    }
    if (!line.startsWith("data:") || (event && event !== "message")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return true;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return false; // keep-alives and comments
    }
    const err = errorText(chunk);
    if (err) throw new ChatError("upstream", `The agent reported an error: ${err}`);
    const text = deltaText(chunk);
    if (text) {
      reply += text;
      onDelta?.(text);
    }
    return false;
  };
  for await (const bytes of stream) {
    buffer += decoder.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (handle(line)) return reply;
    }
  }
  handle(buffer.trim());
  return reply;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const firstChoice = (v: unknown): Json | undefined => {
  const choices = obj(v)?.choices;
  return Array.isArray(choices) ? obj(choices[0]) : undefined;
};

/** `choices[0].message.content` as a string (also accepts content-part arrays). */
export function messageText(body: unknown): string {
  return contentText(obj(firstChoice(body)?.message)?.content);
}

function deltaText(event: unknown): string {
  return contentText(obj(firstChoice(event)?.delta)?.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof obj(p)?.text === "string" ? (obj(p)!.text as string) : "")).join("");
  return "";
}
