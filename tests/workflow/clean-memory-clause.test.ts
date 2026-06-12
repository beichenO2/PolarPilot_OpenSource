import { describe, it, expect, beforeEach } from 'vitest';
import {
  LAYER_SOUL,
  LAYER_LONG_TERM,
  LAYER_CONTEXT,
  LAYER_SCRATCH,
  CLEAN_MEMORY_CLAUSE,
  validateMemoryWrite,
  sanitizeForLongTerm,
  recordViolation,
  getMemoryBoundaryReport,
  clearViolations,
  type LayerNumber,
} from '../../src/workflow/clean-memory-clause.js';

describe('Clean Memory Clause', () => {
  beforeEach(() => {
    clearViolations();
  });

  describe('CLEAN_MEMORY_CLAUSE constant', () => {
    it('should define the clause text', () => {
      expect(CLEAN_MEMORY_CLAUSE).toContain('Soul');
      expect(CLEAN_MEMORY_CLAUSE).toContain('Layer 1');
      expect(CLEAN_MEMORY_CLAUSE).toContain('immutable');
      expect(CLEAN_MEMORY_CLAUSE).toContain('Scratch');
      expect(CLEAN_MEMORY_CLAUSE).toContain('Layer 4');
    });
  });

  describe('validateMemoryWrite', () => {
    it('should reject any write to Layer 1 (Soul)', () => {
      expect(validateMemoryWrite(LAYER_SOUL, LAYER_SOUL)).toBe(false);
      expect(validateMemoryWrite(LAYER_LONG_TERM, LAYER_SOUL)).toBe(false);
      expect(validateMemoryWrite(LAYER_CONTEXT, LAYER_SOUL)).toBe(false);
      expect(validateMemoryWrite(LAYER_SCRATCH, LAYER_SOUL)).toBe(false);
    });

    it('should allow same-layer writes', () => {
      expect(validateMemoryWrite(LAYER_SOUL, LAYER_SOUL)).toBe(false); // Soul is special — no writes at all
      expect(validateMemoryWrite(LAYER_LONG_TERM, LAYER_LONG_TERM)).toBe(true);
      expect(validateMemoryWrite(LAYER_CONTEXT, LAYER_CONTEXT)).toBe(true);
      expect(validateMemoryWrite(LAYER_SCRATCH, LAYER_SCRATCH)).toBe(true);
    });

    it('should reject Layer 4 → Layer 2 writes', () => {
      expect(validateMemoryWrite(LAYER_SCRATCH, LAYER_LONG_TERM)).toBe(false);
    });

    it('should reject Layer 3 → Layer 2 writes', () => {
      expect(validateMemoryWrite(LAYER_CONTEXT, LAYER_LONG_TERM)).toBe(false);
    });

    it('should allow Layer 2 → Layer 3 writes', () => {
      expect(validateMemoryWrite(LAYER_LONG_TERM, LAYER_CONTEXT)).toBe(true);
    });

    it('should allow Layer 2 → Layer 4 writes', () => {
      expect(validateMemoryWrite(LAYER_LONG_TERM, LAYER_SCRATCH)).toBe(true);
    });

    it('should allow Layer 3 → Layer 4 writes', () => {
      expect(validateMemoryWrite(LAYER_CONTEXT, LAYER_SCRATCH)).toBe(true);
    });

    it('should allow Layer 4 → Layer 3 writes', () => {
      expect(validateMemoryWrite(LAYER_SCRATCH, LAYER_CONTEXT)).toBe(true);
    });
  });

  describe('sanitizeForLongTerm', () => {
    it('should strip scratch directory paths', () => {
      const input = 'Result saved to /tmp/scratch/output.txt for review';
      const result = sanitizeForLongTerm(input);
      expect(result).not.toContain('/tmp/scratch/output.txt');
      expect(result).toContain('[REDACTED-EPHEMERAL]');
    });

    it('should strip temp file paths', () => {
      const input = 'Intermediate data at temp/data.json was processed';
      const result = sanitizeForLongTerm(input);
      expect(result).not.toContain('temp/data.json');
      expect(result).toContain('[REDACTED-EPHEMERAL]');
    });

    it('should strip session identifiers', () => {
      const input = 'Session_id: abc123 was used for this computation';
      const result = sanitizeForLongTerm(input);
      expect(result).not.toContain('abc123');
      expect(result).toContain('[REDACTED-EPHEMERAL]');
    });

    it('should strip run identifiers', () => {
      const input = 'Run_id=xyz789 completed successfully';
      const result = sanitizeForLongTerm(input);
      expect(result).not.toContain('xyz789');
      expect(result).toContain('[REDACTED-EPHEMERAL]');
    });

    it('should strip step I/O file references', () => {
      const input = 'See step_input.json and step_output.json for details';
      const result = sanitizeForLongTerm(input);
      expect(result).not.toContain('step_input.json');
      expect(result).not.toContain('step_output.json');
    });

    it('should strip checkpoint file references', () => {
      const input = 'State saved in checkpoint.json';
      const result = sanitizeForLongTerm(input);
      expect(result).not.toContain('checkpoint.json');
    });

    it('should preserve clean content', () => {
      const input = 'The system architecture uses a microservices pattern with event sourcing.';
      const result = sanitizeForLongTerm(input);
      expect(result).toBe(input);
    });

    it('should collapse multiple consecutive redacted markers', () => {
      const input = 'scratch/a.txt scratch/b.txt scratch/c.txt';
      const result = sanitizeForLongTerm(input);
      // Should not have 3 consecutive markers
      expect(result).not.toMatch(/(\[REDACTED-EPHEMERAL]\s*){3}/);
    });

    it('should handle empty string', () => {
      expect(sanitizeForLongTerm('')).toBe('');
    });
  });

  describe('Memory boundary violation tracking', () => {
    it('should start with no violations', () => {
      const report = getMemoryBoundaryReport();
      expect(report.total).toBe(0);
      expect(report.violations).toEqual([]);
      expect(report.summary).toContain('No memory boundary violations');
    });

    it('should record and report violations', () => {
      recordViolation(LAYER_SCRATCH, LAYER_LONG_TERM, 'Attempted to write scratch data to long-term memory');
      recordViolation(LAYER_CONTEXT, LAYER_SOUL, 'Attempted to modify soul');

      const report = getMemoryBoundaryReport();
      expect(report.total).toBe(2);
      expect(report.violations.length).toBe(2);
      expect(report.summary).toContain('2 memory boundary violation(s)');
    });

    it('should include layer numbers in violation entries', () => {
      recordViolation(LAYER_SCRATCH, LAYER_LONG_TERM, 'test violation');

      const report = getMemoryBoundaryReport();
      expect(report.violations[0].fromLayer).toBe(LAYER_SCRATCH);
      expect(report.violations[0].toLayer).toBe(LAYER_LONG_TERM);
      expect(report.violations[0].timestamp).toBeTruthy();
    });

    it('should group violations by type in summary', () => {
      recordViolation(LAYER_SCRATCH, LAYER_LONG_TERM, 'first');
      recordViolation(LAYER_SCRATCH, LAYER_LONG_TERM, 'second');
      recordViolation(LAYER_CONTEXT, LAYER_SOUL, 'third');

      const report = getMemoryBoundaryReport();
      expect(report.total).toBe(3);
      expect(report.summary).toContain('L4→L2: 2 violation(s)');
      expect(report.summary).toContain('L3→L1: 1 violation(s)');
    });

    it('should clear violations', () => {
      recordViolation(LAYER_SCRATCH, LAYER_LONG_TERM, 'test');
      clearViolations();
      const report = getMemoryBoundaryReport();
      expect(report.total).toBe(0);
    });
  });
});
