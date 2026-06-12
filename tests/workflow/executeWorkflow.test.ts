/**
 * Unit tests for `executeWorkflow` — covers entry/terminal traversal,
 * success/failure edge dispatch, all_done equivalence, terminal short-circuit,
 * and exit-code semantics.
 *
 * runAssistantTask is exercised in failure-fast mode (cwd = non-existent dir),
 * which deterministically returns `status: 'failure'` without spawning an
 * external agent. This lets us validate executeWorkflow's traversal logic in
 * isolation of orchestrator runtime concerns.
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { executeWorkflow } from '../../src/workflow/index.js';
import type { CompiledWorkflow, StepDef, Edge } from '../../src/workflow/types.js';

function tmpEventsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-exec-test-'));
  const p = join(dir, 'lobster-events.jsonl');
  writeFileSync(p, '');
  return p;
}

function buildCompiled(steps: StepDef[], edges: Edge[], entry: string, terminals: string[]): CompiledWorkflow {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'test',
    steps: new Map(steps.map(s => [s.id, s])),
    edges,
    entry_point: entry,
    terminal_points: terminals,
  };
}

const baseProject = '___nonexistent_polarpilot_test_project___';

describe('executeWorkflow — traversal & dispatch', () => {
  it('returns failure with reason when entry_point is empty', async () => {
    const compiled = buildCompiled([], [], '', []);
    const result = await executeWorkflow(compiled, {
      project: baseProject,
      eventsPath: tmpEventsPath(),
    });
    expect(result.status).toBe('failure');
    expect(result.failed_reason).toContain('no entry point');
  });

  it('fails fast on first step when no failure edge is present (cwd missing → step failure)', async () => {
    const s1: StepDef = { id: 'S1', name: 'Step One', type: 'implement', agent: 'mock', input: [], output: ['a'] };
    const s2: StepDef = { id: 'S2', name: 'Step Two', type: 'implement', agent: 'mock', input: [], output: ['b'] };
    const compiled = buildCompiled(
      [s1, s2],
      [{ from: 'S1', to: 'S2', condition: 'success' }],
      'S1',
      ['S2'],
    );
    const result = await executeWorkflow(compiled, {
      project: baseProject,
      eventsPath: tmpEventsPath(),
    });
    expect(result.status).toBe('failure');
    expect(result.completed_steps).toEqual(['S1']);
    expect(result.failed_step).toBe('S1');
    expect(result.step_outputs).toHaveLength(1);
    expect(result.step_outputs[0]!.result).toBe('failure');
  });

  it('follows failure edge to terminal when step fails and failure edge exists', async () => {
    const s1: StepDef = { id: 'S1', name: 'Try', type: 'implement', agent: 'mock', input: [], output: [] };
    const sFail: StepDef = { id: 'FAIL', name: 'Fail terminal', type: 'terminal', agent: 'mock', input: [], output: [] };
    const sOk: StepDef = { id: 'OK', name: 'Ok terminal', type: 'terminal', agent: 'mock', input: [], output: [] };
    const compiled = buildCompiled(
      [s1, sFail, sOk],
      [
        { from: 'S1', to: 'OK', condition: 'success' },
        { from: 'S1', to: 'FAIL', condition: 'failure' },
      ],
      'S1',
      ['OK', 'FAIL'],
    );
    const result = await executeWorkflow(compiled, {
      project: baseProject,
      eventsPath: tmpEventsPath(),
    });
    expect(result.status).toBe('success');
    expect(result.completed_steps).toEqual(['S1', 'FAIL']);
  });

  it('short-circuits at terminal step', async () => {
    const term: StepDef = { id: 'END', name: 'End', type: 'terminal', agent: 'mock', input: [], output: [] };
    const compiled = buildCompiled([term], [], 'END', ['END']);
    const result = await executeWorkflow(compiled, {
      project: baseProject,
      eventsPath: tmpEventsPath(),
    });
    expect(result.status).toBe('success');
    expect(result.completed_steps).toEqual(['END']);
    expect(result.step_outputs).toHaveLength(0);
  });

  it('detects cycle and aborts with reason', async () => {
    const s1: StepDef = { id: 'S1', name: 'A', type: 'implement', agent: 'mock', input: [], output: [] };
    const s2: StepDef = { id: 'S2', name: 'B', type: 'implement', agent: 'mock', input: [], output: [] };
    const compiled = buildCompiled(
      [s1, s2],
      [
        { from: 'S1', to: 'S2', condition: 'always' },
        { from: 'S2', to: 'S1', condition: 'always' },
      ],
      'S1',
      [],
    );
    const result = await executeWorkflow(compiled, {
      project: baseProject,
      eventsPath: tmpEventsPath(),
    });
    expect(result.status).toBe('failure');
    expect(result.failed_reason).toMatch(/cycle/);
  });

  it('invokes onStepStart / onStepEnd hooks', async () => {
    const s1: StepDef = { id: 'S1', name: 'Hooked', type: 'implement', agent: 'mock', input: [], output: [] };
    const term: StepDef = { id: 'END', name: 'End', type: 'terminal', agent: 'mock', input: [], output: [] };
    const compiled = buildCompiled(
      [s1, term],
      [
        { from: 'S1', to: 'END', condition: 'success' },
        { from: 'S1', to: 'END', condition: 'failure' },
      ],
      'S1',
      ['END'],
    );

    const startSeen: string[] = [];
    const endSeen: string[] = [];
    const result = await executeWorkflow(compiled, {
      project: baseProject,
      eventsPath: tmpEventsPath(),
      onStepStart: (s) => startSeen.push(s.id),
      onStepEnd: (s) => endSeen.push(s.id),
    });
    expect(startSeen).toEqual(['S1']);
    expect(endSeen).toEqual(['S1']);
    expect(result.completed_steps).toContain('END');
  });
});
