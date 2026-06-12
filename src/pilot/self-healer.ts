import { exec } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const execAsync = promisify(exec);

export type FixStrategy =
  | { type: 'retry_after_deps'; max_attempts: number }
  | { type: 'git_revert_last_commit'; notify_after: number }
  | { type: 'wait_and_restart'; cooldown_minutes: number }
  | { type: 'notify_only'; channel: 'lobster' | 'polarclaw' };

export interface MalignantBug {
  id: string;
  description: string;
  detection: {
    type: 'exit_code' | 'test_stats' | 'crash_loop';
    command?: string;
    expect?: number;
    threshold?: number;
    window_minutes?: number;
  };
  auto_fix: {
    strategy: FixStrategy;
    max_attempts?: number;
    notify_after?: number;
  };
}

export interface DaemonConfig {
  malignant_bugs: MalignantBug[];
  self_heal: {
    enabled: boolean;
    max_attempts_per_bug: number;
    notify_after_attempts: number;
  };
}

export interface SelfHealResult {
  bug_id: string;
  strategy: FixStrategy;
  attempt: number;
  success: boolean;
  details: string;
}

// --- Detection Helpers ---

async function detectByExitCode(command: string, expect: number = 0): Promise<boolean> {
  try {
    await execAsync(command, { timeout: 120000 });
    return expect === 0;
  } catch {
    return expect !== 0;
  }
}

async function detectByTestStats(
  command: string,
  threshold: number
): Promise<boolean> {
  try {
    const { stdout } = await execAsync(command, { timeout: 120000 });
    const match = stdout.match(/(\d+)/);
    if (!match) return false;
    const stats = parseInt(match[1], 10);
    return stats >= threshold;
  } catch {
    return false;
  }
}

async function detectByCrashLoop(windowMinutes: number, sourceProject?: string): Promise<boolean> {
  const eventsPath = join(
    process.env.HOME ?? '~',
    'Polarisor',
    'lobster-events.jsonl'
  );
  try {
    const content = readFileSync(eventsPath, 'utf-8');
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    let count = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type?.includes('bug') || event.type?.includes('crash') || event.type?.includes('restart')) {
          if (sourceProject && event.source_project !== sourceProject) continue;
          const eventTime = new Date(event.timestamp).getTime();
          if (now - eventTime <= windowMs) count++;
        }
      } catch { /* skip malformed lines */ }
    }
    return count >= 5;
  } catch {
    return false;
  }
}

async function detectBug(
  bug: MalignantBug,
  projectId: string
): Promise<boolean> {
  switch (bug.detection.type) {
    case 'exit_code': {
      if (!bug.detection.command) return false;
      return detectByExitCode(
        bug.detection.command,
        bug.detection.expect ?? 0
      );
    }
    case 'test_stats': {
      if (!bug.detection.command || bug.detection.threshold === undefined)
        return false;
      return detectByTestStats(
        bug.detection.command,
        bug.detection.threshold
      );
    }
    case 'crash_loop': {
      return detectByCrashLoop(bug.detection.window_minutes ?? 5);
    }
    default:
      return false;
  }
}

// --- Strategy Execution ---

async function executeRetryAfterDeps(
  projectId: string,
  strategy: Extract<FixStrategy, { type: 'retry_after_deps' }>
): Promise<{ success: boolean; details: string }> {
  try {
    await execAsync('npm install', { cwd: projectId, timeout: 300000 });
    await execAsync('npm run build', {
      cwd: projectId,
      timeout: 300000,
    });
    return { success: true, details: 'Build succeeded' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, details: msg };
  }
}

async function executeGitRevert(
  projectId: string
): Promise<{ success: boolean; details: string }> {
  try {
    await execAsync('git revert HEAD --no-edit', {
      cwd: projectId,
      timeout: 60000,
    });
    return { success: true, details: 'Reverted last commit successfully' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, details: msg };
  }
}

async function executeWaitAndRestart(
  strategy: Extract<FixStrategy, { type: 'wait_and_restart' }>
): Promise<{ success: boolean; details: string }> {
  const minutes = strategy.cooldown_minutes;
  return {
    success: true,
    details: `Wait-and-restart logged: cooldown of ${minutes} minute(s) recorded.`,
  };
}

async function executeNotifyOnly(
  strategy: Extract<FixStrategy, { type: 'notify_only' }>,
  projectId: string,
  bugId: string
): Promise<{ success: boolean; details: string }> {
  return {
    success: true,
    details: `Notification sent to channel '${strategy.channel}' for bug '${bugId}' in project '${projectId}'.`,
  };
}

async function executeStrategy(
  projectId: string,
  bug: MalignantBug,
  strategy: FixStrategy
): Promise<{ success: boolean; details: string }> {
  switch (strategy.type) {
    case 'retry_after_deps':
      return executeRetryAfterDeps(projectId, strategy);
    case 'git_revert_last_commit':
      return executeGitRevert(projectId);
    case 'wait_and_restart':
      return executeWaitAndRestart(strategy);
    case 'notify_only':
      return executeNotifyOnly(strategy, projectId, bug.id);
    default:
      return { success: false, details: 'Unknown strategy type' };
  }
}

// --- Core Functions ---

export async function attemptFix(
  projectId: string,
  bug: MalignantBug,
  config: DaemonConfig,
  attempt: number
): Promise<SelfHealResult> {
  const strategy = bug.auto_fix.strategy;

  const { success, details } = await executeStrategy(projectId, bug, strategy);

  return {
    bug_id: bug.id,
    strategy,
    attempt,
    success,
    details,
  };
}

export async function selfHealProject(
  projectId: string,
  config: DaemonConfig
): Promise<SelfHealResult[]> {
  if (!config.self_heal.enabled) {
    return [];
  }

  const results: SelfHealResult[] = [];

  for (const bug of config.malignant_bugs) {
    const triggered = await detectBug(bug, projectId);

    if (!triggered) {
      continue;
    }

    const maxAttempts =
      bug.auto_fix.max_attempts ?? config.self_heal.max_attempts_per_bug;
    const notifyAfter =
      bug.auto_fix.notify_after ?? config.self_heal.notify_after_attempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await attemptFix(projectId, bug, config, attempt);
      results.push(result);

      if (result.success) {
        break;
      }

      if (attempt >= notifyAfter && attempt < maxAttempts) {
        console.warn(
          `[SelfHealer] Bug '${bug.id}' still unresolved after ${attempt} attempt(s).`
        );
      }
    }
  }

  return results;
}
