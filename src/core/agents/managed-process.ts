import type { ChildProcess } from "node:child_process";

export function signalChildProcess(child: ChildProcess, options: { detached: boolean; signal: NodeJS.Signals }): void {
  if (options.detached && child.pid) {
    try { process.kill(-child.pid, options.signal); return; } catch { /* fallback */ }
  }
  child.kill(options.signal);
}

export async function shutdownChildProcess(
  child: ChildProcess,
  options: { detached: boolean; timeoutMs?: number },
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const timeoutMs = options.timeoutMs ?? 3_000;
  await new Promise<void>((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; resolve(); };
    child.on("close", fin);
    try { signalChildProcess(child, { ...options, signal: "SIGTERM" }); } catch { /* best-effort */ }
    const t = setTimeout(() => {
      try { signalChildProcess(child, { ...options, signal: "SIGKILL" }); } catch { /* best-effort */ }
      const h = setTimeout(fin, 100); h.unref?.();
    }, timeoutMs);
    t.unref?.();
  });
}
