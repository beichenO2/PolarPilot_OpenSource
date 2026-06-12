import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createFourLayerMemoryManager,
  LAYER_SOUL,
  LAYER_LONG_TERM,
  LAYER_CONTEXT,
  LAYER_SCRATCH,
  type FourLayerMemoryConfig,
} from '../../src/workflow/four-layer-memory.js';
import { clearViolations } from '../../src/workflow/clean-memory-clause.js';
import type { Checkpoint, StepOutput } from '../../src/workflow/types.js';

describe('FourLayerMemoryManager', () => {
  let tmpDir: string;
  let scratchDir: string;
  let soulPath: string;
  let config: FourLayerMemoryConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `flm-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    scratchDir = join(tmpDir, 'scratch');
    soulPath = join(tmpDir, 'PolarSoul.md');
    writeFileSync(soulPath, '# Test Soul\n\nI am PolarPilot.');
    config = { soulPath, workflowPath: join(tmpDir, 'workflow.md'), scratchDir };
    clearViolations();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  describe('getSoulLayer (Layer 1)', () => {
    it('should return soul content', () => {
      const mm = createFourLayerMemoryManager(config);
      const soul = mm.getSoulLayer();
      expect(soul.layer).toBe(LAYER_SOUL);
      expect(soul.content).toContain('Test Soul');
      expect(soul.content).toContain('PolarPilot');
    });
  });

  describe('getLongTermLayer (Layer 2)', () => {
    it('should return empty blocks when no polarMemoryUrl', async () => {
      const mm = createFourLayerMemoryManager(config);
      const lt = await mm.getLongTermLayer('test');
      expect(lt.layer).toBe(LAYER_LONG_TERM);
      expect(lt.blocks).toEqual([]);
      expect(lt.query).toBe('test');
    });
  });

  describe('getContextLayer (Layer 3)', () => {
    it('should return default checkpoint when none exists', () => {
      const mm = createFourLayerMemoryManager(config);
      const ctx = mm.getContextLayer();
      expect(ctx.layer).toBe(LAYER_CONTEXT);
      expect(ctx.checkpoint.workflow_id).toBe('');
      expect(ctx.recentStepOutputs).toEqual([]);
    });

    it('should return checkpoint with data', () => {
      const mm = createFourLayerMemoryManager(config);
      const cp: Checkpoint = {
        workflow_id: 'wf-1', current_step: 'S2',
        completed_steps: ['S1'], global_learnings: ['x'],
        artifacts: {}, updated_at: new Date().toISOString(),
      };
      mm.getInner().writeCheckpoint(cp);
      const ctx = mm.getContextLayer();
      expect(ctx.checkpoint.workflow_id).toBe('wf-1');
      expect(ctx.checkpoint.completed_steps).toEqual(['S1']);
    });

    it('should include recent step outputs from history', () => {
      const mm = createFourLayerMemoryManager(config);
      const inner = mm.getInner();
      const cp: Checkpoint = {
        workflow_id: 'wf-1', current_step: 'S1',
        completed_steps: [], global_learnings: [],
        artifacts: {}, updated_at: new Date().toISOString(),
      };
      inner.writeCheckpoint(cp);
      const out: StepOutput = {
        step_id: 'S1', result: 'success', summary: 'done',
        artifacts: [], learnings: [], next_hint: 'S2',
      };
      mkdirSync(join(scratchDir, 'history'), { recursive: true });
      writeFileSync(join(scratchDir, 'history', 'step-S1-1.json'), JSON.stringify(out));
      const ctx = mm.getContextLayer();
      expect(ctx.recentStepOutputs.length).toBe(1);
      expect(ctx.recentStepOutputs[0].step_id).toBe('S1');
    });
  });

  describe('getScratchLayer (Layer 4)', () => {
    it('should return empty files when scratch is empty', () => {
      const mm = createFourLayerMemoryManager(config);
      const scratch = mm.getScratchLayer();
      expect(scratch.layer).toBe(LAYER_SCRATCH);
      expect(Object.keys(scratch.files).length).toBe(0);
    });

    it('should return scratch file contents', () => {
      mkdirSync(scratchDir, { recursive: true });
      writeFileSync(join(scratchDir, 'temp.txt'), 'hello world');
      const mm = createFourLayerMemoryManager(config);
      const scratch = mm.getScratchLayer();
      expect(scratch.files['temp.txt']).toBe('hello world');
    });

    it('should exclude history directory from scratch files', () => {
      mkdirSync(scratchDir, { recursive: true });
      mkdirSync(join(scratchDir, 'history'), { recursive: true });
      writeFileSync(join(scratchDir, 'temp.txt'), 'data');
      writeFileSync(join(scratchDir, 'history', 'step-1.json'), '{}');
      const mm = createFourLayerMemoryManager(config);
      const scratch = mm.getScratchLayer();
      expect(scratch.files['temp.txt']).toBe('data');
      expect(scratch.files['history']).toBeUndefined();
    });
  });

  describe('buildFullContext', () => {
    it('should assemble all 4 layers', async () => {
      const mm = createFourLayerMemoryManager(config);
      const ctx = await mm.buildFullContext('test query');
      expect(ctx).toContain('LAYER 1: SOUL');
      expect(ctx).toContain('Test Soul');
      expect(ctx).toContain('LAYER 2: LONG-TERM MEMORY');
      expect(ctx).toContain('LAYER 3: CONTEXT');
      expect(ctx).toContain('LAYER 4: SCRATCH');
    });

    it('should include soul content in full context', async () => {
      const mm = createFourLayerMemoryManager(config);
      const ctx = await mm.buildFullContext('query');
      expect(ctx).toContain('PolarPilot');
    });

    it('should include checkpoint data in full context', async () => {
      const mm = createFourLayerMemoryManager(config);
      mm.getInner().writeCheckpoint({
        workflow_id: 'wf-99', current_step: 'S3',
        completed_steps: ['S1', 'S2'], global_learnings: ['learned a'],
        artifacts: {}, updated_at: new Date().toISOString(),
      });
      const ctx = await mm.buildFullContext('query');
      expect(ctx).toContain('wf-99');
      expect(ctx).toContain('S3');
    });
  });

  describe('enforceCleanMemoryClause', () => {
    it('should return clause text and report', () => {
      const mm = createFourLayerMemoryManager(config);
      const { clause, report } = mm.enforceCleanMemoryClause();
      expect(clause).toContain('Clean Memory Clause');
      expect(report.total).toBe(0);
    });
  });

  describe('getInner', () => {
    it('should return the underlying MemoryManager', () => {
      const mm = createFourLayerMemoryManager(config);
      const inner = mm.getInner();
      expect(inner.readSoul).toBeDefined();
      expect(inner.fetchLongTermMemory).toBeDefined();
      expect(inner.refreshCheckpoint).toBeDefined();
    });
  });
});
