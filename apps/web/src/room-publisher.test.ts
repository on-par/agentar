import { describe, expect, it, vi } from "vitest";
import { RoomPublisher, type ConnectionEvent, type JoinResult, type RoomLike, type RoomStateUpdate } from "./room-publisher.js";

class FakeTrack {
  stopped = false;
  readyState: "live" | "ended" = "live";
  constructor(readonly kind: "video" | "audio") {}
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

/** A stand-in for the SFU client: records publishes and disconnects. */
class FakeRoom implements RoomLike {
  name = "test-room";
  published: Array<{ track: FakeTrack; opts?: { name?: string; source?: string } }> = [];
  disconnected = false;
  failPublish = false;
  localParticipant = {
    publishTrack: async (track: MediaStreamTrack, opts?: { name?: string; source?: "camera" | "microphone" }) => {
      if (this.failPublish) throw new Error("publish failed");
      this.published.push({ track: track as unknown as FakeTrack, opts });
    },
  };
  listeners: Array<(event: ConnectionEvent) => void> = [];
  onConnectionChange(listener: (event: ConnectionEvent) => void) {
    this.listeners.push(listener);
  }
  /** Simulate an SFU connection event. */
  emit(event: ConnectionEvent) {
    for (const l of this.listeners) l(event);
  }
  // Like the real SDK's Disconnected event, but the publisher has already let go of the room by then.
  async disconnect() {
    this.disconnected = true;
  }
}

function setup(connect?: (url: string, token: string) => Promise<RoomLike>) {
  const video = new FakeTrack("video");
  const audio = new FakeTrack("audio");
  const room = new FakeRoom();
  const releaseCapture = vi.fn();
  const reports: JoinResult[] = [];
  const states: RoomStateUpdate[] = [];
  /** Every canvas video track captured, in order; the first is `video`. */
  const videos: FakeTrack[] = [];
  const connectFn = vi.fn(connect ?? (async () => room));
  const publisher = new RoomPublisher({
    canvas: {
      captureStream: () => {
        const track = videos.length ? new FakeTrack("video") : video;
        videos.push(track);
        return new FakeMediaStream([track]) as unknown as MediaStream;
      },
    },
    speech: { captureAudio: () => new FakeMediaStream([audio]) as unknown as MediaStream, releaseCapture } as {
      captureAudio(): MediaStream;
    },
    connect: connectFn,
    report: (r) => reports.push(r),
    state: (s) => states.push(s),
    rejoinDelaysMs: [0, 0, 0],
  });
  return { publisher, room, video, videos, audio, reports, states, connect: connectFn, releaseCapture };
}

/** Let pending timers and promise chains (a rejoin loop) run. */
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("RoomPublisher join/leave", () => {
  it("join publishes the canvas video and speech audio and reports the room", async () => {
    const { publisher, room, video, audio, reports, connect } = setup();
    await publisher.join("j1", "wss://sfu.example", "tok");
    expect(connect).toHaveBeenCalledWith("wss://sfu.example", "tok");
    expect(room.published).toEqual([
      { track: video, opts: { name: "avatar", source: "camera" } },
      { track: audio, opts: { name: "speech", source: "microphone" } },
    ]);
    expect(reports).toEqual([{ id: "j1", ok: true, room: "test-room" }]);
    expect(publisher.joined).toBe(true);
  });

  it("join reports an error, publishes nothing and stays out when the token is rejected", async () => {
    const token = "super-secret-token";
    const { publisher, video, reports } = setup(async () => {
      throw new Error("invalid token");
    });
    await publisher.join("j1", "wss://sfu.example", token);
    expect(reports).toEqual([{ id: "j1", ok: false, error: "invalid token" }]);
    expect(reports[0]!.error).not.toContain(token);
    expect(publisher.joined).toBe(false);
    expect(video.stopped).toBe(true);
  });

  it("join disconnects and reports an error when publishing fails", async () => {
    const { publisher, room, reports } = setup();
    room.failPublish = true;
    await publisher.join("j1", "wss://sfu.example", "tok");
    expect(room.disconnected).toBe(true);
    expect(reports).toEqual([{ id: "j1", ok: false, error: "publish failed" }]);
    expect(publisher.joined).toBe(false);
  });

  it("a second join while joined reports already in a room", async () => {
    const { publisher, reports, connect } = setup();
    await publisher.join("j1", "wss://sfu.example", "tok");
    await publisher.join("j2", "wss://sfu.example", "tok");
    expect(reports[1]).toEqual({ id: "j2", ok: false, error: "Already in a room in this tab" });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("leave disconnects, stops the canvas track and keeps the shared speech capture", async () => {
    const { publisher, room, video, audio, releaseCapture } = setup();
    await publisher.join("j1", "wss://sfu.example", "tok");
    await publisher.leave();
    expect(room.disconnected).toBe(true);
    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(false);
    expect(releaseCapture).not.toHaveBeenCalled();
    expect(publisher.joined).toBe(false);
  });

  it("leave when not joined is a no-op", async () => {
    const { publisher } = setup();
    await expect(publisher.leave()).resolves.toBeUndefined();
    expect(publisher.joined).toBe(false);
  });

  it("leave during a join backs out of the room once it connects", async () => {
    let finishConnect!: () => void;
    const room = new FakeRoom();
    const { publisher, reports } = setup(() => new Promise((resolve) => (finishConnect = () => resolve(room))));
    const joining = publisher.join("j1", "wss://sfu.example", "tok");
    await publisher.leave();
    finishConnect();
    await joining;
    expect(room.disconnected).toBe(true);
    expect(publisher.joined).toBe(false);
    expect(reports).toEqual([{ id: "j1", ok: false, error: "Left the room before the join finished" }]);
  });
});

describe("reconnect", () => {
  const url = "wss://sfu.example";
  const token = "super-secret-token";

  /** A connect that hands out the given rooms in order, then fails. */
  function rooms(...list: FakeRoom[]) {
    return async () => {
      const next = list.shift();
      if (!next) throw new Error("connection refused");
      return next;
    };
  }

  it("reports a resume as disconnected then connected, without reconnecting", async () => {
    const { publisher, room, states, connect } = setup();
    await publisher.join("j1", url, token);
    room.emit("reconnecting");
    expect(states).toEqual([{ state: "disconnected", rejoining: true, room: "test-room" }]);
    room.emit("reconnected");
    expect(states[1]).toEqual({ state: "connected", rejoining: false, room: "test-room" });
    expect(connect).toHaveBeenCalledOnce();
    expect(publisher.joined).toBe(true);
  });

  it("rejoins with the same credentials and a fresh live canvas track after an unexpected disconnect", async () => {
    const first = new FakeRoom();
    const second = new FakeRoom();
    const { publisher, video, videos, audio, states, connect } = setup(rooms(first, second));
    await publisher.join("j1", url, token);
    first.emit("disconnected");
    expect(video.stopped).toBe(true);
    expect(publisher.joined).toBe(true);
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith(url, token);
    const fresh = videos[1]!;
    expect(fresh).not.toBe(video);
    expect(fresh.readyState).toBe("live");
    expect(second.published).toEqual([
      { track: fresh, opts: { name: "avatar", source: "camera" } },
      { track: audio, opts: { name: "speech", source: "microphone" } },
    ]);
    expect(states).toEqual([
      { state: "disconnected", rejoining: true, room: "test-room" },
      { state: "connected", rejoining: false, room: "test-room" },
    ]);
    expect(publisher.joined).toBe(true);
    expect(audio.stopped).toBe(false);
  });

  it("gives up after every rejoin attempt fails and reports why, without the token", async () => {
    const first = new FakeRoom();
    const { publisher, states, connect, videos } = setup(rooms(first));
    await publisher.join("j1", url, token);
    first.emit("disconnected");
    expect(publisher.joined).toBe(true);
    await flush();
    expect(connect).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toEqual({ state: "disconnected", rejoining: false, room: "test-room", error: expect.any(String) });
    expect(JSON.stringify(states)).not.toContain(token);
    expect(publisher.joined).toBe(false);
    expect(videos.every((v) => v.stopped)).toBe(true);
  });

  it("leave during a rejoin cancels it and backs out of a room that connects late", async () => {
    const first = new FakeRoom();
    const late = new FakeRoom();
    let finishConnect!: () => void;
    let calls = 0;
    const { publisher, states, videos } = setup(async () => {
      if (calls++ === 0) return first;
      return new Promise<RoomLike>((resolve) => (finishConnect = () => resolve(late)));
    });
    await publisher.join("j1", url, token);
    first.emit("disconnected");
    await flush();
    await publisher.leave();
    finishConnect();
    await flush();
    expect(late.disconnected).toBe(true);
    expect(videos[1]!.stopped).toBe(true);
    expect(states.some((s) => s.state === "connected")).toBe(false);
    expect(states).toHaveLength(1);
    expect(publisher.joined).toBe(false);
  });

  it("leave during a rejoin delay stops further attempts", async () => {
    const first = new FakeRoom();
    const connect = vi.fn(rooms(first));
    const publisher = new RoomPublisher({
      canvas: { captureStream: () => new FakeMediaStream([new FakeTrack("video")]) as unknown as MediaStream },
      speech: { captureAudio: () => new FakeMediaStream([new FakeTrack("audio")]) as unknown as MediaStream },
      connect,
      report: () => undefined,
      state: () => undefined,
      rejoinDelaysMs: [60_000],
    });
    await publisher.join("j1", url, token);
    first.emit("disconnected");
    await publisher.leave();
    await flush();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("fully rejoins when a resume comes back with an ended canvas track", async () => {
    const first = new FakeRoom();
    const second = new FakeRoom();
    const { publisher, video, videos, states, connect } = setup(rooms(first, second));
    await publisher.join("j1", url, token);
    first.emit("reconnecting");
    video.readyState = "ended";
    first.emit("reconnected");
    expect(first.disconnected).toBe(true);
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.published[0]!.track).toBe(videos[1]);
    expect(videos[1]!.readyState).toBe("live");
    expect(states.at(-1)).toEqual({ state: "connected", rejoining: false, room: "test-room" });
  });

  it("ignores events from a room it already left", async () => {
    const { publisher, room, states, connect } = setup();
    await publisher.join("j1", url, token);
    await publisher.leave();
    room.emit("disconnected");
    room.emit("reconnected");
    await flush();
    expect(states).toEqual([]);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("refuses a new join while a rejoin is in progress", async () => {
    const first = new FakeRoom();
    const { publisher, reports } = setup(async () => {
      if (first.listeners.length === 0) return first;
      return new Promise<RoomLike>(() => undefined);
    });
    await publisher.join("j1", url, token);
    first.emit("disconnected");
    await flush();
    await publisher.join("j2", url, token);
    expect(reports[1]).toEqual({ id: "j2", ok: false, error: "Already in a room in this tab" });
    await publisher.leave();
  });
});
