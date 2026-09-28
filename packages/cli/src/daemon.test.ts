import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearDaemonState, daemonPaths, daemonStatus, isAlive, stopDaemon, waitForDaemon, writeDaemonState } from "./daemon.js";

function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!isAlive(pid)) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out waiting for process to exit"));
      setTimeout(check, 50);
    };
    check();
  });
}

describe("daemon", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agentar-daemon-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reports running: true after writeDaemonState for a live pid", async () => {
    const state = { pid: process.pid, port: 7777, url: "http://localhost:7777", startedAt: new Date().toISOString() };
    await writeDaemonState(state, home);
    expect(await daemonStatus(home)).toEqual({ running: true, state });
  });

  it("reports running: false and removes the file when the pid is dead", async () => {
    const dead = spawn(process.execPath, ["-e", ""]);
    const pid = dead.pid!;
    await new Promise((resolve) => dead.on("exit", resolve));
    await writeDaemonState({ pid, port: 7777, url: "http://localhost:7777", startedAt: new Date().toISOString() }, home);
    expect(await daemonStatus(home)).toEqual({ running: false });
    await expect(readFile(daemonPaths(home).pidFile, "utf8")).rejects.toThrow();
  });

  it("treats a corrupt pid file as not running", async () => {
    await writeFile(daemonPaths(home).pidFile, "nope");
    expect(await daemonStatus(home)).toEqual({ running: false });
  });

  it("clearDaemonState leaves a file naming a different pid in place", async () => {
    const state = { pid: process.pid, port: 7777, url: "http://localhost:7777", startedAt: new Date().toISOString() };
    await writeDaemonState(state, home);
    await clearDaemonState(process.pid + 1, home);
    expect(await daemonStatus(home)).toEqual({ running: true, state });
  });

  it("stopDaemon terminates a running process and clears the pid file", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true });
    const pid = child.pid!;
    child.unref();
    await writeDaemonState({ pid, port: 7777, url: "http://localhost:7777", startedAt: new Date().toISOString() }, home);
    const result = await stopDaemon(home);
    expect(result.running).toBe(true);
    if (result.running) expect(result.state.pid).toBe(pid);
    await waitForExit(pid);
    expect(isAlive(pid)).toBe(false);
    await expect(readFile(daemonPaths(home).pidFile, "utf8")).rejects.toThrow();
  });

  it("stopDaemon returns running: false when no pid file exists", async () => {
    expect(await stopDaemon(home)).toEqual({ running: false });
  });

  it("waitForDaemon returns null quickly when the child pid is already dead", async () => {
    const dead = spawn(process.execPath, ["-e", ""]);
    const pid = dead.pid!;
    await new Promise((resolve) => dead.on("exit", resolve));
    const result = await waitForDaemon(pid, home, 1_000);
    expect(result).toBeNull();
  });
});
