import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Target } from '../pilot/types.js';

export interface Pattern {
  name: string;
  tags: string[];
  description: string;
  steps: string[];
  applicable_types: string[];
  version?: string;
}

export interface PatternRouter {
  selectPattern(target: Target): Pattern | null;
}

let cachedPatterns: Pattern[] | null = null;

function loadPatterns(patternsDir?: string): Pattern[] {
  if (cachedPatterns) return cachedPatterns;

  const dir = patternsDir ?? join(
    dirname(fileURLToPath(import.meta.url)),
    'patterns',
  );

  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    cachedPatterns = files.map(f => {
      const raw = readFileSync(join(dir, f), 'utf-8');
      return JSON.parse(raw) as Pattern;
    });
  } catch {
    cachedPatterns = [];
  }

  return cachedPatterns;
}

/**
 * Select the best thinking pattern for a target.
 *
 * Priority:
 *   1. suggested_pattern (exact name match)
 *   2. applicable_types (target.type match)
 *   3. tags (keyword match against target.description)
 *   4. null (no match)
 */
export function selectPattern(target: Target, patternsDir?: string): Pattern | null {
  const patterns = loadPatterns(patternsDir);
  if (patterns.length === 0) return null;

  const suggested = (target as Target & { suggested_pattern?: string }).suggested_pattern;
  if (suggested) {
    const exact = patterns.find(p => p.name === suggested);
    if (exact) return exact;
  }

  const typeMatches = patterns.filter(p =>
    p.applicable_types.some(t => t === target.type || t === '*'),
  );
  if (typeMatches.length === 1) return typeMatches[0]!;

  const desc = `${target.title} ${target.description}`.toLowerCase();
  const scored = (typeMatches.length > 0 ? typeMatches : patterns).map(p => {
    const score = p.tags.reduce((s, tag) => s + (desc.includes(tag.toLowerCase()) ? 1 : 0), 0);
    return { pattern: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best && best.score > 0) return best.pattern;

  if (typeMatches.length > 0) return typeMatches[0]!;

  return null;
}

export function createPatternRouter(patternsDir?: string): PatternRouter {
  return {
    selectPattern: (target) => selectPattern(target, patternsDir),
  };
}

export function resetPatternCache(): void {
  cachedPatterns = null;
}
