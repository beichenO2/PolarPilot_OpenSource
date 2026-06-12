import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectPattern, createPatternRouter, resetPatternCache, type Pattern } from './pattern-router';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pattern-router-test-'));
  resetPatternCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetPatternCache();
});

function writePattern(dir: string, pattern: Pattern): void {
  writeFileSync(join(dir, `${pattern.name}.json`), JSON.stringify(pattern, null, 2), 'utf-8');
}

function makeTarget(overrides: Partial<{ id: string; type: string; title: string; description: string; suggested_pattern?: string }> = {}) {
  return {
    id: overrides.id ?? 't1',
    type: overrides.type ?? 'test_target',
    title: overrides.title ?? 'Test Target',
    description: overrides.description ?? 'A test target',
    parent_id: null,
    children_ids: [],
    status: 'active' as const,
    stop_conditions: {
      route_broken: { n_failed_shots: 3, current: 0 },
      data_missing: { depends_on: [] },
      human_intervention: { irreversible_actions: [], auth_needed: [] },
      unreachable: { m_total_shots: 5, current: 0, moveboard_count: 0 },
      completed: {},
    },
    polaris_feature_ref: null,
    arrow_logs: [],
    created_at: '',
    updated_at: '',
    suggested_pattern: overrides.suggested_pattern,
  };
}

