import { randomUUID } from "node:crypto";
import type { Mood, SayRequest, SayResponse, ServerMessage, Utterance } from "@agentar/core";

export interface RenderedAudio {
  url: string;
  mime: string;
}

export interface SpeechQueueDeps {
  /** Render audio for text, or return null when the client speaks it itself. */
  render(id: string, text: string, signal: AbortSignal): Promise<RenderedAudio | null>;
  broadcast(msg: ServerMessage): void;
  clientCount(): number;
  /** Current speaking-rate multiplier, so the safety timeout allows for slow voices. */
  speechRate?(): number;
}

interface Item {
  id: string;
  text: string;
  mood?: Mood;
  abort: AbortController;
  audio: Promise<RenderedAudio | null>;
  dispatched: Deferred<SayResponse>;
  finished: Deferred<SayResponse>;
  timer?: NodeJS.Timeout;
  /** Clients connected when the item was sent out, and how many of them reported an error. */
  audience: number;
  failures: number;
}

/**
 * Serialises utterances across all connected avatars.
 * Audio for queued items is rendered eagerly so there is no gap between
 * sentences. The first client to finish an item completes it (errors count
 * only once every client has failed); a timeout guards against clients that
 * disappear mid-sentence.
 */
export class SpeechQueue {
  private readonly queue: Item[] = [];
  private current: Item | null = null;

  constructor(private readonly deps: SpeechQueueDeps) {}

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  async say(req: SayRequest): Promise<SayResponse> {
    const id = randomUUID();
    if (this.deps.clientCount() === 0) {
      return { id, status: "no-clients", error: "No avatar is connected. Open the agentar page in a browser first." };
    }
    if (req.interrupt ?? true) this.stop();

    const abort = new AbortController();
    const item: Item = {
      id,
      text: req.text,
      mood: req.mood,
      abort,
      audio: this.deps.render(id, req.text, abort.signal),
      dispatched: deferred(),
      finished: deferred(),
      audience: 0,
      failures: 0,
    };
    // Avoid unhandled rejections; errors are surfaced when the item plays.
    item.audio.catch(() => undefined);
    const isNext = this.current === null && this.queue.length === 0;
    this.queue.push(item);
    void this.pump();

    if (req.wait) return item.finished.promise;
    return isNext ? item.dispatched.promise : { id, status: "queued" };
  }

  /** Stop the current utterance and drop everything queued. */
  stop(): void {
    const dropped = [...this.queue.splice(0), ...(this.current ? [this.current] : [])];
    const hadCurrent = this.current !== null;
    this.current = null;
    for (const item of dropped) this.settle(item, { id: item.id, status: "interrupted" });
    if (hadCurrent) this.deps.broadcast({ type: "stop" });
  }

  /** Called when an avatar client reports that it finished an utterance. */
  speechEnded(id: string, interrupted: boolean, error?: string): void {
    const item = this.current;
    if (!item || item.id !== id) return;
    // One client that cannot play (say, a tab whose audio is blocked) must not
    // cut off another that is still speaking. Fail only when all of them fail.
    if (error && ++item.failures < item.audience) return;
    this.current = null;
    this.settle(item, error ? { id, status: "error", error } : { id, status: interrupted ? "interrupted" : "spoken" });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.current || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    this.current = item;
    let audio: RenderedAudio | null;
    try {
      audio = await item.audio;
    } catch (err) {
      if (this.current === item) this.current = null;
      this.settle(item, { id: item.id, status: "error", error: (err as Error).message });
      void this.pump();
      return;
    }
    if (this.current !== item) return; // stopped while rendering

    const utterance: Utterance = { id: item.id, text: item.text };
    if (item.mood) utterance.mood = item.mood;
    if (audio) utterance.audio = audio;
    this.deps.broadcast({ type: "speak", utterance });
    item.dispatched.resolve({ id: item.id, status: "queued" });

    // Safety net: ~2.5 words/second at normal speed, plus generous slack.
    const words = item.text.split(/\s+/).length;
    const rate = Math.max(0.25, this.deps.speechRate?.() ?? 1);
    item.audience = this.deps.clientCount();
    item.timer = setTimeout(() => this.speechEnded(item.id, false), (words / (2.5 * rate) + 15) * 1000);
  }

  private settle(item: Item, res: SayResponse): void {
    if (item.timer) clearTimeout(item.timer);
    item.abort.abort();
    item.dispatched.resolve(res);
    item.finished.resolve(res);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
