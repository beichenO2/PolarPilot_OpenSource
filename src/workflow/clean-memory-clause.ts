import type { Block } from './types.js';

// ── Layer numbering ──────────────────────────────────────────────
export const LAYER_SOUL = 1 as const;
export const LAYER_LONG_TERM = 2 as const;
export const LAYER_CONTEXT = 3 as const;
export const LAYER_SCRATCH = 4 as const;

export type LayerNumber = typeof LAYER_SOUL | typeof LAYER_LONG_TERM | typeof LAYER_CONTEXT | typeof LAYER_SCRATCH;

// ── Clean Memory Clause ──────────────────────────────────────────
//
// The privacy boundary rules that govern cross-layer data flow:
//
//   1. Layer 1 (Soul) is READ-ONLY — no writes allowed from any layer.
//   2. Layer 4 (Scratch) must NEVER be exposed to Layer 2 (Long-term).
//   3. Layer 3 (Context) can read from Layer 2 but not write to it.
//   4. Writes from Layer 4 → Layer 2 must go through sanitizeForLongTerm().
//   5. Writes from Layer 3 → Layer 2 must also go through sanitizeForLongTerm().
//
export const CLEAN_MEMORY_CLAUSE = `
## Clean Memory Clause

1. **Soul (Layer 1) is immutable.** No layer may write to PolarSoul.md.
   Any attempt to modify Layer 1 is a boundary violation.

2. **Scratch (Layer 4) must never leak into Long-term (Layer 2).**
   Ephemeral working data (temp files, intermediate calculations,
   debug logs) must not be persisted to PolarMemory blocks without
   sanitization that strips all temporary identifiers.

3. **Context (Layer 3) is read-write but cannot write to Long-term (Layer 2).**
   Checkpoint and step I/O may reference long-term knowledge but
   must not mutate it directly. Promoted learnings must go through
   the sanitizeForLongTerm() gate.

4. **Cross-layer writes require validation.** Any data flowing from
   Layer 3 or Layer 4 into Layer 2 must pass sanitizeForLongTerm()
   to strip ephemeral context, temporary file references, and
   session-specific identifiers.

5. **Layer 4 is auto-cleared.** On task completion or failure, all
   scratch data is deleted. No residual ephemeral data persists.
` as const;

// ── Boundary violation tracking ──────────────────────────────────
export interface MemoryBoundaryViolation {
  fromLayer: LayerNumber;
  toLayer: LayerNumber;
  description: string;
  timestamp: string;
}

// ── Validation ───────────────────────────────────────────────────

/** Returns true if a write from `fromLayer` to `toLayer` is allowed. */
export function validateMemoryWrite(fromLayer: LayerNumber, toLayer: LayerNumber): boolean {
  // No writes TO Layer 1 (Soul) from any layer
  if (toLayer === LAYER_SOUL) return false;

  // Same-layer writes are always allowed
  if (fromLayer === toLayer) return true;

  // Layer 4 → Layer 2 is forbidden (must go through sanitizeForLongTerm gate)
  if (fromLayer === LAYER_SCRATCH && toLayer === LAYER_LONG_TERM) return false;

  // Layer 3 → Layer 2 is forbidden (must go through sanitizeForLongTerm gate)
  if (fromLayer === LAYER_CONTEXT && toLayer === LAYER_LONG_TERM) return false;

  // All other cross-layer writes are allowed
  return true;
}

// ── Sanitization ─────────────────────────────────────────────────

const EPHEMERAL_PATTERNS = [
  /scratch[\\/][^\s]+/gi,
  /tmp[\\/][^\s]+/gi,
  /temp[\\/][^\s]+/gi,
  /\.tmp\b/gi,
  /session[_-]?id\s*[:=]\s*\S+/gi,
  /run[_-]?id\s*[:=]\s*\S+/gi,
  /step[_-]?(?:input|output)\.json/gi,
  /checkpoint\.json/gi,
];

/**
 * Strips ephemeral/temporary data from content before it can be
 * written to long-term memory (Layer 2).
 *
 * Removes:
 * - Scratch/tmp/temp file paths
 * - Session and run identifiers
 * - Step I/O and checkpoint file references
 */
export function sanitizeForLongTerm(scratchContent: string): string {
  let sanitized = scratchContent;
  for (const pattern of EPHEMERAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED-EPHEMERAL]');
  }
  // Collapse multiple consecutive redacted markers
  sanitized = sanitized.replace(/(\[REDACTED-EPHEMERAL]\s*){2,}/g, '[REDACTED-EPHEMERAL] ');
  return sanitized.trim();
}

// ── Boundary violation reporter ──────────────────────────────────

const sessionViolations: MemoryBoundaryViolation[] = [];

/** Record a boundary violation for the current session. */
export function recordViolation(
  fromLayer: LayerNumber,
  toLayer: LayerNumber,
  description: string,
): void {
  sessionViolations.push({
    fromLayer,
    toLayer,
    description,
    timestamp: new Date().toISOString(),
  });
}

/** Returns a report of all memory boundary violations in the current session. */
export function getMemoryBoundaryReport(): {
  violations: MemoryBoundaryViolation[];
  total: number;
  summary: string;
} {
  const total = sessionViolations.length;
  if (total === 0) {
    return {
      violations: [],
      total: 0,
      summary: 'No memory boundary violations in this session.',
    };
  }

  const byType = new Map<string, number>();
  for (const v of sessionViolations) {
    const key = `L${v.fromLayer}→L${v.toLayer}`;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }

  const details = [...byType.entries()]
    .map(([key, count]) => `  ${key}: ${count} violation(s)`)
    .join('\n');

  return {
    violations: [...sessionViolations],
    total,
    summary: `${total} memory boundary violation(s) found:\n${details}`,
  };
}

/** Clear session violations (useful for testing). */
export function clearViolations(): void {
  sessionViolations.length = 0;
}
