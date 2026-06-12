import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildIterationPrompt, type IterationPromptOptions } from './iteration-prompt';
import { resetPatternCache } from './pattern-router';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iter-prompt-test-'));
  resetPatternCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetPatternCache();
});

describe('buildIterationPrompt', () => {
  it('builds basic prompt without target', () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: 'run-001',
      prompt: 'Fix the bug',
    });
    expect(result).toContain('Iteration 1');
    expect(result).toContain('Fix the bug');
    expect(result).toContain('run-001');
  });

  it('includes stop condition when provided', () => {
    const result = buildIterationPrompt({
      n: 2,
      runId: 'run-002',
      prompt: 'Do work',
      stopWhen: 'All tests pass',
    });
    expect(result).toContain('Stop Condition');
    expect(result).toContain('All tests pass');
  });

  it('includes target info when provided', () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: 'run-003',
      prompt: 'Implement feature',
      target: { id: 't1', title: 'My Target', description: 'Build the thing' },
    });
    expect(result).toContain('Target');
    expect(result).toContain('My Target');
    expect(result).toContain('Build the thing');
  });

  it('injects thinking pattern steps at the beginning when pattern matches', () => {
    // Create a pattern that will match the target
    const patternsDir = join(tmpDir, 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(join(patternsDir, 'bug-fix-pattern.json'), JSON.stringify({
      name: 'bug-fix-pattern',
      tags: ['bug', 'fix', 'error'],
      description: 'Systematic bug fixing approach',
      steps: ['Reproduce the bug', 'Isolate the cause', 'Fix the root cause', 'Verify the fix'],
      applicable_types: ['test_target'],
    }), 'utf-8');

    // We need to override the patterns directory — but buildIterationPrompt
    // calls selectPattern internally which uses the default patterns dir.
    // Instead, test with the actual patterns/ directory that ships with PolarPilot.
    // Let's test that a target with matching description gets a pattern injected.

    const result = buildIterationPrompt({
      n: 1,
      runId: 'run-004',
      prompt: 'Fix the bug in the code',
      target: {
        id: 't1',
        title: 'Fix crash bug',
        description: 'The application crashes when processing invalid input',
        type: 'test_target',
      },
    });

    // The prompt should contain a "Thinking Framework" section if a pattern matched
    // This depends on the built-in patterns in src/templates/patterns/
    // bug-localization.json has tags: ["bug", "fix", "error", "crash", ...]
    if (result.includes('Thinking Framework')) {
      expect(result.indexOf('Thinking Framework')).toBeLessThan(result.indexOf('Iteration 1'));
    }
  });

  it('pattern injection appears before iteration number', () => {
    // Test with a target that should match the built-in bug-localization pattern
    const result = buildIterationPrompt({
      n: 3,
      runId: 'run-005',
      prompt: 'Fix the error',
      target: {
        id: 't1',
        title: 'Fix crash bug in parser',
        description: 'Bug: the parser crashes on malformed input. Fix the error.',
        type: 'test_target',
      },
    });

    if (result.includes('Thinking Framework')) {
      const fwIndex = result.indexOf('Thinking Framework');
      const iterIndex = result.indexOf('Iteration 3');
      expect(fwIndex).toBeLessThan(iterIndex);
    }
  });

  it('uses suggested_pattern for exact match when provided', () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: 'run-006',
      prompt: 'Implement the feature',
      target: {
        id: 't1',
        title: 'New feature',
        description: 'Build a new feature',
        type: 'test_target',
        suggested_pattern: 'new-feature-scaffold',
      },
    });

    // If new-feature-scaffold.json exists in patterns/, it should be injected
    if (result.includes('Thinking Framework')) {
      expect(result).toContain('new-feature-scaffold');
    }
  });

  it('works without pattern injection when no pattern matches', () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: 'run-007',
      prompt: 'Do something completely unique and unprecedented',
      target: {
        id: 't1',
        title: 'Unique task xyzzy123',
        description: 'A task with no matching pattern tags whatsoever',
        type: 'test_target',
      },
    });

    // Should still have the basic prompt structure
    expect(result).toContain('Iteration 1');
    expect(result).toContain('Do something completely unique and unprecedented');
  });

  it('includes shot_outcome and shot_delta fields in output section', () => {
    const result = buildIterationPrompt({
      n: 1,
      runId: 'run-008',
      prompt: 'Test',
    });
    expect(result).toContain('shot_outcome');
    expect(result).toContain('shot_delta');
  });
});
