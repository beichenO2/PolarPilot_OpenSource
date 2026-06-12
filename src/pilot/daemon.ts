/**
 * Pilot Daemon — watches lobster-events.jsonl and spawns project lobster
 * instances on relevant events. Also handles scheduled health scans
 * and hourly-on-the-hour malignant-bug self-healing scans.
 *
 * Architecture:
 * - Primary: event-driven via chokidar on lobster-events.jsonl
 * - Secondary: scheduled health scan (default 03:00 local time)
 * - Tertiary: HourlyScanner — every hour-on-the-hour checks all managed
 *   projects for malignant-bug trigger signals and triggers SelfHealer
 * - Dedup: same event type+project in 10min → single activation
 *
 * HourlyScanner flow:
 *   每小时整点（setInterval 每分钟检测是否到达整点）
 *     ↓
 *   扫描所有管辖项目的 lobster/daemon-config.json（加载恶性 bug 定义）
 *     ↓
 *   对每个项目执行检测：
 *     ↓
 *   检查 .lobster-lock 是否存在
 *     ├── 存在 → 跳过（项目被锁）
 *     └── 不存在
 *             ↓
 *         检查触发信号（恶性 bug 判定）
 *             ↓
 *             ├── 无触发信号 → 跳过
 *             └── 有触发信号
 *                     ↓
 *                 检查过去 2 小时是否有加锁记录（lobster-lock 的 locked_at）
 *                     ├── 有（刚解锁不久）→ 跳过（防止冲突）
 *                     └── 无
 *                             ↓
 *                         触发自愈程序
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import { createDedup } from './dedup';
import { createPilotRuntime, runAssistantTask, type PilotRuntimeHandle } from './runtime';
import type { LobsterEvent, PilotRuntimeConfig } from './types';
import type { AssistantTask } from '../workflow/types';
import { getLockAgeMs, isLocked } from '../../../PolarClaw/src/sdk/project-lock';
import { withRateLimitRetry } from './rate-limiter';

export interface DaemonConfig {
  eventsPath: string;
  polarisorRoot: string;
  dedupWindowMs: number;
  healthScanHour: number;
  managedProjects: string[];
}

export interface DaemonHandle {
  start(): void;
  stop(): void;
  getActiveRuntimes(): Map<string, PilotRuntimeHandle>;
  triggerHealthScan(): void;
  processEvent(event: LobsterEvent): void;
}

// ---------------------------------------------------------------------------
// lobster/daemon-config.json shape
// ---------------------------------------------------------------------------

export interface DaemonConfigFile {
  /** Malignant bug trigger definitions */
  triggers?: MalignantTrigger[];
  /** Optional: skip hourly scan for this project */
  scan_disabled?: boolean;
}

