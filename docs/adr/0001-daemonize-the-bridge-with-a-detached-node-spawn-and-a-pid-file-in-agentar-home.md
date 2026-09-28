# ADR-0001: Daemonize the bridge with a detached Node spawn and a pid file in AGENTAR_HOME

- Status: Accepted
- Date: 2026-09-28

## Context

Operators run hour-long calls and OBS sessions on the bridge at :7777, and closing the spawning terminal
(SIGHUP to its process group) killed it. `nohup` does not escape the process-group kill and macOS ships no
`setsid` binary. We need one mechanism that works on macOS and Linux, can be unit-tested, and lets later
commands (`status`, `stop`, the Join-a-call skill) find the running bridge. The CLI verb `agentar stop`
was already taken by "stop speaking", but the operator-facing expectation (and issue #7) is that `stop`
stops the service.

## Decision

`agentar start --daemon` re-executes the CLI with Node's `child_process.spawn({ detached: true })`, which
calls setsid() so the bridge leads its own session, with output appended to `$AGENTAR_HOME/agentar.log`.
The daemon writes `$AGENTAR_HOME/agentar.pid` (JSON: pid, port, url, startedAt) only after the server is
listening and removes it on clean shutdown; that file is the single source of truth for `agentar status`
and `agentar stop`. `agentar stop` now stops the daemon; stopping speech moves to `agentar hush`.
Windows daemon mode is not supported yet.

## Consequences

Works identically on macOS and Linux with no extra binaries or service managers. There is no automatic
restart on crash or at login (launchd/systemd would give that; left for a follow-up). Only one daemon per
AGENTAR_HOME is tracked. Scripts that used `agentar stop` to silence speech must switch to `agentar hush`.

## References

- [Issue #7: agentar start --daemon / status / stop](https://github.com/on-par/agentar/issues/7)
- [Node.js child_process options.detached](https://nodejs.org/api/child_process.html#optionsdetached)
