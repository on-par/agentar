import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingManager } from "./recording.js";

let dir: string;
let manager: RecordingManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentar-recording-test-"));
  manager = new RecordingManager(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RecordingManager", () => {
  it("appends chunks in order and resolves stop with the file path, mime, and byte count", async () => {
    const { id } = manager.start("client-1");
    await manager.appendChunk(id, Buffer.from("hello "), "video/webm", false);
    await manager.appendChunk(id, Buffer.from("world"), "video/webm", false);
    const stopped = manager.stop();
    await manager.appendChunk(id, Buffer.from("!"), "video/webm", true);
    const result = await stopped;

    expect(result).toMatchObject({ id, mime: "video/webm", bytes: 12 });
    expect(result.path.endsWith(".webm")).toBe(true);
    expect(await readFile(result.path, "utf8")).toBe("hello world!");
  });

  it("picks .mp4 for an mp4 mime type", async () => {
    const { id } = manager.start("client-1");
    const stopped = manager.stop();
    await manager.appendChunk(id, Buffer.from("data"), "video/mp4", true);
    const result = await stopped;
    expect(result.path.endsWith(".mp4")).toBe(true);
  });

  it("rejects a second stop after completion, and the file is unchanged", async () => {
    const { id } = manager.start("client-1");
    const stopped = manager.stop();
    await manager.appendChunk(id, Buffer.from("more"), "video/webm", true);
    const result = await stopped;
    const before = await stat(result.path);

    await expect(manager.stop()).rejects.toMatchObject({ status: 409 });
    const after = await stat(result.path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses a second start while a recording is active", () => {
    manager.start("client-1");
    expect(() => manager.start("client-2")).toThrow(/already in progress/);
  });

  it("rejects appendChunk with an unknown or finished id", async () => {
    manager.start("client-1");
    await expect(manager.appendChunk("bogus", Buffer.from("x"), "video/webm", false)).rejects.toMatchObject({ status: 409 });
  });

  it("times out stop() when no final chunk arrives, resets state, and allows a fresh start", async () => {
    const { id } = manager.start("client-1");
    await manager.appendChunk(id, Buffer.from("partial"), "video/webm", false);
    await expect(manager.stop(20)).rejects.toMatchObject({ status: 504 });

    // State reset: a fresh start works.
    const { id: id2 } = manager.start("client-2");
    expect(id2).not.toBe(id);
    const stopped = manager.stop();
    await manager.appendChunk(id2, Buffer.from("ok"), "video/webm", true);
    await expect(stopped).resolves.toMatchObject({ id: id2, bytes: 2 });
  });

  it("rejects stop with 502 when fail() is called while stopping", async () => {
    const { id } = manager.start("client-1");
    await manager.appendChunk(id, Buffer.from("partial"), "video/webm", false);
    const stopped = manager.stop();
    manager.fail(id, "the page disconnected");
    await expect(stopped).rejects.toMatchObject({ status: 502 });
  });

  it("returns 409 when stopping with no active recording", async () => {
    await expect(manager.stop()).rejects.toMatchObject({ status: 409 });
  });
});
