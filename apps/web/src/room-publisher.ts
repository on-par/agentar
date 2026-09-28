import type { RoomConnectionState } from "@agentar/core";

/** The SFU client's connection events this publisher reacts to. */
export type ConnectionEvent = "reconnecting" | "reconnected" | "disconnected";

/** The slice of a LiveKit Room this publisher uses, so tests can pass a fake SFU client. */
export interface RoomLike {
  name: string;
  localParticipant: {
    publishTrack(track: MediaStreamTrack, opts?: { name?: string; source?: "camera" | "microphone" }): Promise<unknown>;
  };
  disconnect(): Promise<void>;
  onConnectionChange(listener: (event: ConnectionEvent) => void): void;
}

export interface JoinResult {
  id: string;
  ok: boolean;
  room?: string;
  error?: string;
}

export interface RoomStateUpdate {
  state: RoomConnectionState;
  rejoining: boolean;
  room?: string;
  error?: string;
}

export interface PublisherDeps {
  canvas: { captureStream(fps?: number): MediaStream };
  speech: { captureAudio(): MediaStream };
  /** Connect to the room. Only called on join, so the SDK stays unloaded otherwise. */
  connect(url: string, token: string): Promise<RoomLike>;
  report(result: JoinResult): void;
  /** Called on every connection change after a successful join. Never carries the token. */
  state(update: RoomStateUpdate): void;
  /** Wait before each rejoin attempt after a drop. The session gives up after the last one. */
  rejoinDelaysMs?: number[];
}

/** About 30 s of retries; longer outages need a fresh join. */
const DEFAULT_REJOIN_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000];

/** Publishes the stage (canvas video plus speech audio) into one WebRTC room as a participant. */
export class RoomPublisher {
  private room: RoomLike | null = null;
  private video: MediaStreamTrack | null = null;
  /** The joined session, kept (in memory only) so a drop can rejoin with the same credentials. */
  private session: { url: string; token: string; room?: string } | null = null;
  private joining = false;
  /** Bumped by leave() so a join or rejoin still connecting knows to back out. */
  private generation = 0;
  /** Ends a pending rejoin delay early, so leave() does not wait on it. */
  private wake: (() => void) | undefined;

  constructor(private readonly deps: PublisherDeps) {}

  /** True from a successful join until leave or give-up, including while rejoining after a drop. */
  get joined(): boolean {
    return this.session !== null;
  }

  async join(id: string, url: string, token: string): Promise<void> {
    const { report } = this.deps;
    if (this.joining || this.session) {
      report({ id, ok: false, error: "Already in a room in this tab" });
      return;
    }
    this.joining = true;
    const generation = this.generation;
    let joined: { room: RoomLike; video: MediaStreamTrack } | undefined;
    try {
      joined = await this.connectAndPublish(url, token);
      if (generation !== this.generation) throw new Error("Left the room before the join finished");
      this.room = joined.room;
      this.video = joined.video;
      this.session = { url, token, room: joined.room.name };
      this.watch(joined.room);
      report({ id, ok: true, room: joined.room.name });
    } catch (err) {
      joined?.video.stop();
      await joined?.room.disconnect().catch(() => undefined);
      // SDK errors describe the failure (such as an invalid token) without echoing the token itself.
      report({ id, ok: false, error: (err as Error)?.message || "Could not join the room" });
    } finally {
      this.joining = false;
    }
  }

  /**
   * Disconnect from the room and stop the canvas track. The speech capture is
   * left alone: it is shared with the recorder and harmless while connected.
   * Cancels any rejoin in progress.
   */
  async leave(): Promise<void> {
    this.generation++;
    this.session = null;
    this.wake?.();
    const room = this.room;
    const video = this.video;
    this.room = null;
    this.video = null;
    video?.stop();
    await room?.disconnect();
  }

  /** Capture a fresh canvas track, connect and publish it with the shared speech track. Cleans up on failure. */
  private async connectAndPublish(url: string, token: string): Promise<{ room: RoomLike; video: MediaStreamTrack }> {
    const { canvas, speech, connect } = this.deps;
    let video: MediaStreamTrack | undefined;
    let room: RoomLike | null = null;
    try {
      video = canvas.captureStream(30).getVideoTracks()[0];
      const audio = speech.captureAudio().getAudioTracks()[0];
      if (!video || !audio) throw new Error("The stage has no video or audio track to publish");
      room = await connect(url, token);
      await room.localParticipant.publishTrack(video, { name: "avatar", source: "camera" });
      await room.localParticipant.publishTrack(audio, { name: "speech", source: "microphone" });
      return { room, video };
    } catch (err) {
      video?.stop();
      await room?.disconnect().catch(() => undefined);
      throw err;
    }
  }

  /**
   * React to the SFU client's connection events. leave() clears this.room before
   * disconnecting, so its own Disconnected event lands on the stale-room guard.
   */
  private watch(room: RoomLike): void {
    room.onConnectionChange((event) => {
      if (room !== this.room) return;
      if (event === "reconnecting") {
        this.deps.state({ state: "disconnected", rejoining: true, room: room.name });
        return;
      }
      if (event === "reconnected" && this.video?.readyState !== "ended") {
        this.deps.state({ state: "connected", rejoining: false, room: room.name });
        return;
      }
      // The room is gone, or it resumed without a live canvas track (remote viewers would
      // see a frozen frame): rejoin from scratch with a fresh capture.
      this.room = null;
      this.video?.stop();
      this.video = null;
      if (event === "reconnected") void room.disconnect().catch(() => undefined);
      this.deps.state({ state: "disconnected", rejoining: true, room: room.name });
      void this.rejoin(this.generation);
    });
  }

  private async rejoin(generation: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    for (const delay of this.deps.rejoinDelaysMs ?? DEFAULT_REJOIN_DELAYS_MS) {
      await this.sleep(delay);
      if (generation !== this.generation) return;
      let joined: { room: RoomLike; video: MediaStreamTrack };
      try {
        joined = await this.connectAndPublish(session.url, session.token);
      } catch {
        continue;
      }
      if (generation !== this.generation) {
        // leave() ran while connecting: do not leave a ghost participant behind.
        joined.video.stop();
        await joined.room.disconnect().catch(() => undefined);
        return;
      }
      this.room = joined.room;
      this.video = joined.video;
      session.room = joined.room.name;
      this.watch(joined.room);
      this.deps.state({ state: "connected", rejoining: false, room: joined.room.name });
      return;
    }
    if (generation !== this.generation) return;
    this.session = null;
    this.deps.state({ state: "disconnected", rejoining: false, room: session.room, error: "Could not rejoin the room after a network drop" });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
