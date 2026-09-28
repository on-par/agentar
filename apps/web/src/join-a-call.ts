import { DEFAULT_PORT } from "@agentar/core";

/** Browser Source size that matches the stage framing. */
export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;

/** Name of the OpenClaw skill folder under `skills/`. */
export const SKILL_NAME = "agentar-join-a-call";

/** Stage view (no panel, no orbit controls) for an OBS Browser Source. */
export function stageUrl(origin = `http://localhost:${DEFAULT_PORT}`): string {
  return `${origin.replace(/\/+$/, "")}/?stage=1`;
}

/** The numbered OBS checklist shown in the Connect tab and taught by the skill. */
export function joinACallSteps(url: string): string[] {
  return [
    "Install OBS Studio (obsproject.com).",
    `Add a Browser Source with URL ${url}, size ${STAGE_WIDTH}×${STAGE_HEIGHT}, and turn on "Control audio via OBS".`,
    "Click Start Virtual Camera.",
    "In Zoom or Discord (or Teams / Meet), pick OBS Virtual Camera as the camera.",
  ];
}

export const AUDIO_NOTE =
  'Audio: in OBS set Settings → Audio → Monitoring Device to BlackHole (macOS) or VB-Cable (Windows), set the browser source to "Monitor and Output", then pick that device as the microphone in the call.';

export const SPEECH_NOTE =
  "While the stage is the camera, the agent still speaks through POST /api/say. Every open view plays audio, so open this tab with ?mute=1 to avoid an echo.";

/**
 * Where the skill lives next to this install, derived from the CLI entry point
 * (`<repo>/packages/cli/dist/index.js` in a checkout, `<pkg>/dist/agentar.js` in a release).
 */
export function skillDirFromCli(cliPath: string): string | null {
  const m = /^(.*?)([\\/])(?:packages[\\/]cli[\\/]dist[\\/]index\.js|dist[\\/]agentar\.js)$/.exec(cliPath);
  if (!m) return null;
  const [, root, sep] = m;
  return `${root}${sep}skills${sep}${SKILL_NAME}`;
}
