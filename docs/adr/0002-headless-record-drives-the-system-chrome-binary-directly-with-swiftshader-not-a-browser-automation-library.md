# ADR-0002: Headless record drives the system Chrome binary directly with SwiftShader, not a browser-automation library

- Status: Accepted
- Date: 2026-09-28

## Context

`agentar record` has to produce a clip on hosts with no display (CI, servers). Story 1 (#8)
moved capture into the page: the page's MediaRecorder uploads chunks to /api/record. So the
CLI no longer needs to control or screencast the browser. It only needs a browser that loads
`?stage=1`, renders WebGL without a GPU, and allows audio without a user gesture. Puppeteer or
Playwright would add a large dependency and a separate browser download to a small CLI that is
otherwise nearly dependency-free. Headless Chrome with
`--use-angle=swiftshader --enable-unsafe-swiftshader` was verified on 2026-09-27 to render the
three.js stage.

## Decision

`agentar record` spawns the locally installed Chrome/Chromium binary as a plain child process.
It finds the binary through AGENTAR_CHROME or well-known install paths. It passes
`--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader
--autoplay-policy=no-user-gesture-required` and a throwaway `--user-data-dir`, and points it at
a private in-process bridge bound to an ephemeral port. The CLI talks only to the bridge's
HTTP API, never to the browser over CDP. The CLI takes no puppeteer/playwright dependency.

## Consequences

The CLI stays small and needs no browser download. Users must have Chrome or Chromium installed
or point AGENTAR_CHROME at one. We cannot drive the page directly, so readiness is inferred
from /api/health client count plus a settle delay rather than a page-side signal. Chrome flag
behavior must be re-checked when Chrome changes its headless modes. A private bridge per run
means `record` never disturbs a user's running bridge or daemon, but it does re-read the same
AGENTAR_HOME config (voice, avatar).

## References

- [Issue](https://github.com/on-par/agentar/issues/9)
- [Issue](https://github.com/on-par/agentar/issues/8)
