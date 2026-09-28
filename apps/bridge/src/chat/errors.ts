import type { ChatErrorCode } from "@agentar/core";

/** Where a request went, for error messages. */
export interface ChatTarget {
  /** e.g. "OpenClaw". */
  label: string;
  baseUrl: string;
  /** Added to the error when the endpoint is missing (404/405). */
  notFoundHint?: string;
}

/** A chat failure with a code the browser can act on and a message a person can read. */
export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** HTTP status the bridge answers with for each failure. */
export const CHAT_ERROR_STATUS: Record<ChatErrorCode, number> = {
  "bad-request": 400,
  "not-configured": 400,
  unsupported: 501,
  unreachable: 502,
  auth: 502,
  "not-found": 502,
  upstream: 502,
  timeout: 504,
  aborted: 499,
};

/** The error text of an OpenAI-style (`{error: {message}}`) or plain (`{error: "..."}`) body. */
export function errorText(body: unknown): string {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
  if (typeof error === "string") return error;
  const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" ? message : "";
}

/** Turn a non-2xx response into a ChatError. */
export async function httpError(target: ChatTarget, url: string, res: Response): Promise<ChatError> {
  const raw = await res.text().catch(() => "");
  let detail = raw.slice(0, 300).trim();
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    detail = errorText(body) || (typeof body.message === "string" ? body.message : "") || detail;
  } catch {
    /* not JSON */
  }
  const suffix = detail ? `: ${detail}` : ".";
  if (res.status === 401 || res.status === 403) {
    return new ChatError("auth", `${target.label} refused the request (${res.status}). Check the API key or token in the Chat settings${suffix}`);
  }
  if (res.status === 404 || res.status === 405) {
    const hint = target.notFoundHint ? ` ${target.notFoundHint}` : "";
    return new ChatError("not-found", `${target.label} has no chat endpoint at ${url} (${res.status}).${hint}`);
  }
  return new ChatError("upstream", `${target.label} returned an error (${res.status})${suffix}`);
}

/** Turn a failed fetch (refused, DNS, timeout, abort) into a ChatError. */
export function networkError(target: ChatTarget, err: unknown): ChatError {
  const e = err as Error & { cause?: { code?: string } };
  if (e.name === "TimeoutError") return new ChatError("timeout", `${target.label} did not answer in time.`);
  if (e.name === "AbortError") return new ChatError("aborted", "The chat request was cancelled.");
  const code = e.cause?.code;
  const why =
    code === "ECONNREFUSED"
      ? "connection refused"
      : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? "host not found"
        : code === "ECONNRESET" || code === "UND_ERR_SOCKET"
          ? "connection dropped"
          : (code ?? e.message);
  return new ChatError("unreachable", `Could not reach ${target.label} at ${target.baseUrl} (${why}). Is it running?`);
}
