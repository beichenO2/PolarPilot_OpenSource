import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTargetStore } from './targets';
import { createStateMachine } from './state-machine';
import { selectPattern, resetPatternCache } from '../templates/pattern-router';
import { buildIterationPrompt } from '../templates/iteration-prompt';
import { buildReviewPrompt } from '../templates/review-prompt';
import type { Target } from './types';

let tmpDir: string;
let store: ReturnType<typeof createTargetStore>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sm-test-'));
  store = createTargetStore({ targetsDir: tmpDir });
});

describe('StateMachine', () => {
  it('findTarget with no targets suggests create_root', () => {
    const sm = createStateMachine({ project: 'test', targetStore: store });
    const result = sm.findTarget();
    expect(result.suggestion).toBe('create_root');
  });

  it('selectShootTarget returns active leaf', () => {
    const sm = createStateMachine({ project: 'test', targetStore: store });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'Root target' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'Leaf target', parent_id: 'root-1', leaf_test: 'npm test' });
    const target = sm.selectShootTarget();
    expect(target).not.toBeNull();
    expect(target!.id).toBe('leaf-1');
  });

  it('processShot hit completes target', async () => {
    const sm = createStateMachine({ project: 'test', targetStore: store });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    const result = await sm.processShot('leaf-1', 'hit', 'passed');
    expect(result.flags).toContain('completed');
    expect(store.get('leaf-1')!.status).toBe('completed');
  });

  it('processShot miss triggers route_broken after threshold', async () => {
    const sm = createStateMachine({ project: 'test', targetStore: store });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    await sm.processShot('leaf-1', 'miss', 'missed 1');
    await sm.processShot('leaf-1', 'miss', 'missed 2');
    const result = await sm.processShot('leaf-1', 'miss', 'missed 3');
    expect(result.flags).toContain('route_broken');
  });

  it('moveBoard resets route_broken counter', async () => {
    const sm = createStateMachine({ project: 'test', targetStore: store });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    await sm.processShot('leaf-1', 'miss', 'missed');
    sm.moveBoard('leaf-1', 'Updated Leaf', 'new desc');
    const t = store.get('leaf-1')!;
    expect(t.stop_conditions.route_broken.current).toBe(0);
    expect(t.stop_conditions.unreachable.moveboard_count).toBe(1);
  });

  it('processShot hit + review approved → completed', async () => {
    const reviewFn = vi.fn().mockResolvedValue({ approved: true, feedback: 'Looks good' });
    const sm = createStateMachine({
      project: 'test', targetStore: store,
      review_enabled: true, cwd: '/tmp', reviewFn,
    });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    const result = await sm.processShot('leaf-1', 'hit', 'all tests pass');
    expect(result.flags).toContain('completed');
    expect(store.get('leaf-1')!.status).toBe('completed');
    expect(reviewFn).toHaveBeenCalledOnce();
  });

  it('processShot hit + review rejected → MoveBoard without route_broken', async () => {
    const reviewFn = vi.fn().mockResolvedValue({ approved: false, feedback: 'Test is trivial' });
    const sm = createStateMachine({
      project: 'test', targetStore: store,
      review_enabled: true, cwd: '/tmp', reviewFn,
    });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    const result = await sm.processShot('leaf-1', 'hit', 'superficial fix');
    expect(result.flags).toContain('review_rejected');
    expect(result.next_step).toBe('move_board');
    expect(store.get('leaf-1')!.status).toBe('active');
    expect(store.get('leaf-1')!.stop_conditions.route_broken.current).toBe(0);
  });

  it('processShot hit + review_enabled=false → direct completed', async () => {
    const reviewFn = vi.fn();
    const sm = createStateMachine({
      project: 'test', targetStore: store,
      review_enabled: false, cwd: '/tmp', reviewFn,
    });
    store.create({ id: 'root-1', type: 'root_target', title: 'Root', description: 'desc' });
    store.create({ id: 'leaf-1', type: 'test_target', title: 'Leaf', description: 'desc', parent_id: 'root-1' });
    const result = await sm.processShot('leaf-1', 'hit', 'passed');
    expect(result.flags).toContain('completed');
    expect(reviewFn).not.toHaveBeenCalled();
  });
});

