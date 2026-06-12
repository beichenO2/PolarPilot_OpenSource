/**
 * Integration test: daemon event subscription via chokidar.
 * Verifies that appending to lobster-events.jsonl triggers daemon's
 * onFileChange → processEvent chain within ≤ 2s.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createDaemon } from '../../src/pilot/daemon.js';
import type { LobsterEvent } from '../../src/pilot/types.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function setupTmp(): { tmpDir: string; eventsPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'daemon-watch-'));
  created.push(tmpDir);
  const eventsPath = join(tmpDir, 'lobster-events.jsonl');
  writeFileSync(eventsPath, '');
  return { tmpDir, eventsPath };
}

function makeEvent(type: string, targetProject: string, dedupKey: string, payload: Record<string, unknown> = {}): LobsterEvent {
  return {
    ts: new Date().toISOString(),
    type: type as LobsterEvent['type'],
    source_project: 'PolarClaw',
    target_project: targetProject,
    severity: 'info',
    payload,
    dedup_key: dedupKey,
  };
}

async function waitForDoneEvent(eventsPath: string, timeoutMs: number, minCount = 1): Promise<LobsterEvent[]> {
  const deadline = Date.now() + timeoutMs;
  const found: LobsterEvent[] = [];
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    const raw = readFileSync(eventsPath, 'utf-8').split('\n').filter(l => l.trim());
    found.length = 0;
    for (const line of raw) {
      try {
        const ev = JSON.parse(line) as LobsterEvent;
        if (ev.type === 'assistant_task_done') found.push(ev);
      } catch { /* skip */ }
    }
    if (found.length >= minCount) return found;
  }
  return found;
}

describe('daemon chokidar watch integration', () => {
  it('triggers runAssistantTask when assistant_task event is appended to jsonl', async () => {
    const { tmpDir, eventsPath } = setupTmp();

    const daemon = createDaemon({
      eventsPath,
      polarisorRoot: tmpDir,
      dedupWindowMs: 0,
      healthScanHour: 99,
      managedProjects: ['NonExistentProject'],
    });

    daemon.start();

    // Wait for chokidar to initialize
    await new Promise(r => setTimeout(r, 500));

    const event = makeEvent('assistant_task', 'NonExistentProject', 'watch-test-1', {
      fundamentalGoal: 'watch-test goal',
      executionApproach: 'noop',
      stopCondition: { successCriteria: 'never', failureCriteria: 'always' },
    });
    appendFileSync(eventsPath, JSON.stringify(event) + '\n');

    const doneEvents = await waitForDoneEvent(eventsPath, 3000);
    daemon.stop();

    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    expect(doneEvents[0]!.payload).toHaveProperty('status', 'failure');
  });

  it('handles multiple appended events in sequence', async () => {
    const { tmpDir, eventsPath } = setupTmp();

    const daemon = createDaemon({
      eventsPath,
      polarisorRoot: tmpDir,
      dedupWindowMs: 0,
      healthScanHour: 99,
      managedProjects: ['NonExistentProject'],
    });

    daemon.start();
    await new Promise(r => setTimeout(r, 500));

    for (let i = 0; i < 3; i++) {
      const event = makeEvent('assistant_task', 'NonExistentProject', `watch-multi-${i}`, {
        fundamentalGoal: `multi-test ${i}`,
        executionApproach: 'noop',
        stopCondition: { successCriteria: 'never', failureCriteria: 'always' },
      });
      appendFileSync(eventsPath, JSON.stringify(event) + '\n');
      await new Promise(r => setTimeout(r, 150));
    }

    const doneEvents = await waitForDoneEvent(eventsPath, 5000, 3);
    daemon.stop();

    expect(doneEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('does not crash on malformed JSON line and still processes subsequent valid events', async () => {
    const { tmpDir, eventsPath } = setupTmp();

    const daemon = createDaemon({
      eventsPath,
      polarisorRoot: tmpDir,
      dedupWindowMs: 0,
      healthScanHour: 99,
      managedProjects: ['NonExistentProject'],
    });

    daemon.start();
    await new Promise(r => setTimeout(r, 500));

    // Append malformed JSON
    appendFileSync(eventsPath, 'NOT VALID JSON\n');

    // Then append a valid event
    const validEvent = makeEvent('assistant_task', 'NonExistentProject', 'watch-after-malformed', {
      fundamentalGoal: 'after malformed',
      executionApproach: 'noop',
      stopCondition: { successCriteria: 'never', failureCriteria: 'always' },
    });
    appendFileSync(eventsPath, JSON.stringify(validEvent) + '\n');

    const doneEvents = await waitForDoneEvent(eventsPath, 3000);
    daemon.stop();

    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
  });
});