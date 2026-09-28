# WebRTC publishing platform for the avatar participant flow

- Status: Proposed — awaiting product owner sign-off
- Date: 2026-09-28
- Issue: #15 (from #10)

## Context

Agentar already puts the avatar in calls in two ways: the OBS virtual camera and the Recall
Output Media spike (see [Meetings](../meetings.md)). Zoom and Google Meet do not accept
arbitrary browser clients as publishers. So joining as our own WebRTC participant means picking
a platform that does.

The stage page already builds one `MediaStream` from `canvas.captureStream(30)` plus
`speech.captureAudio()` (`StageRecorder` in `apps/web/src/recorder.ts`). A WebRTC publisher can
publish those same tracks. What matters most is how well each SDK publishes custom
`MediaStreamTrack`s.

Constraints: agentar runs on the owner's machine and must not require paid infrastructure. A
headless Chrome stage (ADR-0002) is a likely publisher host.

## Options compared

| Platform | JS publisher SDK | Self-host / cloud | Reconnect | License / cost |
| --- | --- | --- | --- | --- |
| **LiveKit** | `livekit-client` (TypeScript, actively released on npm). `room.localParticipant.publishTrack(track)` publishes a custom `MediaStreamTrack` directly. | Self-host `livekit-server` (single Go binary or Docker image). LiveKit Cloud as a managed option with a free tier. | Built in. Tries a fast resume first, then a full reconnect. Surfaced as `RoomEvent.Reconnecting`, `RoomEvent.Reconnected`, `RoomEvent.Disconnected`. | Client and server Apache-2.0. Self-host is free. |
| **Daily** | `@daily-co/daily-js`, mature and well documented. Custom tracks through `startCustomTrack()` or custom input sources. | Cloud only. No self-host. | Handled inside the SDK, with network-connection and network-quality events. | Proprietary service. Billed per participant-minute beyond the free tier. |
| **Jitsi** | `lib-jitsi-meet` is low level and sparsely documented. Releases have mostly been consumed from GitHub, not a regular npm cadence. The iframe External API embeds the Jitsi UI and cannot publish our own tracks. | Self-host Jitsi Meet (several services: prosody, jicofo, jvb). 8x8 JaaS as the cloud option. | ICE restart and XMPP session resumption, with little exposed to the app as events. | Apache-2.0. Self-host is free; JaaS is paid beyond its free tier. |

Auth: LiveKit rooms use JWT access tokens, which the bridge can mint locally later.

## Decision

LiveKit is the v1 target. The join/publish slice builds against `livekit-client`. The default
deployment is a self-hosted `livekit-server`. LiveKit Cloud is an optional host behind the same
client code.

## Rationale

- Most direct custom-track publish API: the stage's canvas and speech tracks go straight to
  `publishTrack()`.
- Self-host with no paid infrastructure required, plus a managed option when users need reach
  from outside their network.
- An explicit reconnect event model that the reconnect slice can build on.
- Apache-2.0 client and server.
- Daily was not chosen: cloud only, and every participant-minute is billed third-party
  infrastructure.
- Jitsi was not chosen: weak publisher SDK, and reconnect is mostly opaque to the app.

## Consequences

- A future `livekit-client` dependency in `apps/web` (not in this slice).
- Users need a LiveKit server or a LiveKit Cloud project to use the participant flow.
- Zoom and Meet still need OBS or Recall. That stays out of scope here.
- ADR-0002's headless Chrome can later host the publisher page.

## Product owner sign-off

- Reviewer:
- Date:
- Outcome: (Accepted | Rejected)

## If rejected

1. Set Status to `Rejected`.
2. Replace the Decision section with "Rejected: <rationale>" and the chosen alternative or next
   step.
3. Keep the comparison table so the reasoning stays on record.

## References

- LiveKit docs: https://docs.livekit.io
- LiveKit JS client SDK: https://github.com/livekit/client-sdk-js
- LiveKit server (self-host): https://github.com/livekit/livekit
- Daily JS reference: https://docs.daily.co/reference/daily-js
- lib-jitsi-meet: https://github.com/jitsi/lib-jitsi-meet