describe('Pattern Router', () => {
  let patternsDir: string;

  beforeEach(() => {
    resetPatternCache();
    patternsDir = mkdtempSync(join(tmpdir(), 'patterns-test-'));

    writeFileSync(join(patternsDir, 'test-first.json'), JSON.stringify({
      name: 'test-first',
      tags: ['test', 'tdd'],
      description: 'Write tests first',
      steps: ['Write test', 'Implement', 'Refactor'],
      applicable_types: ['test_target'],
    }));

    writeFileSync(join(patternsDir, 'bug-fix.json'), JSON.stringify({
      name: 'bug-fix',
      tags: ['bug', 'fix', 'debug'],
      description: 'Bug localization',
      steps: ['Reproduce', 'Isolate', 'Fix'],
      applicable_types: ['test_target'],
    }));
  });

  function makeTarget(overrides: Partial<Target> = {}): Target {
    return {
      id: 't-1', type: 'test_target', title: 'Test', description: 'A test target',
      parent_id: null, children_ids: [], status: 'active',
      stop_conditions: { route_broken: { n_failed_shots: 3, current: 0 }, data_missing: { depends_on: [] }, human_intervention: { irreversible_actions: [], auth_needed: [] }, unreachable: { m_total_shots: 5, current: 0, moveboard_count: 0 }, completed: {} },
      polaris_feature_ref: null, arrow_logs: [], created_at: '', updated_at: '',
      ...overrides,
    };
  }

  it('matches by suggested_pattern (exact name)', () => {
    const t = makeTarget({ suggested_pattern: 'bug-fix' });
    const p = selectPattern(t, patternsDir);
    expect(p).not.toBeNull();
    expect(p!.name).toBe('bug-fix');
  });

  it('matches by applicable_types', () => {
    const t = makeTarget({ type: 'test_target' });
    const p = selectPattern(t, patternsDir);
    expect(p).not.toBeNull();
  });

  it('matches by tag keywords in description', () => {
    resetPatternCache();
    const t = makeTarget({ title: 'Fix bug in auth', description: 'debug the login crash' });
    const p = selectPattern(t, patternsDir);
    expect(p).not.toBeNull();
    expect(p!.name).toBe('bug-fix');
  });

  it('returns null when no patterns exist', () => {
    resetPatternCache();
    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-patterns-'));
    const t = makeTarget();
    const p = selectPattern(t, emptyDir);
    expect(p).toBeNull();
  });
});

describe('Iteration Prompt Pattern Injection', () => {
  it('injects pattern steps when target matches', () => {
    const prompt = buildIterationPrompt({
      n: 1, runId: 'run-1', prompt: 'Fix the bug',
      target: { id: 't-1', title: 'Fix bug', description: 'debug the crash', type: 'test_target' },
    });
    expect(prompt).toContain('Iteration 1');
    expect(prompt).toContain('Fix the bug');
  });

  it('works without target', () => {
    const prompt = buildIterationPrompt({ n: 1, runId: 'run-1', prompt: 'Do something' });
    expect(prompt).toContain('Iteration 1');
    expect(prompt).not.toContain('Thinking Framework');
  });
});

describe('Review Prompt', () => {
  it('contains fresh-eyes instruction', () => {
    const t: Target = {
      id: 't-1', type: 'test_target', title: 'Test', description: 'Test target',
      parent_id: null, children_ids: [], status: 'active',
      stop_conditions: { route_broken: { n_failed_shots: 3, current: 0 }, data_missing: { depends_on: [] }, human_intervention: { irreversible_actions: [], auth_needed: [] }, unreachable: { m_total_shots: 5, current: 0, moveboard_count: 0 }, completed: {} },
      polaris_feature_ref: null, arrow_logs: [], created_at: '', updated_at: '',
    };
    const prompt = buildReviewPrompt(t, 'added a function');
    expect(prompt).toContain('FIRST TIME');
    expect(prompt).toContain('approved');
    expect(prompt).toContain('added a function');
  });
});
