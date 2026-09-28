import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface DaemonState {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

export type DaemonStatus = { running: true; state: DaemonState } | { running: false };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function agentarHomeDir(): string {
  return process.env.AGENTAR_HOME ?? join(homedir(), ".agentar");
}

export function daemonPaths(home = agentarHomeDir()): { pidFile: string; logFile: string } {
  return { pidFile: join(home, "agentar.pid"), logFile: join(home, "agentar.log") };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.port === "number" && typeof v.url === "string" && typeof v.startedAt === "string";
}

async function readDaemonState(home = agentarHomeDir()): Promise<DaemonState | null> {
  try {
    const raw = JSON.parse(await readFile(daemonPaths(home).pidFile, "utf8"));
    return isDaemonState(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function writeDaemonState(state: DaemonState, home = agentarHomeDir()): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(daemonPaths(home).pidFile, `${JSON.stringify(state)}\n`);
}

export async function clearDaemonState(pid: number, home = agentarHomeDir()): Promise<void> {
  const state = await readDaemonState(home);
  if (state?.pid !== pid) return;
  try {
    await rm(daemonPaths(home).pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function daemonStatus(home = agentarHomeDir()): Promise<DaemonStatus> {
  const state = await readDaemonState(home);
  if (state && isAlive(state.pid)) return { running: true, state };
  if (state) {
    try {
      await rm(daemonPaths(home).pidFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return { running: false };
}

export async function spawnDaemon(cliPath: string, startArgs: string[], home = agentarHomeDir()): Promise<number> {
  await mkdir(home, { recursive: true });
  const { logFile } = daemonPaths(home);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [cliPath, "start", "--no-open", ...startArgs], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, AGENTAR_DAEMON: "1" },
    });
    child.unref();
    if (!child.pid) throw new Error("could not start the agentar daemon");
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export async function waitForDaemon(childPid: number, home = agentarHomeDir(), timeoutMs = 20_000): Promise<DaemonState | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readDaemonState(home);
    if (state?.pid === childPid) return state;
    if (!isAlive(childPid)) return null;
    if (Date.now() >= deadline) return null;
    await sleep(200);
  }
}

export async function stopDaemon(home = agentarHomeDir(), timeoutMs = 10_000): Promise<DaemonStatus> {
  const status = await daemonStatus(home);
  if (!status.running) return status;
  const { pid } = status.state;
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(pid)) {
    process.kill(pid, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (isAlive(pid) && Date.now() < killDeadline) await sleep(100);
  }
  await clearDaemonState(pid, home);
  return status;
}
