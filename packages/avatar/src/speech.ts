import {
  buildTimelineFromText,
  computeEnvelope,
  envelopeAt,
  findVoicedSegments,
  sampleTimeline,
  visemesFromSpectrum,
  type AudioEnvelope,
  type LipSyncTimeline,
  type Utterance,
  type VisemeWeights,
  type VoiceSettings,
} from "@agentar/core";

/** What the face needs to know about speech on a given frame. */
export interface SpeechFrame {
  speaking: boolean;
  visemes: VisemeWeights;
  /** Loudness 0..1, drives head motion and brow emphasis. */
  energy: number;
}

export interface PlayResult {
  interrupted: boolean;
}

type Playback =
  | {
      kind: "audio";
      source: AudioBufferSourceNode;
      startAt: number;
      timeline: LipSyncTimeline;
      envelope: AudioEnvelope;
      analyser: AnalyserNode;
      useSpectrum: boolean;
      done: Promise<PlayResult>;
      finish: (r: PlayResult) => void;
    }
  | {
      kind: "browser";
      timeline: LipSyncTimeline;
      /** performance.now() (ms) at which timeline t=0 is aligned. */
      clockStart: number;
      wordOffsets: number[];
      done: Promise<PlayResult>;
      finish: (r: PlayResult) => void;
    };

const SILENT: SpeechFrame = { speaking: false, visemes: {}, energy: 0 };

/**
 * Plays an utterance and exposes per-frame lip-sync data.
 *
 * Two paths:
 *  - Audio (system/Edge/OpenAI/ElevenLabs/xAI voices rendered by the bridge): decode
 *    the clip, find where it is actually voiced, and lay the text's visemes
 *    over those voiced regions. The loudness envelope then modulates the
 *    mouth so emphasis and pauses look right. If the text is empty, fall
 *    back to live spectrum analysis.
 *  - Browser (Web Speech API): no access to the audio, so the timeline is
 *    driven by the clock and re-aligned on every word-boundary event.
 */
export class SpeechPlayer {
  private playback: Playback | null = null;
  /** Bumped by stop(), so a clip that is still loading knows it was cancelled. */
  private generation = 0;
  private ctx: AudioContext | null = null;
  private spectrum: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private capture: MediaStreamAudioDestinationNode | null = null;

  /** Must be called from a user gesture at least once to unlock audio. */
  async unlock(): Promise<void> {
    const ctx = this.audioContext();
    if (ctx.state !== "running") await ctx.resume();
  }

  get audioReady(): boolean {
    return this.ctx?.state === "running";
  }

  audioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  get speaking(): boolean {
    return this.playback !== null;
  }

  /** Tap playback audio for recording. The track stays live (and silent between utterances). */
  captureAudio(): MediaStream {
    if (!this.capture) this.capture = this.audioContext().createMediaStreamDestination();
    return this.capture.stream;
  }

  releaseCapture(): void {
    this.capture?.disconnect();
    this.capture = null;
  }

  async play(utt: Utterance, voice: VoiceSettings): Promise<PlayResult> {
    this.stop();
    if (utt.audio) return this.playAudio(utt, voice, this.generation);
    return this.playBrowser(utt, voice);
  }

  stop(): void {
    this.generation++;
    const p = this.playback;
    if (!p) return;
    this.playback = null;
    if (p.kind === "audio") {
      try {
        p.source.stop();
      } catch {
        /* already stopped */
      }
    } else if (typeof speechSynthesis !== "undefined") {
      speechSynthesis.cancel();
    }
    p.finish({ interrupted: true });
  }

