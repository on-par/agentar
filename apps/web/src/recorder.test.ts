import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickMimeType, StageRecorder, type RecorderDeps } from "./recorder.js";

class FakeVideoTrack {
  kind = "video";
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeAudioTrack {
  kind = "audio";
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: Array<FakeVideoTrack | FakeAudioTrack> = []) {}
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}

class FakeMediaRecorder {
  static supported = new Set(["video/webm;codecs=vp9,opus"]);
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.has(type);
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: { message?: string; error?: Error }) => void) | null = null;
  private stopListeners: Array<() => void> = [];
  constructor(
    public stream: FakeMediaStream,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? "";
  }
  start(_timeslice?: number) {
    this.state = "recording";
  }
  addEventListener(type: string, listener: () => void) {
    if (type === "stop") this.stopListeners.push(listener);
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["final-data"]) });
    for (const l of this.stopListeners) l();
  }
  fireData(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
}

beforeEach(() => {
  vi.stubGlobal("MediaStream", FakeMediaStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickMimeType", () => {
  it("returns the first supported type", () => {
    expect(pickMimeType((t) => t === "video/webm")).toBe("video/webm");
  });

  it("returns an empty string when nothing is supported", () => {
    expect(pickMimeType(() => false)).toBe("");
  });
});

describe("StageRecorder", () => {
  function setup() {
    const canvasTrack = new FakeVideoTrack();
    const audioTrack = new FakeAudioTrack();
    const canvas = { captureStream: vi.fn(() => new FakeMediaStream([canvasTrack])) };
    const releaseCapture = vi.fn();
    const speech = { captureAudio: vi.fn(() => new FakeMediaStream([audioTrack])), releaseCapture };
    const uploads: Array<{ id: string; text: string; final: boolean }> = [];
    let recorderInstance: FakeMediaRecorder | undefined;
    const MR = vi.fn(function (this: unknown, stream: FakeMediaStream, opts?: { mimeType?: string }) {
      recorderInstance = new FakeMediaRecorder(stream, opts);
      return recorderInstance;
    }) as unknown as typeof MediaRecorder & { isTypeSupported: (t: string) => boolean };
    MR.isTypeSupported = FakeMediaRecorder.isTypeSupported;
    const upload = vi.fn(async (id: string, chunk: Blob, final: boolean) => {
      uploads.push({ id, text: await chunk.text(), final });
    });
    const reportError = vi.fn();
    const deps: RecorderDeps = {
      canvas: canvas as unknown as RecorderDeps["canvas"],
      speech: speech as unknown as RecorderDeps["speech"],
      MediaRecorder: MR,
      upload,
      reportError,
    };
    const recorder = new StageRecorder(deps);
    return { recorder, canvasTrack, audioTrack, releaseCapture, uploads, upload, reportError, getRecorder: () => recorderInstance! };
  }

  it("uploads chunks in order and marks the last upload final", async () => {
    const { recorder, uploads, getRecorder } = setup();
    recorder.start("rec-1");
    const mr = getRecorder();
    mr.fireData("chunk-1");
    mr.fireData("chunk-2");
    await recorder.stop("rec-1");

    expect(uploads.map((u) => u.text)).toEqual(["chunk-1", "chunk-2", "final-data", ""]);
    expect(uploads.map((u) => u.final)).toEqual([false, false, false, true]);
    expect(uploads.every((u) => u.id === "rec-1")).toBe(true);
  });

  it("picks the first supported mime type", () => {
    const { recorder, getRecorder } = setup();
    recorder.start("rec-1");
    expect(getRecorder().mimeType).toBe("video/webm;codecs=vp9,opus");
  });

  it("releases the speech capture and stops the video track on stop", async () => {
    const { recorder, canvasTrack, audioTrack, releaseCapture } = setup();
    recorder.start("rec-1");
    await recorder.stop("rec-1");

    expect(canvasTrack.stopped).toBe(true);
    expect(audioTrack.stopped).toBe(false);
    expect(releaseCapture).toHaveBeenCalledOnce();
  });

  it("reports an error instead of starting a second overlapping recording", () => {
    const { recorder, reportError } = setup();
    recorder.start("rec-1");
    recorder.start("rec-2");
    expect(reportError).toHaveBeenCalledWith("rec-2", expect.stringMatching(/already running/));
  });

  it("ignores stop for an id that does not match the active recording", async () => {
    const { recorder, uploads } = setup();
    recorder.start("rec-1");
    await recorder.stop("some-other-id");
    expect(uploads).toEqual([]);
  });
});
