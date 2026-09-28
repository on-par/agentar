# ADR-0003: The avatar page owns WebRTC room recovery; the bridge mirrors page-reported room state in GET /api/status

- Status: Accepted
- Date: 2026-09-28

## Context

The bridge brokers POST /api/join but has no connection to the SFU. Only the avatar page's LiveKit Room
sees ICE and signaling loss. A brief network drop previously left the page silently out of the room while
the bridge still considered the session joined, and remote participants saw a frozen last frame. Recovery
must happen without restarting the stage process. Agents need an HTTP way to tell a healthy session from a
broken one.

## Decision

The avatar page (RoomPublisher) detects drops through the SFU client's connection events and rejoins on its
own. It uses the url and token of the original join, kept only in page memory, and a bounded retry schedule.
Every rejoin publishes a fresh canvas capture track. The page pushes each connection change to the bridge as
a `room-state` ClientMessage. The bridge treats that as the single source of truth for room health and
serves it from GET /api/status. The bridge never probes the SFU and never re-sends the token to rejoin.

## Consequences

Recovery works in any page that hosts RoomPublisher, including headless and OBS stage pages, with no new
bridge-to-SFU dependency. Status can only be as fresh as the last room-state message. If the page itself
dies, the bridge falls back to its existing ws-close handling (room forgotten, status "not-joined"). Rejoin
cannot outlive the token's lifetime, and token refresh would need a new message. Future room features
(other SDKs, other platforms) must emit the same room-state messages rather than add bridge-side health checks.

## References

- [LiveKit client connection events (RoomEvent.Reconnecting / Reconnected / Disconnected)](https://docs.livekit.io/home/client/events/)
- [Issue #17](https://github.com/on-par/agentar/issues/17)
