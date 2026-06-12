#!/usr/bin/env node
/**
 * lobster_start — CLI entry point for Pilot Runtime.
 *
 * Usage:
 *   npx tsx src/pilot/lobster-start.ts --project knowlever
 *   npm run lobster:start -- --project knowlever
 *
 * Environment variables set for the spawned runtime:
 *   POLAR_USER_ID=project:<name>
 *   LOBSTER_PROJECT=<name>
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { createPilotRuntime } from './runtime';
import type { PilotRuntimeConfig } from './types';

function parseArgs(): { project: string; daemon: boolean; healthScan: boolean } {
  const args = process.argv.slice(2);
  let project = '';
  let daemon = false;
  let healthScan = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      project = args[i + 1]!;
      i++;
    } else if (args[i] === '--daemon') {
      daemon = true;
    } else if (args[i] === '--health-scan') {
      healthScan = true;
    }
  }

  if (!project) {
    console.error('Usage: lobster_start --project <name> [--daemon] [--health-scan]');
    console.error('');
    console.error('Options:');
    console.error('  --project <name>   Project name (required)');
    console.error('  --daemon           Run as daemon watching events file');
    console.error('  --health-scan      Trigger one-time health scan and exit');
    process.exit(1);
  }

  return { project, daemon, healthScan };
}

async function main() {
  const { project, daemon, healthScan } = parseArgs();

  const polarisorRoot = join(homedir(), 'Polarisor');
  const projectDir = join(polarisorRoot, project);

  if (!existsSync(projectDir)) {
    console.error(`[lobster_start] Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  process.env.POLAR_USER_ID = `project:${project}`;
  process.env.LOBSTER_PROJECT = project;

  const eventsPath = join(polarisorRoot, 'SOTAgent', 'data', 'lobster-events.jsonl');
  const targetsDir = join(projectDir, 'lobster', 'targets');

  if (!existsSync(targetsDir)) {
    mkdirSync(targetsDir, { recursive: true });
    console.error(`[lobster_start] Created targets dir: ${targetsDir}`);
  }

  const runtimeConfig: PilotRuntimeConfig = {
    project,
    events_path: eventsPath,
    targets_dir: targetsDir,
    dedup_window_ms: 10 * 60 * 1000,
    health_scan_cron: '0 3 * * *',
    route_broken_n: 3,
    unreachable_m: 5,
  };

  if (daemon) {
    const { createDaemon } = await import('./daemon.js');
    const daemonHandle = createDaemon({
      eventsPath,
      polarisorRoot,
      dedupWindowMs: runtimeConfig.dedup_window_ms,
      healthScanHour: 3,
      managedProjects: [project],
    });
    daemonHandle.start();

    console.error(`[lobster_start] Daemon mode for project:${project}`);
    console.error(`[lobster_start] Watching: ${eventsPath}`);
    console.error(`[lobster_start] Press Ctrl+C to stop`);

    const shutdown = () => {
      daemonHandle.stop();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    await new Promise(() => {});
    return;
  }

  const runtime = createPilotRuntime({
    config: runtimeConfig,
    onCrystallize(proj, finding) {
      console.error(`[crystallize] ${proj}: ${finding}`);
    },
    onNotifyUser(proj, reason, details) {
      console.error(`[notify] ${proj}: ${reason} — ${details}`);
    },
  });

  console.error(`[lobster_start] Starting alignment for project:${project}`);
  const alignment = runtime.align();

  console.error(`\n=== Alignment Report: ${project} ===`);
  console.error(`Branch: ${alignment.git.current_branch}`);
  console.error(`Uncommitted: ${alignment.git.has_uncommitted}`);
  console.error(`Recent commits: ${alignment.git.recent_commits.length}`);
  console.error(`Polaris status: ${alignment.polaris.status}`);
  console.error(`Features: ${alignment.polaris.features_summary.length}`);
  console.error(`Recent events: ${alignment.recent_events.length}`);
  console.error(`Active targets: ${alignment.active_targets.length}`);

  if (healthScan) {
    console.error(`\n=== Health Scan ===`);
    const status = runtime.getStatus();
    console.error(JSON.stringify(status, null, 2));
    runtime.stop();
    return;
  }

  const status = runtime.getStatus();
  console.error(`\n=== Runtime Status ===`);
  console.error(JSON.stringify(status, null, 2));

  runtime.stop();
}

main().catch(err => {
  console.error('[lobster_start] Fatal:', err);
  process.exit(1);
});
