/**
 * Messages between the bridge (local server) and avatar clients (browser
 * tabs, OBS browser sources) over WebSocket at ws://localhost:<port>/ws,
 * plus the HTTP request bodies agents use to drive the avatar.
 */
import type { AvatarConfig } from "./config.js";
import type { Mood } from "./moods.js";

export const DEFAULT_PORT = 7777;
export const PROTOCOL_VERSION = 1;

export const GESTURES = [
  "nod",
  "shake",
  "tilt",
  "wave",
  "high-five",
  "thumbs-up",
  "thumbs-down",
  "idea",
  "shrug",
  "namaste",
  "wink",
  "laugh",
  "surprised",
  "bow",
] as const;
export type Gesture = (typeof GESTURES)[number];

export interface Utterance {
  id: string;
  /** Text exactly as it should be spoken. */
  text: string;
  mood?: Mood;
  /**
   * Pre-rendered speech audio served by the bridge. Absent when the voice
   * provider is "browser" (the client synthesises with the Web Speech API).
   */
  audio?: { url: string; mime: string };
}

export type ServerMessage =
  | { type: "hello"; protocol: number; config: AvatarConfig; clientId: string }
  | { type: "config"; config: AvatarConfig }
  | { type: "speak"; utterance: Utterance }
  | { type: "stop" }
  | { type: "mood"; mood: Mood }
  | { type: "gesture"; gesture: Gesture }
  | { type: "record-start"; id: string }
  | { type: "record-stop"; id: string }
  | { type: "join"; id: string; url: string; token: string }
  | { type: "leave" };

export type ClientMessage =
  | { type: "speech-start"; id: string }
  | { type: "speech-end"; id: string; interrupted?: boolean; error?: string }
  | { type: "record-error"; id: string; error: string }
  | { type: "join-result"; id: string; ok: boolean; room?: string; error?: string }
  | { type: "room-state"; state: RoomConnectionState; rejoining: boolean; room?: string; error?: string };

/** Whether the avatar page is currently connected to its WebRTC room. */
export type RoomConnectionState = "connected" | "disconnected";

/** POST /api/say */
export interface SayRequest {
  text: string;
  mood?: Mood;
  /** Resolve the HTTP request only after the avatar finished speaking. */
  wait?: boolean;
  /** Stop current speech first instead of queueing. Default true. */
  interrupt?: boolean;
}

export interface SayResponse {
  id: string;
  status: "queued" | "spoken" | "interrupted" | "no-clients" | "error";
  error?: string;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language?: string;
}

export interface HealthResponse {
  ok: true;
  name: "agentar";
  version: string;
  clients: number;
}

/** GET /api/status → room */
export interface RoomStatus {
  state: "not-joined" | RoomConnectionState;
  room?: string;
  /** True while the page is still trying to rejoin after a drop. */
  rejoining?: boolean;
  /** ISO time of the last state change. */
  since?: string;
  /** Why the page gave up rejoining. */
  error?: string;
}

/** GET /api/status */
export interface StatusResponse {
  ok: true;
  clients: number;
  room: RoomStatus;
}

/** POST /api/record/start */
export interface RecordStartResponse {
  id: string;
  status: "recording";
  warning?: string;
}

/** POST /api/record/stop */
export interface RecordStopResponse {
  id: string;
  path: string;
  mime: string;
  bytes: number;
}

/** POST /api/join */
export interface JoinRequest {
  /** LiveKit server URL (ws://, wss://, http:// or https://). */
  url: string;
  /** Participant access token. Never logged. */
  token: string;
}

export interface JoinResponse {
  id: string;
  status: "joined";
  room?: string;
  warning?: string;
}