  /** Sample the current lip-sync state. Call once per rendered frame. */
  frame(): SpeechFrame {
    const p = this.playback;
    if (!p) return SILENT;

    if (p.kind === "audio") {
      const ctx = this.audioContext();
      // Account for output latency so lips match what the user hears. While
      // recording, lips follow the recorded (not the heard) audio instead.
      const latency = this.capture ? 0 : (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      const t = ctx.currentTime - p.startAt - latency;
      if (t < 0) return { speaking: true, visemes: {}, energy: 0 };
      const energy = envelopeAt(p.envelope, t);
      let visemes: VisemeWeights;
      if (p.useSpectrum) {
        if (this.spectrum.length !== p.analyser.frequencyBinCount) {
          this.spectrum = new Uint8Array(new ArrayBuffer(p.analyser.frequencyBinCount));
        }
        p.analyser.getByteFrequencyData(this.spectrum);
        visemes = visemesFromSpectrum(this.spectrum, ctx.sampleRate);
      } else {
        // Loudness shapes the articulation: quiet syllables barely open the
        // mouth, stressed ones open fully, and silence closes it even if a
        // viseme was stretched across a pause.
        const gate = smoothstep(0.02, 0.12, energy);
        const gain = gate * (0.45 + 0.75 * Math.min(1, energy * 1.3));
        visemes = sampleTimeline(p.timeline, t, { gain });
      }
      return { speaking: true, visemes, energy };
    }

    const t = (performance.now() - p.clockStart) / 1000;
    const visemes = sampleTimeline(p.timeline, t, { gain: 0.95 });
    // Synthesised energy: syllable-rate pulse while a word is active.
    const active = Object.values(visemes).reduce((a, b) => Math.max(a, b ?? 0), 0);
    return { speaking: true, visemes, energy: active * 0.8 };
  }

  private async playAudio(utt: Utterance, voice: VoiceSettings, generation: number): Promise<PlayResult> {
    const cancelled = () => generation !== this.generation;
    const ctx = this.audioContext();
    if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    const res = await fetch(utt.audio!.url);
    if (!res.ok) throw new Error(`Could not fetch speech audio (${res.status})`);
    const data = await res.arrayBuffer();
    if (cancelled()) return { interrupted: true };
    const buffer = await ctx.decodeAudioData(data);
    if (cancelled()) return { interrupted: true };

    const mono = mixToMono(buffer);
    const envelope = computeEnvelope(mono, buffer.sampleRate);
    const voicedSegments = findVoicedSegments(envelope);
    const timeline = buildTimelineFromText(utt.text, { voicedSegments, duration: buffer.duration });

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = voice.volume;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
    if (this.capture) gain.connect(this.capture);

    let finish!: (r: PlayResult) => void;
    const done = new Promise<PlayResult>((resolve) => (finish = resolve));
    const startAt = ctx.currentTime + 0.05;
    const playback: Playback = {
      kind: "audio",
      source,
      startAt,
      timeline,
      envelope,
      analyser,
      useSpectrum: timeline.keys.length === 0,
      done,
      finish,
    };
    source.onended = () => {
      if (this.playback === playback) {
        this.playback = null;
        finish({ interrupted: false });
      }
    };
    this.playback = playback;
    source.start(startAt);
    return done;
  }

  private playBrowser(utt: Utterance, voice: VoiceSettings): Promise<PlayResult> {
    if (typeof speechSynthesis === "undefined") {
      return Promise.reject(new Error("This browser has no Web Speech API; choose another voice provider."));
    }
    const timeline = buildTimelineFromText(utt.text, { rate: voice.rate * 1.05 });
    const wordOffsets = [...utt.text.matchAll(/[\p{L}\p{N}']+/gu)].map((m) => m.index ?? 0);

    let finish!: (r: PlayResult) => void;
    const done = new Promise<PlayResult>((resolve) => (finish = resolve));
    const playback: Playback = {
      kind: "browser",
      timeline,
      clockStart: performance.now() + 60_000, // hold the mouth until onstart
      wordOffsets,
      done,
      finish,
    };

    const u = new SpeechSynthesisUtterance(utt.text);
    u.rate = voice.rate;
    u.pitch = voice.pitch;
    u.volume = voice.volume;
    const match = speechSynthesis.getVoices().find((v) => v.voiceURI === voice.voice || v.name === voice.voice);
    if (match) u.voice = match;

    u.onstart = () => {
      playback.clockStart = performance.now();
    };
    u.onboundary = (e) => {
      if (e.name !== "word") return;
      // Map the spoken word (by character offset in the original text) to
      // the matching timeline word and snap the clock to it.
      let k = playback.wordOffsets.findIndex((off, i) => {
        const next = playback.wordOffsets[i + 1] ?? Infinity;
        return e.charIndex >= off && e.charIndex < next;
      });
      if (k < 0) return;
      const words = timeline.words;
      if (words.length !== playback.wordOffsets.length) {
        k = Math.round((k * words.length) / Math.max(1, playback.wordOffsets.length));
      }
      const w = words[Math.min(k, words.length - 1)];
      if (w) playback.clockStart = performance.now() - w.start * 1000;
    };
    const end = (interrupted: boolean) => {
      if (this.playback === playback) {
        this.playback = null;
        finish({ interrupted });
      }
    };
    u.onend = () => end(false);
    u.onerror = (e) => end(e.error === "interrupted" || e.error === "canceled");

    this.playback = playback;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return done;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i]! += data[i]! / buffer.numberOfChannels;
  }
  return out;
}

/** List Web Speech API voices (they load asynchronously in some browsers). */
export function browserVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}
