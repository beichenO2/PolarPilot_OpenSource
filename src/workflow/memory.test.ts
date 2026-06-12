import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryManager, type MemoryManagerConfig } from './memory.js';
import type { Checkpoint, StepInput, StepOutput } from './types.js';

describe('MemoryManager', () => {
  let tmpDir: string;
  let scratchDir: string;
  let soulPath: string;
  let config: MemoryManagerConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mem-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    scratchDir = join(tmpDir, 'scratch');
    soulPath = join(tmpDir, 'PolarSoul.md');

    writeFileSync(soulPath, '# Test Soul\n\nTest content');

    config = {
      soulPath,
      workflowPath: join(tmpDir, 'workflow.md'),
      scratchDir,
    };
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('should read Soul content', () => {
    const mm = createMemoryManager(config);
    const soul = mm.readSoul();
    expect(soul).toContain('Test Soul');
  });

  it('should return empty array when polarMemoryUrl not configured', async () => {
    const mm = createMemoryManager(config);
    const result = await mm.fetchLongTermMemory('test query');
    expect(result).toEqual([]);
  });

  it('should write and read checkpoint', () => {
    const mm = createMemoryManager(config);
    const cp: Checkpoint = {
      workflow_id: 'test-wf',
      current_step: 'S1',
      completed_steps: [],
      global_learnings: [],
      artifacts: {},
      updated_at: new Date().toISOString(),
    };

    mm.writeCheckpoint(cp);
    const read = mm.readCheckpoint();
    expect(read.workflow_id).toBe('test-wf');
    expect(read.current_step).toBe('S1');
  });

  it('should return default checkpoint when none exists', () => {
    const mm = createMemoryManager(config);
    const cp = mm.readCheckpoint();
    expect(cp.workflow_id).toBe('');
    expect(cp.completed_steps).toEqual([]);
  });

  it('should clear scratch on step start', () => {
    const mm = createMemoryManager(config);
    const input: StepInput = {
      step_id: 'S1',
      task: 'test task',
      context: 'test context',
      constraints: [],
    };

    mm.onStepStart(input);

    // step_input.json should exist
    const inputPath = join(scratchDir, 'step_input.json');
    expect(existsSync(inputPath)).toBe(true);
  });

  it('should archive checkpoint on task complete', () => {
    const mm = createMemoryManager(config);
    const cp: Checkpoint = {
      workflow_id: 'test-wf',
      current_step: 'END',
      completed_steps: ['S1', 'S2'],
      global_learnings: ['learned something'],
      artifacts: { S1: 'result.md' },
      updated_at: new Date().toISOString(),
    };

    mm.writeCheckpoint(cp);
    mm.onTaskComplete();

    // checkpoint.json should be cleared
    const checkpointPath = join(scratchDir, 'checkpoint.json');
    expect(existsSync(checkpointPath)).toBe(false);

    // history dir should have archived checkpoint
    const historyDir = join(scratchDir, 'history');
    expect(existsSync(historyDir)).toBe(true);
  });

  it('should preserve checkpoint on task failure', () => {
    const mm = createMemoryManager(config);
    const cp: Checkpoint = {
      workflow_id: 'test-wf',
      current_step: 'S1',
      completed_steps: [],
      global_learnings: [],
      artifacts: {},
      updated_at: new Date().toISOString(),
    };

    mm.writeCheckpoint(cp);
    mm.onTaskFailure();

    // checkpoint.json should still exist
    const checkpointPath = join(scratchDir, 'checkpoint.json');
    expect(existsSync(checkpointPath)).toBe(true);
  });

  it('should refresh checkpoint and recover from corruption', () => {
    const mm = createMemoryManager(config);
    const checkpointPath = join(scratchDir, 'checkpoint.json');

    // Write corrupted checkpoint
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify({ workflow_id: 123, bad_field: true }));

    const cp = mm.refreshCheckpoint();
    expect(cp.workflow_id).toBe(''); // recovered default
    expect(cp.completed_steps).toEqual([]);
    expect(cp.current_step).toBe('');
  });

  it('should refresh checkpoint and return valid data', () => {
    const mm = createMemoryManager(config);
    const cp: Checkpoint = {
      workflow_id: 'test-wf',
      current_step: 'S2',
      completed_steps: ['S1'],
      global_learnings: ['learned'],
      artifacts: {},
      updated_at: new Date().toISOString(),
    };
    mm.writeCheckpoint(cp);

    const refreshed = mm.refreshCheckpoint();
    expect(refreshed.workflow_id).toBe('test-wf');
    expect(refreshed.current_step).toBe('S2');
    expect(refreshed.completed_steps).toEqual(['S1']);
  });

  it('should archive step output on onStepEnd', () => {
    const mm = createMemoryManager(config);
    const cp: Checkpoint = {
      workflow_id: 'test-wf',
      current_step: 'S1',
      completed_steps: [],
      global_learnings: [],
      artifacts: {},
      updated_at: new Date().toISOString(),
    };
    mm.writeCheckpoint(cp);

    // Write a step output
    const output: StepOutput = {
      step_id: 'S1',
      result: 'success',
      summary: 'did something',
      artifacts: ['result.md'],
      learnings: ['learned X'],
      next_hint: 'S2',
    };
    const stepOutputPath = join(scratchDir, 'step_output.json');
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(stepOutputPath, JSON.stringify(output, null, 2));

    mm.onStepEnd();

    // History should have the step archive
    const historyDir = join(scratchDir, 'history');
    expect(existsSync(historyDir)).toBe(true);
    const files = readdirSync(historyDir).filter(f => f.startsWith('step-'));
    expect(files.length).toBe(1);
  });

  it('should write final summary checkpoint on onTaskComplete', () => {
    const mm = createMemoryManager(config);
    const cp: Checkpoint = {
      workflow_id: 'test-wf',
      current_step: 'END',
      completed_steps: ['S1', 'S2'],
      global_learnings: ['learned something'],
      artifacts: { S1: 'result.md' },
      updated_at: new Date().toISOString(),
    };
    mm.writeCheckpoint(cp);

    mm.onTaskComplete();

    // History should have the archived checkpoint with __COMPLETE__
    const historyDir = join(scratchDir, 'history');
    expect(existsSync(historyDir)).toBe(true);
    const files = readdirSync(historyDir).filter(f => f.startsWith('checkpoint-'));
    expect(files.length).toBe(1);
    const archived = JSON.parse(readFileSync(join(historyDir, files[0]), 'utf-8')) as Checkpoint;
    expect(archived.current_step).toBe('__COMPLETE__');
  });
});