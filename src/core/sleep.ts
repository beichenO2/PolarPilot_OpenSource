import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
export function startSleepPrevention(): { stop(): void } {
  let p: ChildProcess | null = null; const os = platform();
  if (os === 'darwin') { p = spawn('caffeinate', ['-di'], { stdio: 'ignore', detached: true }); p.unref(); }
  return { stop() { if (p) { p.kill(); p = null; } } };
}
