/** The slice of a LiveKit Room this publisher uses, so tests can pass a fake SFU client. */
export interface RoomLike {
  name: string;
  localParticipant: {
    publishTrack(track: MediaStreamTrack, opts?: { name?: string; source?: "camera" | "microphone" }): Promise<unknown>;
  };
  disconnect(): Promise<void>;
}

export interface JoinResult {
  id: string;
  ok: boolean;
  room?: string;
  error?: string;
}

export interface PublisherDeps {
  canvas: { captureStream(fps?: number): MediaStream };
  speech: { captureAudio(): MediaStream };
  /** Connect to the room. Only called on join, so the SDK stays unloaded otherwise. */
  connect(url: string, token: string): Promise<RoomLike>;
  report(result: JoinResult): void;
}

/** Publishes the stage (canvas video plus speech audio) into one WebRTC room as a participant. */
export class RoomPublisher {
  private room: RoomLike | null = null;
  private video: MediaStreamTrack | null = null;
  private joining = false;
  /** Bumped by leave() so a join still connecting knows to back out. */
  private generation = 0;

  constructor(private readonly deps: PublisherDeps) {}

  get joined(): boolean {
    return this.room !== null;
  }

  async join(id: string, url: string, token: string): Promise<void> {
    const { canvas, speech, connect, report } = this.deps;
    if (this.joining || this.room) {
      report({ id, ok: false, error: "Already in a room in this tab" });
      return;
    }
    this.joining = true;
    const generation = this.generation;
    let video: MediaStreamTrack | undefined;
    let room: RoomLike | null = null;
    try {
      video = canvas.captureStream(30).getVideoTracks()[0];
      const audio = speech.captureAudio().getAudioTracks()[0];
      if (!video || !audio) throw new Error("The stage has no video or audio track to publish");
      room = await connect(url, token);
      await room.localParticipant.publishTrack(video, { name: "avatar", source: "camera" });
      await room.localParticipant.publishTrack(audio, { name: "speech", source: "microphone" });
      if (generation !== this.generation) throw new Error("Left the room before the join finished");
      this.room = room;
      this.video = video;
      report({ id, ok: true, room: room.name });
    } catch (err) {
      video?.stop();
      await room?.disconnect().catch(() => undefined);
      // SDK errors describe the failure (such as an invalid token) without echoing the token itself.
      report({ id, ok: false, error: (err as Error)?.message || "Could not join the room" });
    } finally {
      this.joining = false;
    }
  }

  /**
   * Disconnect from the room and stop the canvas track. The speech capture is
   * left alone: it is shared with the recorder and harmless while connected.
   */
  async leave(): Promise<void> {
    this.generation++;
    const room = this.room;
    const video = this.video;
    this.room = null;
    this.video = null;
    video?.stop();
    await room?.disconnect();
  }
}
