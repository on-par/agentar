import { randomUUID } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { RecordStopResponse } from "@agentar/core";

interface State {
  id: string;
  clientId: string;
  phase: "recording" | "stopping";
  file?: string;
  mime?: string;
  bytes: number;
  handle?: FileHandle;
  writing: Promise<void>;
  finished: { promise: Promise<RecordStopResponse>; resolve: (r: RecordStopResponse) => void; reject: (err: unknown) => void };
}

function httpError(status: number, message: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { status, ...extra });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (err: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Owns exactly one in-progress recording at a time: appends browser-uploaded
 * MediaRecorder chunks to a single file under `dir` and never reopens or
 * rewrites a finished file.
 */
export class RecordingManager {
  private state: State | null = null;

  constructor(private readonly dir: string) {}

  get active(): { id: string; clientId: string } | null {
    return this.state ? { id: this.state.id, clientId: this.state.clientId } : null;
  }

  start(clientId: string): { id: string } {
    if (this.state) throw httpError(409, "A recording is already in progress");
    const id = randomUUID();
    this.state = { id, clientId, phase: "recording", bytes: 0, writing: Promise.resolve(), finished: deferred<RecordStopResponse>() };
    return { id };
  }

  async appendChunk(id: string, data: Buffer, mime: string, final: boolean): Promise<void> {
    const state = this.state;
    if (!state || state.id !== id) throw httpError(409, "Unknown or finished recording");

    if (!state.file && data.length) {
      await mkdir(this.dir, { recursive: true });
      const ext = /mp4/.test(mime) ? ".mp4" : ".webm";
      state.file = join(this.dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}${ext}`);
      state.mime = mime;
      state.handle = await open(state.file, "a");
    }

    if (data.length) {
      const handle = state.handle!;
      state.writing = state.writing.then(async () => {
        await handle.appendFile(data);
        state.bytes += data.length;
      });
      await state.writing;
    }

    if (final) {
      await state.writing;
      if (!state.file) {
        state.finished.reject(httpError(502, "The page recorded nothing"));
      } else {
        await state.handle!.close();
        state.finished.resolve({ id: state.id, path: state.file, mime: state.mime!, bytes: state.bytes });
      }
      if (this.state === state) this.state = null;
    }
  }

  async stop(timeoutMs = 10_000): Promise<RecordStopResponse> {
    const state = this.state;
    if (!state || state.phase !== "recording") throw httpError(409, "No recording in progress");
    state.phase = "stopping";

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const suffix = state.file ? ` (partial file at ${state.file})` : "";
        reject(httpError(504, `Recording timed out before the final chunk arrived${suffix}`, { path: state.file }));
      }, timeoutMs);
    });

    try {
      return await Promise.race([state.finished.promise, timeout]);
    } catch (err) {
      if (this.state === state) {
        await state.handle?.close().catch(() => undefined);
        this.state = null;
      }
      throw err;
    } finally {
      clearTimeout(timer!);
    }
  }

  fail(id: string, error: string): void {
    const state = this.state;
    if (!state || state.id !== id) return;
    void state.handle?.close().catch(() => undefined);
    if (state.phase === "stopping") {
      state.finished.reject(httpError(502, error, { path: state.file }));
    }
    if (this.state === state) this.state = null;
  }

  /** Used by bridge.close(): closes the handle quietly, without resolving finished. */
  abort(): void {
    const state = this.state;
    if (!state) return;
    void state.handle?.close().catch(() => undefined);
    this.state = null;
  }
}
