/**
 * Validation helpers shared by the config schemas. Hand-rolled so
 * @agentar/core has no runtime dependencies and can run unchanged in the
 * browser. Invalid values fall back instead of throwing.
 */
import type { ColorHex, ColorOverride } from "./config.js";

export type Dict = Record<string, unknown>;

export const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function color(v: unknown, fallback: ColorHex): ColorHex {
  return typeof v === "string" && HEX_RE.test(v) ? (v.toLowerCase() as ColorHex) : fallback;
}
export function colorOverride(v: unknown, fallback: ColorOverride): ColorOverride {
  if (v === null) return null;
  return typeof v === "string" && HEX_RE.test(v) ? (v.toLowerCase() as ColorHex) : fallback;
}
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
export function num(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
export function str(v: unknown, maxLen: number, fallback: string): string {
  return typeof v === "string" ? v.slice(0, maxLen) : fallback;
}
export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
