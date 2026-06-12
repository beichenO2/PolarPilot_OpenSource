import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let logPath: string | null = null;
let buf: string[] = [];
let dropped = 0;

function fmt(ev: string, d: Record<string, unknown>): string {
  try { return JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event: ev, ...d }) + "\n"; }
  catch { return JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event: ev }) + "\n"; }
}

export function initDebugLog(path: string): void {
  logPath = path;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* best-effort */ }
  if (buf.length || dropped) {
    try { appendFileSync(path, (dropped ? fmt("overflow", { dropped }) : "") + buf.join(""), "utf-8"); } catch { /* best-effort */ }
  }
  buf = [];
  dropped = 0;
}

export function appendDebugLog(ev: string, d: Record<string, unknown> = {}): void {
  const l = fmt(ev, d);
  if (!logPath) { buf.push(l); if (buf.length > 1000) { buf.shift(); dropped++; } return; }
  try { appendFileSync(logPath, l, "utf-8"); } catch { /* best-effort */ }
}

function tryR<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }

export function serializeError(e: unknown, depth = 0): Record<string, unknown> {
  try {
    if (depth > 6) return { value: "[truncated]" };
    if (e instanceof Error) {
      const r: Record<string, unknown> = { name: tryR(() => e.name) ?? "Error", message: tryR(() => e.message) ?? "" };
      const cause = tryR(() => "cause" in e ? e.cause : undefined);
      if (cause !== undefined) r.cause = serializeError(cause, depth + 1);
      return r;
    }
    return { value: String(e) };
  } catch { return { value: "[serialization failed]" }; }
}

export function resetDebugLogForTests(): void { logPath = null; buf = []; dropped = 0; }
