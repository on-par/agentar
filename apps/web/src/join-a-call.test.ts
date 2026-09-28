import { describe, expect, it } from "vitest";
import { DEFAULT_PORT } from "@agentar/core";
import { joinACallSteps, skillDirFromCli, stageUrl, STAGE_HEIGHT, STAGE_WIDTH } from "./join-a-call.js";

describe("stageUrl", () => {
  it("defaults to the bridge port on localhost", () => {
    expect(stageUrl()).toBe(`http://localhost:${DEFAULT_PORT}/?stage=1`);
  });

  it("uses the given origin and tolerates a trailing slash", () => {
    expect(stageUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/?stage=1");
    expect(stageUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/?stage=1");
  });
});

describe("joinACallSteps", () => {
  const steps = joinACallSteps("http://localhost:7777/?stage=1");

  it("walks through OBS in four steps", () => {
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatch(/Install OBS Studio/);
    expect(steps[1]).toContain("http://localhost:7777/?stage=1");
    expect(steps[1]).toContain(`${STAGE_WIDTH}×${STAGE_HEIGHT}`);
    expect(steps[1]).toContain("Control audio via OBS");
    expect(steps[2]).toMatch(/Start Virtual Camera/);
  });

  it("calls out Zoom and Discord as the target apps", () => {
    expect(steps[3]).toMatch(/Zoom/);
    expect(steps[3]).toMatch(/Discord/);
    expect(steps[3]).toMatch(/OBS Virtual Camera/);
  });
});

describe("skillDirFromCli", () => {
  it("finds the skill in a checkout", () => {
    expect(skillDirFromCli("/src/agentar/packages/cli/dist/index.js")).toBe("/src/agentar/skills/agentar-join-a-call");
  });

  it("finds the skill in a release package", () => {
    expect(skillDirFromCli("/usr/lib/node_modules/agentar/dist/agentar.js")).toBe("/usr/lib/node_modules/agentar/skills/agentar-join-a-call");
  });

  it("keeps Windows separators", () => {
    expect(skillDirFromCli("C:\\agentar\\packages\\cli\\dist\\index.js")).toBe("C:\\agentar\\skills\\agentar-join-a-call");
  });

  it("returns null for an unknown layout", () => {
    expect(skillDirFromCli("/somewhere/else.js")).toBeNull();
  });
});