export interface MalignantTrigger {
  id: string;
  description: string;
  signal_file: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Lock-status helpers
// ---------------------------------------------------------------------------

const LOCK_AGE_SKIP_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Returns true when the project is currently locked OR was unlocked
 * within the last 2 hours (to avoid conflict with a recent SelfHealer run).
 */
function checkProjectLockStatus(projectId: string): boolean {
  if (isLocked(projectId)) return true;
  const ageMs = getLockAgeMs(projectId);
  if (ageMs !== null && ageMs < LOCK_AGE_SKIP_MS) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Daemon-config loader
// ---------------------------------------------------------------------------

function lobsterDir(projectId: string): string {
  return join(homedir(), 'Polarisor', projectId, 'lobster');
}

function daemonConfigPath(projectId: string): string {
  return join(lobsterDir(projectId), 'daemon-config.json');
}

/**
 * Loads lobster/daemon-config.json for a project.
 * Returns an empty object if the file does not exist or is invalid.
 */
function loadDaemonConfig(projectId: string): DaemonConfigFile {
  const configPath = daemonConfigPath(projectId);
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as DaemonConfigFile;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// SelfHealer — spawns self-heal.sh subprocess with rate-limit retry
// ---------------------------------------------------------------------------

interface SelfHealerOpts {
  project: string;
  triggerId: string;
  triggerFile: string;
}

interface MalignantBugSignal {
  project: string;
  bugType: string;
  file: string;
  line: number;
}

interface HealingResult {
  success: boolean;
  message: string;
  fixedFiles?: string[];
}

/**
 * Publishes an event to lobster-events.jsonl
 */
function publishLobsterEvent(event: {
  type: string;
  project: string;
  payload: Record<string, unknown>;
  timestamp: string;
}): void {
  const eventsPath = join(homedir(), 'Polarisor', 'lobster-events.jsonl');
  const line = JSON.stringify(event) + '\n';
  try {
    appendFileSync(eventsPath, line, 'utf-8');
  } catch (err) {
    console.error(`[SelfHealer] Failed to write event: ${err}`);
  }
}

/**
 * Triggers the self-heal.sh subprocess with rate-limit retry handling.
 * - Spawns bash self-heal.sh
 * - Sends bug signal via stdin as JSON
 * - Receives result via stdout
 * - Writes result to lobster-events.jsonl
 * - On 429, waits 5min and retries up to 3 times
 */
async function callSelfHealer(opts: SelfHealerOpts): Promise<HealingResult | null> {
  const { project, triggerId, triggerFile } = opts;
  console.error(`[SelfHealer] Triggering for project=${project} trigger=${triggerId} signal=${triggerFile}`);

  const signal: MalignantBugSignal = {
    project,
    bugType: triggerId,
    file: triggerFile,
    line: 0, // Line number not available from trigger, default to 0
  };

  const { result, rateLimited, attempts } = await withRateLimitRetry(async () => {
    const scriptPath = join(__dirname, '..', '..', 'scripts', 'self-heal.sh');
    
    return new Promise<string>((resolve, reject) => {
      const child = spawn('bash', [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const payload = JSON.stringify(signal);
      child.stdin.write(payload);
      child.stdin.end();

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          const error = new Error(`self-heal.sh exited with code ${code}: ${stderr}`);
          (error as any).status = code;
          reject(error);
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  });

  if (rateLimited) {
    // Rate limit exhausted — write failure event and stop
    publishLobsterEvent({
      type: 'healing_failed',
      project,
      payload: {
        bugType: triggerId,
        file: triggerFile,
        reason: 'rate_limit_exhausted',
        attempts,
      },
      timestamp: new Date().toISOString(),
    });
    console.error(`[SelfHealer] Rate limit exhausted after ${attempts} attempts for project=${project}`);
    return null;
  }

  // Parse healing result
  let healingResult: HealingResult;
  try {
    healingResult = JSON.parse(result!);
  } catch {
    healingResult = {
      success: false,
      message: result || 'No output from self-heal.sh',
    };
  }

  // Write success event
  publishLobsterEvent({
    type: 'healing_completed',
    project,
    payload: {
      bugType: triggerId,
      file: triggerFile,
      result: healingResult,
    },
    timestamp: new Date().toISOString(),
  });

  console.error(`[SelfHealer] Completed for project=${project}: success=${healingResult.success}`);

  if (!healingResult.success) {
    console.error(`[SelfHealer] Mechanical fix failed for ${project}, escalating to Agentic Healer...`);
    try {
      const { agenticHeal } = await import('./agentic-healer.js');
      const agenticResult = await agenticHeal({
        type: triggerId,
        sourceProject: project,
        payload: { triggerFile, mechanicalResult: healingResult },
      });

      if (agenticResult.success) {
        publishLobsterEvent({
          type: 'agentic_healing_success',
          project,
          payload: { analysis: agenticResult.analysis?.slice(0, 500), fixApplied: agenticResult.fixApplied },
          timestamp: new Date().toISOString(),
        });
        return { success: true, message: `Agentic fix applied: ${agenticResult.fixApplied}` };
      }

      publishLobsterEvent({
        type: 'agentic_healing_failed',
        project,
        payload: { error: agenticResult.error, analysis: agenticResult.analysis?.slice(0, 500) },
        timestamp: new Date().toISOString(),
      });

      try {
        await fetch('http://127.0.0.1:8040/api/ui/alerts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: project,
            severity: 'critical',
            title: `${project} 自愈失败：${triggerId}`,
            detail: agenticResult.error || agenticResult.analysis?.slice(0, 300),
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch { /* Hub may not be running */ }
    } catch (err) {
      console.error(`[SelfHealer] Agentic healer import/call failed:`, err);
    }
  }

  return healingResult;
}

// ---------------------------------------------------------------------------
// HourlyScanner
// ---------------------------------------------------------------------------

class HourlyScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly managedProjects: string[];
  private readonly polarisorRoot: string;
  private readonly log: (msg: string) => void;

  constructor(opts: {
    managedProjects: string[];
    polarisorRoot: string;
    log: (msg: string) => void;
  }) {
    this.managedProjects = opts.managedProjects;
    this.polarisorRoot = opts.polarisorRoot;
    this.log = opts.log;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 60_000);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    this.log('[HourlyScanner] Started — checking every minute for the hour mark');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log('[HourlyScanner] Stopped');
  }

  private tick() {
    const now = new Date();
    if (now.getMinutes() !== 0) return; // not on the hour yet

    const hourStr = now.getHours().toString().padStart(2, '0');
    this.log(`[HourlyScanner] Hour tick: ${hourStr}:00 — scanning ${this.managedProjects.length} project(s)`);

    for (const project of this.managedProjects) {
      this.scanProject(project);
    }
  }

  private scanProject(projectId: string) {
    // 1. Check lock status (locked OR recently unlocked < 2h)
    if (checkProjectLockStatus(projectId)) {
      this.log(`[HourlyScanner] [${projectId}] Skipped — project is locked or was recently unlocked`);
      return;
    }

    // 2. Load daemon config (malignant bug definitions)
    const config = loadDaemonConfig(projectId);
    if (config.scan_disabled) {
      this.log(`[HourlyScanner] [${projectId}] Skipped — scan disabled in daemon-config.json`);
      return;
    }

    const triggers = config.triggers ?? [];
    if (triggers.length === 0) {
      // No triggers defined — nothing to do
      return;
    }

    // 3. Check each trigger signal file
    for (const trigger of triggers) {
      const signalPath = join(this.polarisorRoot, projectId, trigger.signal_file);
      if (!existsSync(signalPath)) continue; // no trigger signal present

      // 4. Signal present → SelfHealer
      this.log(`[HourlyScanner] [${projectId}] Trigger detected: ${trigger.id} (${trigger.description})`);
      callSelfHealer({
        project: projectId,
        triggerId: trigger.id,
        triggerFile: trigger.signal_file,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// createDaemon
// ---------------------------------------------------------------------------

export function createDaemon(config: DaemonConfig): DaemonHandle {
  const { eventsPath, polarisorRoot, dedupWindowMs, healthScanHour, managedProjects } = config;

  const dedup = createDedup({ windowMs: dedupWindowMs });
  const runtimes = new Map<string, PilotRuntimeHandle>();

  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let hourlyScanner: HourlyScanner | null = null;
  let lastFileSize = 0;
  let watcher: FSWatcher | null = null;

  function log(msg: string) {
    console.error(`[PilotDaemon] ${msg}`);
  }

  function ensureEventsFile() {
    if (!existsSync(eventsPath)) {
      mkdirSync(dirname(eventsPath), { recursive: true });
      writeFileSync(eventsPath, '');
      log(`Created events file: ${eventsPath}`);
    }
  }

  function getOrCreateRuntime(project: string): PilotRuntimeHandle {
    let runtime = runtimes.get(project);
    if (runtime) return runtime;

    const projectDir = join(polarisorRoot, project);
    const targetsDir = join(projectDir, 'lobster', 'targets');

    const runtimeConfig: PilotRuntimeConfig = {
      project,
      events_path: eventsPath,
      targets_dir: targetsDir,
      dedup_window_ms: dedupWindowMs,
      health_scan_cron: `0 ${healthScanHour} * * *`,
      route_broken_n: 3,
      unreachable_m: 5,
      review_enabled: true,
    };

    runtime = createPilotRuntime({
      config: runtimeConfig,
      onCrystallize(proj, finding) {
        log(`[${proj}] Crystallize: ${finding}`);
      },
      onNotifyUser(proj, reason, details) {
        log(`[${proj}] Notify: ${reason} — ${details}`);
      },
    });

    runtimes.set(project, runtime);
    return runtime;
  }

  function processEvent(event: LobsterEvent): void {
    const targetProject = event.target_project || event.source_project;
    if (!targetProject) return;

    if (!managedProjects.includes(targetProject)) {
      log(`Ignoring event for unmanaged project: ${targetProject}`);
      return;
    }

    if (!dedup.shouldProcess(event.dedup_key)) {
      log(`Dedup: skipping ${event.dedup_key}`);
      return;
    }

    log(`Event → ${targetProject}: type=${event.type}, severity=${event.severity}`);

    if (event.type === 'assistant_task') {
      const task = event.payload as unknown as AssistantTask;
      const taskId = event.dedup_key.includes(':')
        ? event.dedup_key.replace(/^.*?:/, '')
        : `assist-${Date.now()}`;
      log(`Assistant task received: ${task.fundamentalGoal} (id=${taskId})`);
      void runAssistantTask({
        project: targetProject,
        task,
        task_id: taskId,
        eventsPath,
      }).catch(err => log(`Assistant task failed (id=${taskId}): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const runtime = getOrCreateRuntime(targetProject);
    runtime.stateMachine.setEvent(event);

    try {
      runtime.align();
    } catch (err) {
      log(`Alignment failed for ${targetProject}: ${err}`);
    }
  }

  function readNewEvents(): LobsterEvent[] {
    if (!existsSync(eventsPath)) return [];

    try {
      const stat = statSync(eventsPath);
      if (stat.size <= lastFileSize) return [];

      const raw = readFileSync(eventsPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());

      const currentLines = lines.length;
      const prevLines = lastFileSize === 0 ? 0 : raw.slice(0, lastFileSize).split('\n').filter(l => l.trim()).length;
      lastFileSize = stat.size;

      const newLines = lines.slice(prevLines);
      const events: LobsterEvent[] = [];
      for (const line of newLines) {
        try { events.push(JSON.parse(line) as LobsterEvent); }
        catch { /* skip malformed */ }
      }
      return events;
    } catch { return []; }
  }

  function onFileChange() {
    const events = readNewEvents();
    for (const ev of events) {
      processEvent(ev);
    }
  }

  function scheduleHealthScan() {
    const checkInterval = 60_000;
    healthTimer = setInterval(() => {
      const now = new Date();
      if (now.getHours() === healthScanHour && now.getMinutes() === 0) {
        triggerHealthScan();
      }
    }, checkInterval);

    if (typeof healthTimer === 'object' && 'unref' in healthTimer) {
      healthTimer.unref();
    }
  }

  function triggerHealthScan() {
    log(`Health scan triggered for ${managedProjects.length} projects`);
    for (const project of managedProjects) {
      const event: LobsterEvent = {
        ts: new Date().toISOString(),
        type: 'scheduled_health_scan',
        source_project: 'PolarClaw',
        target_project: project,
        severity: 'low',
        payload: {},
        dedup_key: `health:${project}:${new Date().toISOString().slice(0, 10)}`,
      };
      processEvent(event);
    }
  }

  function start() {
    log(`Starting daemon, watching: ${eventsPath}`);
    log(`Managed projects: ${managedProjects.join(', ')}`);

    ensureEventsFile();

    try {
      const stat = statSync(eventsPath);
      lastFileSize = stat.size;
    } catch { lastFileSize = 0; }

    watcher = chokidar.watch(eventsPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    watcher.on('change', onFileChange);
    watcher.on('add', onFileChange);
    watcher.on('error', (err: unknown) => {
      log(`Watcher error: ${err instanceof Error ? err.message : String(err)}`);
    });

    scheduleHealthScan();

    // Start HourlyScanner for malignant-bug on-the-hour detection
    hourlyScanner = new HourlyScanner({
      managedProjects,
      polarisorRoot,
      log,
    });
    hourlyScanner.start();

    log('Daemon started (chokidar watch + health scan timer + HourlyScanner)');
  }

  function stop() {
    if (watcher) {
      void watcher.close();
      watcher = null;
    }

    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }

    if (hourlyScanner) {
      hourlyScanner.stop();
      hourlyScanner = null;
    }

    for (const [project, runtime] of runtimes) {
      runtime.stop();
      log(`Stopped runtime: ${project}`);
    }
    runtimes.clear();

    dedup.stop();
    log('Daemon stopped');
  }

  return {
    start,
    stop,
    getActiveRuntimes: () => runtimes,
    triggerHealthScan,
    processEvent,
  };
}
