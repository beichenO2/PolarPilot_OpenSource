/**
 * Wake-up alignment — 5-step "对齐项目现状" executed every time a
 * project lobster wakes up, before entering the cycle.
 *
 * Steps:
 *  1. git fetch && git log — check sandbox for changes by other agents
 *  2. Read polaris.json — current features status
 *  3. Read lobster memory (project-scoped)
 *  4. Read last 24h lobster-events.jsonl for this project
 *  5. Read active targets from lobster/targets/
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TargetStore } from './targets';
import type { LobsterEvent } from './types';

export interface AlignmentResult {
  project: string;
  ts: string;
  git: {
    recent_commits: string[];
    has_uncommitted: boolean;
    current_branch: string;
  };
  polaris: {
    name: string;
    status: string;
    features_summary: string[];
  };
  memory: {
    available: boolean;
    note: string;
  };
  recent_events: LobsterEvent[];
  active_targets: {
    id: string;
    type: string;
    title: string;
    status: string;
    arrow_count: number;
  }[];
}

export interface AlignConfig {
  projectName: string;
  projectDir: string;
  eventsPath: string;
  targetStore: TargetStore;
}

export function runAlignment(config: AlignConfig): AlignmentResult {
  const { projectName, projectDir, eventsPath, targetStore } = config;
  const result: AlignmentResult = {
    project: projectName,
    ts: new Date().toISOString(),
    git: { recent_commits: [], has_uncommitted: false, current_branch: 'unknown' },
    polaris: { name: projectName, status: 'unknown', features_summary: [] },
    memory: { available: false, note: '' },
    recent_events: [],
    active_targets: [],
  };

  // Step 1: Git status
  result.git = alignGit(projectDir);

  // Step 2: polaris.json
  result.polaris = alignPolaris(projectDir);

  // Step 3: lobster memory (placeholder — full memory integration via PolarUser)
  result.memory = { available: false, note: 'Memory integration requires PolarUser.project identity (PolarClaw_PolarUser.md)' };

  // Step 4: Recent events (24h)
  result.recent_events = alignEvents(eventsPath, projectName);

  // Step 5: Active targets
  result.active_targets = alignTargets(targetStore);

  return result;
}

function alignGit(projectDir: string): AlignmentResult['git'] {
  const gitResult: AlignmentResult['git'] = {
    recent_commits: [],
    has_uncommitted: false,
    current_branch: 'unknown',
  };

  if (!existsSync(join(projectDir, '.git'))) return gitResult;

  try {
    execSync('git fetch --quiet 2>/dev/null || true', { cwd: projectDir, timeout: 15000 });
  } catch { /* network unavailable is fine */ }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim();
    gitResult.current_branch = branch;
  } catch { /* non-git dir */ }

  try {
    const log = execSync('git log --oneline -10 --no-decorate', { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim();
    gitResult.recent_commits = log ? log.split('\n') : [];
  } catch { /* ok */ }

  try {
    const status = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf8', timeout: 5000 }).trim();
    gitResult.has_uncommitted = status.length > 0;
  } catch { /* ok */ }

  return gitResult;
}

function alignPolaris(projectDir: string): AlignmentResult['polaris'] {
  const polarisPath = join(projectDir, 'polaris.json');
  const defaultResult = { name: '', status: 'unknown', features_summary: [] as string[] };

  if (!existsSync(polarisPath)) return defaultResult;

  try {
    const raw = JSON.parse(readFileSync(polarisPath, 'utf8'));
    const name = raw.name ?? '';
    const status = raw.status ?? 'unknown';
    const features: string[] = [];

    if (Array.isArray(raw.requirements)) {
      for (const req of raw.requirements) {
        if (Array.isArray(req.features)) {
          for (const f of req.features) {
            features.push(`${req.id}.${f.name}: ${f.status ?? 'unknown'}`);
          }
        }
      }
    }

    return { name, status, features_summary: features };
  } catch {
    return defaultResult;
  }
}

function alignEvents(eventsPath: string, projectName: string): LobsterEvent[] {
  if (!existsSync(eventsPath)) return [];

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const raw = readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    const events: LobsterEvent[] = [];

    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as LobsterEvent;
        if (ev.ts < cutoff) continue;
        if (ev.target_project === projectName || ev.source_project === projectName) {
          events.push(ev);
        }
      } catch { /* skip malformed lines */ }
    }

    return events.slice(-50);
  } catch {
    return [];
  }
}

function alignTargets(targetStore: TargetStore): AlignmentResult['active_targets'] {
  const active = targetStore.list({ status: 'active' });
  return active.map(t => ({
    id: t.id,
    type: t.type,
    title: t.title,
    status: t.status,
    arrow_count: t.arrow_logs.length,
  }));
}