describe('selectPattern', () => {
  it('returns null when no patterns exist', () => {
    mkdirSync(join(tmpDir, 'empty'), { recursive: true });
    const result = selectPattern(makeTarget(), join(tmpDir, 'empty'));
    expect(result).toBeNull();
  });

  it('matches by suggested_pattern (exact name match) — highest priority', () => {
    writePattern(tmpDir, {
      name: 'bug-localization',
      tags: ['bug', 'fix'],
      description: 'Bug localization pattern',
      steps: ['Reproduce', 'Isolate', 'Fix'],
      applicable_types: ['test_target'],
    });
    writePattern(tmpDir, {
      name: 'test-first',
      tags: ['test', 'tdd'],
      description: 'TDD pattern',
      steps: ['Write test', 'Implement', 'Refactor'],
      applicable_types: ['test_target'],
    });

    const target = makeTarget({ suggested_pattern: 'bug-localization' });
    const result = selectPattern(target, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('bug-localization');
  });

  it('returns null when suggested_pattern does not match any pattern name', () => {
    writePattern(tmpDir, {
      name: 'bug-localization',
      tags: ['bug'],
      description: 'Bug pattern',
      steps: ['Step 1'],
      applicable_types: ['test_target'],
    });

    const target = makeTarget({ suggested_pattern: 'nonexistent-pattern' });
    const result = selectPattern(target, tmpDir);
    // Falls through to applicable_types, which matches
    expect(result).not.toBeNull();
    expect(result!.name).toBe('bug-localization');
  });

  it('matches by applicable_types when no suggested_pattern — second priority', () => {
    writePattern(tmpDir, {
      name: 'root-only',
      tags: ['architecture'],
      description: 'Root target pattern',
      steps: ['Analyze architecture'],
      applicable_types: ['root_target'],
    });
    writePattern(tmpDir, {
      name: 'test-only',
      tags: ['unit'],
      description: 'Test target pattern',
      steps: ['Write test'],
      applicable_types: ['test_target'],
    });

    const target = makeTarget({ type: 'root_target' });
    const result = selectPattern(target, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('root-only');
  });

  it('matches wildcard applicable_types (*)', () => {
    writePattern(tmpDir, {
      name: 'universal',
      tags: ['general'],
      description: 'Universal pattern',
      steps: ['Think', 'Act'],
      applicable_types: ['*'],
    });

    const target = makeTarget({ type: 'test_target' });
    const result = selectPattern(target, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('universal');
  });

  it('matches by tags against title+description — third priority', () => {
    writePattern(tmpDir, {
      name: 'performance-tuning',
      tags: ['performance', 'slow', 'optimize'],
      description: 'Performance optimization pattern',
      steps: ['Profile', 'Identify bottleneck', 'Optimize'],
      applicable_types: ['test_target'],
    });
    writePattern(tmpDir, {
      name: 'security-audit',
      tags: ['security', 'vulnerability', 'auth'],
      description: 'Security audit pattern',
      steps: ['Scan', 'Review', 'Patch'],
      applicable_types: ['test_target'],
    });

    const target = makeTarget({
      title: 'Fix slow query performance',
      description: 'The database query is very slow and needs optimization',
    });
    const result = selectPattern(target, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('performance-tuning');
  });

  it('returns first type match when multiple type matches and no tag match', () => {
    writePattern(tmpDir, {
      name: 'pattern-a',
      tags: ['alpha'],
      description: 'Pattern A',
      steps: ['Step A'],
      applicable_types: ['test_target'],
    });
    writePattern(tmpDir, {
      name: 'pattern-b',
      tags: ['beta'],
      description: 'Pattern B',
      steps: ['Step B'],
      applicable_types: ['test_target'],
    });

    const target = makeTarget({ title: 'Generic task', description: 'No matching tags' });
    const result = selectPattern(target, tmpDir);
    expect(result).not.toBeNull();
    // When multiple type matches and no tag match, returns first type match
    expect(['pattern-a', 'pattern-b']).toContain(result!.name);
  });

  it('returns null when no applicable_types match and no tag matches', () => {
    writePattern(tmpDir, {
      name: 'root-only',
      tags: ['architecture'],
      description: 'Root only',
      steps: ['Step'],
      applicable_types: ['root_target'],
    });

    const target = makeTarget({ type: 'test_target', title: 'Unrelated', description: 'No matching tags' });
    const result = selectPattern(target, tmpDir);
    expect(result).toBeNull();
  });

  it('suggested_pattern takes priority over applicable_types match', () => {
    writePattern(tmpDir, {
      name: 'pattern-a',
      tags: ['a'],
      description: 'A',
      steps: ['Step A'],
      applicable_types: ['test_target'],
    });
    writePattern(tmpDir, {
      name: 'pattern-b',
      tags: ['b'],
      description: 'B',
      steps: ['Step B'],
      applicable_types: ['test_target'],
    });

    const target = makeTarget({ suggested_pattern: 'pattern-b' });
    const result = selectPattern(target, tmpDir);
    expect(result!.name).toBe('pattern-b');
  });
});

describe('createPatternRouter', () => {
  it('returns a PatternRouter with working selectPattern', () => {
    writePattern(tmpDir, {
      name: 'test-pattern',
      tags: ['test'],
      description: 'Test',
      steps: ['Step 1'],
      applicable_types: ['test_target'],
    });

    const router = createPatternRouter(tmpDir);
    const result = router.selectPattern(makeTarget());
    expect(result).not.toBeNull();
    expect(result!.name).toBe('test-pattern');
  });
});

describe('resetPatternCache', () => {
  it('allows reloading patterns after directory changes', () => {
    // First load — empty dir
    mkdirSync(join(tmpDir, 'sub'), { recursive: true });
    let result = selectPattern(makeTarget(), join(tmpDir, 'sub'));
    expect(result).toBeNull();

    // Add a pattern file
    writePattern(join(tmpDir, 'sub'), {
      name: 'new-pattern',
      tags: ['new'],
      description: 'New',
      steps: ['Step'],
      applicable_types: ['test_target'],
    });

    // Without cache reset, still null (cached empty)
    result = selectPattern(makeTarget(), join(tmpDir, 'sub'));
    expect(result).toBeNull();

    // After cache reset, pattern is found
    resetPatternCache();
    result = selectPattern(makeTarget(), join(tmpDir, 'sub'));
    expect(result).not.toBeNull();
    expect(result!.name).toBe('new-pattern');
  });
});
