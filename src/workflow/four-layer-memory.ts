import { readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Checkpoint, Block, StepOutput } from './types.js';
import type { MemoryManager } from './memory.js';
import { createMemoryManager } from './memory.js';
import type { KnowLeverClient, KnowLeverSearchResult } from './knowlever-client.js';
import {
  LAYER_SOUL,
  LAYER_LONG_TERM,
  LAYER_CONTEXT,
  LAYER_SCRATCH,
  type LayerNumber,
  validateMemoryWrite,
  sanitizeForLongTerm,
  recordViolation,
  getMemoryBoundaryReport,
  clearViolations,
  CLEAN_MEMORY_CLAUSE,
} from './clean-memory-clause.js';

// ── Layer data containers ────────────────────────────────────────

export interface SoulLayerData {
  content: string;
  layer: typeof LAYER_SOUL;
}

export interface LongTermLayerData {
  blocks: Block[];
  knowleverResults?: KnowLeverSearchResult[];
  query: string;
  total: number;
  layer: typeof LAYER_LONG_TERM;
}

export interface ContextLayerData {
  checkpoint: Checkpoint;
  recentStepOutputs: StepOutput[];
  layer: typeof LAYER_CONTEXT;
}

export interface ScratchLayerData {
  files: Record<string, string>;
  layer: typeof LAYER_SCRATCH;
}

export type LayerData = SoulLayerData | LongTermLayerData | ContextLayerData | ScratchLayerData;

// ── Four-layer memory manager ────────────────────────────────────

export interface FourLayerMemoryManager {
  /** Layer 1: Immutable identity from PolarSoul.md */
  getSoulLayer(): SoulLayerData;

  /** Layer 2: Persistent knowledge from PolarMemory */
  getLongTermLayer(query: string, topK?: number): Promise<LongTermLayerData>;

  /** Layer 3: Current task context — checkpoint + recent step I/O */
  getContextLayer(): ContextLayerData;

  /** Layer 4: Ephemeral working data from scratch directory */
  getScratchLayer(): ScratchLayerData;

  /** Assemble all 4 layers into a single context string for LLM injection */
  buildFullContext(query: string): Promise<string>;

  /** Enforce the clean memory clause — returns the clause text and validates boundaries */
  enforceCleanMemoryClause(): { clause: string; report: ReturnType<typeof getMemoryBoundaryReport> };

  /** Access the underlying MemoryManager for direct operations */
  getInner(): MemoryManager;
}

export interface FourLayerMemoryConfig {
  soulPath: string;
  workflowPath: string;
  scratchDir: string;
  polarMemoryUrl?: string;
  /** Optional KnowLever RAG client for enriched long-term memory. */
  knowleverClient?: KnowLeverClient;
  /** Max number of recent step outputs to include in context layer (default: 5) */
  maxRecentSteps?: number;
}

