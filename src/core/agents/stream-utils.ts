import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

export function parseJSONLStream<T>(stream: Readable, logStream: WriteStream | null, callback: (event: T) => void): void {
  let buffer = "";
  stream.on("data", (data: Buffer) => {
    logStream?.write(data);
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { callback(JSON.parse(line) as T); } catch { /* skip */ }
    }
  });
}

export function setupAbortHandler(
  signal: AbortSignal | undefined,
  child: ChildProcess,
  reject: (err: Error) => void,
  abortChild: () => void = () => { child.kill("SIGTERM"); },
): boolean {
  if (!signal) return false;
  const onAbort = () => { abortChild(); reject(new Error("Agent was aborted")); };
  if (signal.aborted) { onAbort(); return true; }
  signal.addEventListener("abort", onAbort, { once: true });
  child.on("close", () => signal.removeEventListener("abort", onAbort));
  return false;
}
