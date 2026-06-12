/**
 * Smoke test for daemon.processEvent routing of `assistant_task` events.
 *
 * Verifies that when daemon receives a LobsterEvent of type `assistant_task`
 * targeted at a managed project, it dispatches to `runAssistantTask` (via
 * the daemon's own processEvent), which writes an `assistant_task_done`
 * entry into the events file. We deliberately point the daemon at a
 * non-existent project cwd to force the orchestrator to short-circuit
 * into the failure branch (no external agent process is spawned).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createDaemon } from '../../src/pilot/daemon.js';
import type { LobsterEvent } from '../../src/pilot/types.js';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function setupTmp(): { eventsPath: string; polarisorRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'pp-daemon-route-'));
  created.push(root);
  const eventsPath = join(root, 'lobster-events.jsonl');
  writeFileSync(eventsPath, '');
  return { eventsPath, polarisorRoot: root };
}

describe('daemon.processEvent → assistant_task routing', () => {
  it('writes an assistant_task_done event when given an assistant_task targeted at a managed project', async () => {
    const { eventsPath, polarisorRoot } = setupTmp();

    const daemon = createDaemon({
      eventsPath,
      polarisorRoot,
      dedupWindowMs: 60_000,
      healthScanHour: 99, // never fires inside the test
      managedProjects: ['NonExistentProject'],
    });

    const evt: LobsterEvent = {
      ts: new Date().toISOString(),
      type: 'assistant_task',
      source_project: 'PolarClaw',
      target_project: 'NonExistentProject',
      severity: 'info',
      payload: {
        fundamentalGoal: 'unit-test goal',
        executionApproach: 'noop',
        stopCondition: { successCriteria: 'never', failureCriteria: 'always' },
      },
      dedup_key: 'unit-test:assist-1',
    };

    daemon.processEvent(evt);

    const deadline = Date.now() + 5000;
    let donePayload: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      const raw = readFileSync(eventsPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of raw) {
        try {
          const ev = JSON.parse(line) as LobsterEvent;
          if (ev.type === 'assistant_task_done') {
            donePayload = ev.payload as Record<string, unknown>;
            break;
          }
        } catch { /* skip */ }
      }
      if (donePayload) break;
    }

    expect(donePayload).not.toBeNull();
    expect(donePayload!.status).toBe('failure');
    expect(typeof donePayload!.task_id).toBe('string');
    expect(donePayload!.task_id).toMatch(/^assist-|unit-test/);
  });

  it('ignores events targeted at unmanaged projects without writing a done event', async () => {
    const { eventsPath, polarisorRoot } = setupTmp();
    const daemon = createDaemon({
      eventsPath,
      polarisorRoot,
      dedupWindowMs: 60_000,
      healthScanHour: 99,
      managedProjects: ['OnlyThis'],
    });

    daemon.processEvent({
      ts: new Date().toISOString(),
      type: 'assistant_task',
      source_project: 'PolarClaw',
      target_project: 'SomethingElse',
      severity: 'info',
      payload: { fundamentalGoal: 'x', executionApproach: 'y', stopCondition: { successCriteria: 'a', failureCriteria: 'b' } },
      dedup_key: 'unit-test:ignored',
    });

    await new Promise(r => setTimeout(r, 500));
    const raw = readFileSync(eventsPath, 'utf-8');
    expect(raw).not.toContain('assistant_task_done');
  });
});
