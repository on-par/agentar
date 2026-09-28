const CANDIDATE_MIME_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

/** Pick the best MediaRecorder mime type this browser supports, or "" if none. */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  return CANDIDATE_MIME_TYPES.find((t) => isSupported(t)) ?? "";
}

export interface RecorderDeps {
  canvas: { captureStream(fps?: number): MediaStream };
  speech: { captureAudio(): MediaStream; releaseCapture(): void };
  MediaRecorder: typeof MediaRecorder;
  upload(id: string, chunk: Blob, final: boolean): Promise<void>;
  reportError(id: string, error: string): void;
}

/** Records the stage (canvas video plus speech audio) and streams chunks to the bridge in order. */
export class StageRecorder {
  private id: string | null = null;
  private recorder: MediaRecorder | null = null;
  private mime = "";
  private uploads: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RecorderDeps) {}

  start(id: string): void {
    if (this.id) {
      this.deps.reportError(id, "A recording is already running in this tab");
      return;
    }
    try {
      const { canvas, speech, MediaRecorder: MR, upload, reportError } = this.deps;
      const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...speech.captureAudio().getAudioTracks()]);
      this.mime = pickMimeType((t) => MR.isTypeSupported(t));
      const recorder = new MR(stream, this.mime ? { mimeType: this.mime } : undefined);
      this.id = id;
      this.recorder = recorder;
      this.uploads = Promise.resolve();
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        this.uploads = this.uploads.then(() => upload(id, e.data, false));
      };
      recorder.onerror = (e) => reportError(id, e.message || e.error?.message || "MediaRecorder error");
      recorder.start(1000);
    } catch (err) {
      this.id = null;
      this.recorder = null;
      this.deps.reportError(id, (err as Error).message);
    }
  }

  async stop(id: string): Promise<void> {
    if (this.id !== id || !this.recorder) return;
    const recorder = this.recorder;
    this.id = null;
    this.recorder = null;
    try {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
      this.uploads = this.uploads.then(() => this.deps.upload(id, new Blob([], { type: this.mime }), true));
      await this.uploads;
    } catch (err) {
      this.deps.reportError(id, (err as Error).message);
    } finally {
      for (const track of recorder.stream.getVideoTracks()) track.stop();
      this.deps.speech.releaseCapture();
    }
  }
}