export function createFourLayerMemoryManager(config: FourLayerMemoryConfig): FourLayerMemoryManager {
  const inner = createMemoryManager({
    soulPath: config.soulPath,
    workflowPath: config.workflowPath,
    scratchDir: config.scratchDir,
    polarMemoryUrl: config.polarMemoryUrl,
  });

  const maxRecentSteps = config.maxRecentSteps ?? 5;

  function readRecentStepOutputs(): StepOutput[] {
    const historyDir = join(config.scratchDir, 'history');
    if (!existsSync(historyDir)) return [];

    try {
      const files = readdirSync(historyDir)
        .filter(f => f.startsWith('step-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, maxRecentSteps);

      const outputs: StepOutput[] = [];
      for (const f of files) {
        try {
          const raw = readFileSync(join(historyDir, f), 'utf-8');
          outputs.push(JSON.parse(raw) as StepOutput);
        } catch {
          // Skip unreadable files
        }
      }
      return outputs;
    } catch {
      return [];
    }
  }

  function readScratchFiles(): Record<string, string> {
    if (!existsSync(config.scratchDir)) return {};
    const files: Record<string, string> = {};
    try {
      const entries = readdirSync(config.scratchDir);
      for (const entry of entries) {
        if (entry === 'history') continue; // history is Layer 3, not scratch
        const fullPath = join(config.scratchDir, entry);
        try {
          const s = statSync(fullPath);
          if (s.isFile()) {
            files[entry] = readFileSync(fullPath, 'utf-8');
          }
        } catch {
          // Skip unreadable entries
        }
      }
    } catch {
      // Directory unreadable
    }
    return files;
  }

  return {
    getSoulLayer(): SoulLayerData {
      return {
        content: inner.readSoul(),
        layer: LAYER_SOUL,
      };
    },

    async getLongTermLayer(query: string, topK = 10): Promise<LongTermLayerData> {
      const blocks = await inner.fetchLongTermMemory(query, topK);

      let knowleverResults: KnowLeverSearchResult[] | undefined;
      if (config.knowleverClient) {
        try {
          const klResp = await config.knowleverClient.search(query, topK);
          knowleverResults = deduplicateKnowLeverResults(blocks, klResp.results);
        } catch {
          // KnowLever unavailable — proceed with PolarMemory results only
        }
      }

      const klCount = knowleverResults?.length ?? 0;
      return {
        blocks,
        knowleverResults,
        query,
        total: blocks.length + klCount,
        layer: LAYER_LONG_TERM,
      };
    },

    getContextLayer(): ContextLayerData {
      return {
        checkpoint: inner.refreshCheckpoint(),
        recentStepOutputs: readRecentStepOutputs(),
        layer: LAYER_CONTEXT,
      };
    },

    getScratchLayer(): ScratchLayerData {
      return {
        files: readScratchFiles(),
        layer: LAYER_SCRATCH,
      };
    },

    async buildFullContext(query: string): Promise<string> {
      const sections: string[] = [];

      // Layer 1: Soul (immutable identity)
      const soul = this.getSoulLayer();
      sections.push('═══ LAYER 1: SOUL (immutable) ═══');
      sections.push(soul.content);

      // Layer 2: Long-term memory
      const longTerm = await this.getLongTermLayer(query);
      sections.push('');
      sections.push('═══ LAYER 2: LONG-TERM MEMORY ═══');
      if (longTerm.blocks.length === 0 && !longTerm.knowleverResults?.length) {
        sections.push('(no matching blocks)');
      } else {
        for (const block of longTerm.blocks) {
          sections.push(`[${block.label}] (type: ${block.type ?? 'fact'}, ${block.tokens} tokens, source: ${block.source_wiki}${block.confidence != null ? `, confidence: ${block.confidence.toFixed(2)}` : ''})`);
          sections.push(block.value);
          sections.push('');
        }
        if (longTerm.knowleverResults?.length) {
          sections.push('--- KnowLever RAG ---');
          for (const r of longTerm.knowleverResults) {
            sections.push(`[KnowLever] (score: ${r.score.toFixed(3)}, source: ${r.source})`);
            sections.push(r.content);
            sections.push('');
          }
        }
      }

      // Layer 3: Context
      const context = this.getContextLayer();
      sections.push('═══ LAYER 3: CONTEXT ═══');
      const cp = context.checkpoint;
      sections.push(`Workflow: ${cp.workflow_id || '(none)'}`);
      sections.push(`Current step: ${cp.current_step || '(none)'}`);
      sections.push(`Completed: [${cp.completed_steps.join(', ')}]`);
      if (cp.global_learnings.length > 0) {
        sections.push('Learnings:');
        for (const l of cp.global_learnings) {
          sections.push(`  - ${l}`);
        }
      }
      if (context.recentStepOutputs.length > 0) {
        sections.push('Recent step outputs:');
        for (const so of context.recentStepOutputs) {
          sections.push(`  [${so.step_id}] ${so.result}: ${so.summary}`);
        }
      }

      // Layer 4: Scratch
      const scratch = this.getScratchLayer();
      sections.push('');
      sections.push('═══ LAYER 4: SCRATCH (ephemeral) ═══');
      const scratchEntries = Object.entries(scratch.files);
      if (scratchEntries.length === 0) {
        sections.push('(empty)');
      } else {
        for (const [name, content] of scratchEntries) {
          sections.push(`--- ${name} ---`);
          sections.push(content);
        }
      }

      return sections.join('\n');
    },

    enforceCleanMemoryClause() {
      const report = getMemoryBoundaryReport();
      return {
        clause: CLEAN_MEMORY_CLAUSE,
        report,
      };
    },

    getInner(): MemoryManager {
      return inner;
    },
  };
}

// ── KnowLever deduplication ──────────────────────────────────────────
//
// Remove KnowLever results whose content is too similar to an existing
// PolarMemory block. Uses a simple trigram-overlap heuristic: if the
// Jaccard similarity between trigram sets exceeds the threshold the
// KnowLever result is considered a duplicate.

const DEDUP_SIMILARITY_THRESHOLD = 0.6;

function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length < 3) return new Set();
  const set = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function deduplicateKnowLeverResults(
  blocks: Block[],
  knowleverResults: KnowLeverSearchResult[],
  threshold = DEDUP_SIMILARITY_THRESHOLD,
): KnowLeverSearchResult[] {
  const blockTrigrams = blocks.map(b => trigrams(b.value));
  return knowleverResults.filter(kl => {
    const klTrigrams = trigrams(kl.content);
    return !blockTrigrams.some(bt => jaccard(bt, klTrigrams) >= threshold);
  });
}

// Re-export clean memory clause utilities for convenience
export {
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
} from './clean-memory-clause.js';
export type { LayerNumber, MemoryBoundaryViolation } from './clean-memory-clause.js';
