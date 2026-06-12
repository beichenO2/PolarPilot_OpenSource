/**
 * Contract test — assistant-task / assistant-task-done schemas.
 *
 * 5 L1 checks ([Agent_core:W-TEST-9]):
 *   1. Schema consistency           — ajv compile both schemas without error.
 *   2. Example payload reachability — bundled example files validate.
 *   3. Consumer expectation         — runtime-shaped done event validates.
 *   4. Contract test pass           — this suite is wired into `npm test`.
 *   5. Breaking-change detection    — LobsterEvent.type union extension stays
 *      backward-compatible (old types can still be constructed & serialized).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv from 'ajv';
import type { AssistantTaskDone, LobsterEvent } from '../../src/pilot/types.js';
import type { AssistantTask } from '../../src/workflow/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractsRoot = join(__dirname, '..', '..', 'contracts');

const taskSchema = JSON.parse(
  readFileSync(join(contractsRoot, 'assistant-task.schema.json'), 'utf-8'),
) as Record<string, unknown>;
const doneSchema = JSON.parse(
  readFileSync(join(contractsRoot, 'assistant-task-done.schema.json'), 'utf-8'),
) as Record<string, unknown>;
const taskExample = JSON.parse(
  readFileSync(join(contractsRoot, 'examples', 'assistant-task.example.json'), 'utf-8'),
) as AssistantTask;
const doneExample = JSON.parse(
  readFileSync(join(contractsRoot, 'examples', 'assistant-task-done.example.json'), 'utf-8'),
) as AssistantTaskDone;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateTask = ajv.compile(taskSchema);
const validateDone = ajv.compile(doneSchema);

describe('assistant-task contract — L1 strong checks', () => {
  it('L1.1 Schema consistency: both schemas compile without error', () => {
    expect(typeof validateTask).toBe('function');
    expect(typeof validateDone).toBe('function');
  });

  it('L1.2 Example payload reachable: assistant-task.example.json validates', () => {
    const ok = validateTask(taskExample);
    expect(validateTask.errors ?? null).toBeNull();
    expect(ok).toBe(true);
  });

  it('L1.2 Example payload reachable: assistant-task-done.example.json validates', () => {
    const ok = validateDone(doneExample);
    expect(validateDone.errors ?? null).toBeNull();
    expect(ok).toBe(true);
  });

  it('L1.3 Consumer expectation: runtime-shaped done event passes schema', () => {
    const runtimeShaped: AssistantTaskDone = {
      task_id: 'assist-1747054800001',
      status: 'failure',
      summary: 'orchestrator aborted after 3 consecutive errors',
      artifacts: [],
      iterations: 3,
      tokens_used: 1234,
      started_at: new Date('2026-05-12T01:00:00Z').toISOString(),
      finished_at: new Date('2026-05-12T01:05:00Z').toISOString(),
      error: 'Agent permanent error: model unavailable',
    };
    const ok = validateDone(runtimeShaped);
    expect(validateDone.errors ?? null).toBeNull();
    expect(ok).toBe(true);
  });

  it('L1.3 Consumer expectation: missing required fields are rejected', () => {
    const bad = { task_id: 'x' } as unknown;
    const ok = validateDone(bad);
    expect(ok).toBe(false);
    expect(validateDone.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it('L1.3 Consumer expectation: unknown status enum rejected', () => {
    const bad = { ...doneExample, status: 'maybe' } as unknown;
    const ok = validateDone(bad);
    expect(ok).toBe(false);
  });

  it('L1.3 Consumer expectation: assistant-task missing fundamentalGoal rejected', () => {
    const { fundamentalGoal: _omit, ...rest } = taskExample;
    void _omit;
    const ok = validateTask(rest);
    expect(ok).toBe(false);
  });

  it('L1.5 Breaking change: pre-existing LobsterEvent types still construct & serialize', () => {
    const legacy: LobsterEvent = {
      ts: new Date().toISOString(),
      type: 'bug',
      source_project: 'PolarClaw',
      target_project: 'PolarPilot',
      severity: 'high',
      payload: { reason: 'baseline regression' },
      dedup_key: 'legacy:bug:1',
    };
    const ev: LobsterEvent = {
      ts: new Date().toISOString(),
      type: 'assistant_task_done',
      source_project: 'PolarPilot',
      target_project: 'PolarClaw',
      severity: 'info',
      payload: doneExample as unknown as Record<string, unknown>,
      dedup_key: `assist:${doneExample.task_id}:done`,
    };
    expect(() => JSON.stringify(legacy)).not.toThrow();
    expect(() => JSON.stringify(ev)).not.toThrow();
    expect(ev.type).toBe('assistant_task_done');
    expect(legacy.type).toBe('bug');
  });
});
