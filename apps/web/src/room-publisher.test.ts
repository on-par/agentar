import { describe, expect, it, vi } from "vitest";
import { RoomPublisher, type JoinResult, type RoomLike } from "./room-publisher.js";

class FakeTrack {
  stopped = false;
  constructor(readonly kind: "video" | "audio") {}
  stop() {
    this.stopped = true;
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
  const connectFn = vi.fn(connect ?? (async () => room));
  const publisher = new RoomPublisher({
    canvas: { captureStream: () => new FakeMediaStream([video]) as unknown as MediaStream },
    speech: { captureAudio: () => new FakeMediaStream([audio]) as unknown as MediaStream, releaseCapture } as {
      captureAudio(): MediaStream;
    },
    connect: connectFn,
    report: (r) => reports.push(r),
  });
  return { publisher, room, video, audio, reports, connect: connectFn, releaseCapture };
}

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
