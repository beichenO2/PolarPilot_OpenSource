import { readFileSync } from 'node:fs';
import type { CompiledWorkflow, StepDef, Edge } from './types.js';
import type { KnowLeverClient } from './knowlever-client.js';

export interface WorkflowCompiler {
  compile(workflowPath: string): CompiledWorkflow;
}

export interface WorkflowCompilerConfig {
  /** When true, after each step relevant knowledge is fetched from KnowLever and injected into the next step's context. */
  enableKnowledgeEnrichment?: boolean;
  /** KnowLever client instance (required when enableKnowledgeEnrichment is true). */
  knowleverClient?: KnowLeverClient;
  /** Number of knowledge results to fetch per enrichment (default: 5). */
  knowledgeEnrichmentTopK?: number;
}

export function createWorkflowCompiler(config?: WorkflowCompilerConfig): WorkflowCompiler {
  return {
    compile(workflowPath: string): CompiledWorkflow {
      const content = readFileSync(workflowPath, 'utf-8');
      const steps = parseSteps(content);
      const edges = parseEdges(content);
      const { entry_point, terminal_points } = findEndpoints(steps, edges);
      return {
        id: workflowPath,
        name: extractName(content),
        steps,
        edges,
        entry_point,
        terminal_points,
      };
    },
  };
}

/**
 * Fetch knowledge enrichment from KnowLever for a given query.
 * Returns an empty string if enrichment is disabled or the client is unavailable.
 */
export async function fetchKnowledgeEnrichment(
  query: string,
  config?: WorkflowCompilerConfig,
): Promise<string> {
  if (!config?.enableKnowledgeEnrichment || !config.knowleverClient) return '';
  const topK = config.knowledgeEnrichmentTopK ?? 5;
  try {
    const resp = await config.knowleverClient.search(query, topK);
    if (resp.results.length === 0) return '';
    const sections = resp.results.map(
      r => `[KnowLever Enrichment] (score: ${r.score.toFixed(3)}, source: ${r.source})\n${r.content}`,
    );
    return `\n--- Knowledge Enrichment ---\n${sections.join('\n\n')}\n--- End Enrichment ---\n`;
  } catch {
    return '';
  }
}

function extractName(content: string): string {
  const match = content.match(/^#\s*Workflow:\s*(.+)$/m);
  return match ? match[1]!.trim() : 'unnamed';
}

function parseSteps(content: string): Map<string, StepDef> {
  const steps = new Map<string, StepDef>();

  // Find the step definitions section
  const stepSectionMatch = content.match(/## 步骤定义\s*\n([\s\S]*?)$/);
  if (!stepSectionMatch) return steps;

  const stepSection = stepSectionMatch[1]!;
  const stepBlocks = stepSection.split(/\n(?=\[)/);

  for (const block of stepBlocks) {
    // `m` flag is required: without it `$` only matches end-of-string, so a
    // multi-line block like "[S1]: Foo\n  type: research\n..." fails to match
    // because the header line is not at end-of-string.
    const headerMatch = block.match(/^\[(\S+)\]:\s*(.+)$/m);
    if (!headerMatch) continue;

    const id = headerMatch[1]!;
    const name = headerMatch[2]!.trim();

    // Parse properties
    const typeMatch = block.match(/type:\s*(\S+)/);
    const agentMatch = block.match(/agent:\s*(\S+)/);
    const inputMatch = block.match(/input:\s*(.+)/);
    const outputMatch = block.match(/output:\s*(.+)/);
    const timeoutMatch = block.match(/timeout:\s*(\S+)/);
    const leafTestMatch = block.match(/leaf_test:\s*(.+)/);
    const onFailureMatch = block.match(/on_failure:\s*(.+)/);

    const stepDef: StepDef = {
      id,
      name,
      type: (typeMatch?.[1] ?? 'implement') as StepDef['type'],
      agent: agentMatch?.[1] ?? 'default',
      input: inputMatch ? inputMatch[1]!.split(',').map(s => s.trim()) : [],
      output: outputMatch ? outputMatch[1]!.split(',').map(s => s.trim()) : [],
    };

    if (timeoutMatch) stepDef.timeout = timeoutMatch[1];
    if (leafTestMatch) stepDef.leaf_test = leafTestMatch[1]!.trim();

    if (onFailureMatch) {
      const failureStr = onFailureMatch[1]!.trim();
      const retryMatch = failureStr.match(/retry\(\w+,\s*max=(\d+)\)/);
      if (retryMatch) {
        stepDef.on_failure = { action: 'retry', max_retry: Number(retryMatch[1]) };
      } else {
        stepDef.on_failure = { action: failureStr };
      }
    }

    steps.set(id, stepDef);
  }

  return steps;
}

function parseEdges(content: string): Edge[] {
  const edges: Edge[] = [];

  // Find the diagram section (between ## 框图 and ## 步骤定义)
  const diagramMatch = content.match(/## 框图\s*\n([\s\S]*?)\n## 步骤定义/);
  if (!diagramMatch) return edges;

  const diagram = diagramMatch[1]!;
  const lines = diagram.split('\n');

  // 1. Index every step ID position. `m.index!` is the column of the `[`
  //    token for that step; we use it as the column anchor for column-lane
  //    proximity checks below.
  type StepPos = { id: string; col: number; lineIdx: number };
  const stepPositions: StepPos[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(/\[(\S+)\]/g)) {
      stepPositions.push({ id: m[1]!, col: m.index!, lineIdx: i });
    }
  }

  // 2. Horizontal arrows `[A] ... --> [B]` on the same line → success edges.
  //    `\s*.*?\s*` is removed because lazy `.*?` + surrounding `\s*` causes
  //    the engine to stop at the first whitespace boundary (e.g. after the
  //    space following `[S1]`), never reaching `-->`. Plain `.*?` correctly
  //    expands across pipe chars `|` and spaces until `-->` is found.
  for (const line of lines) {
    for (const m of line.matchAll(/\[(\S+)\].*?-->\s*\[(\S+)\]/g)) {
      edges.push({ from: m[1]!, to: m[2]!, condition: 'success' });
    }
  }

  // 3. Vertical flow. For each step, link it to the *nearest* descendant in
  //    the same column lane reachable through at least one `|`/`v` indicator
  //    on the lines strictly between them. The previous implementation only
  //    looked at immediately adjacent lines, which never fires for box-style
  //    diagrams where `+---+` separator rows sit between the step box and the
  //    `|`/`v` glyph below it.
  const COL_TOL = 12;
  for (const src of stepPositions) {
    const candidates = stepPositions
      .filter(p =>
        p.lineIdx > src.lineIdx &&
        Math.abs(p.col - src.col) <= COL_TOL,
      )
      .sort((a, b) => a.lineIdx - b.lineIdx);

    for (const dst of candidates) {
      let hasIndicator = false;
      for (let li = src.lineIdx + 1; li < dst.lineIdx && !hasIndicator; li++) {
        const line = lines[li]!;
        for (let c = 0; c < line.length; c++) {
          const ch = line[c];
          if (ch !== '|' && ch !== 'v') continue;
          if (
            Math.abs(c - src.col) <= COL_TOL ||
            Math.abs(c - dst.col) <= COL_TOL
          ) {
            hasIndicator = true;
            break;
          }
        }
      }
      if (hasIndicator) {
        if (!edges.some(e => e.from === src.id && e.to === dst.id)) {
          edges.push({ from: src.id, to: dst.id, condition: 'always' });
        }
        break;
      }
    }
  }

  // 4. Merge points: when 2+ `always` edges converge on a single step,
  //    promote them to `all_done` to match executeWorkflow's serial dispatch.
  const incomingCount = new Map<string, number>();
  for (const edge of edges) {
    if (edge.condition === 'always') {
      incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    }
  }
  for (const [stepId, count] of incomingCount) {
    if (count >= 2) {
      for (const edge of edges) {
        if (edge.to === stepId && edge.condition === 'always') {
          edge.condition = 'all_done';
        }
      }
    }
  }

  return edges;
}

function findEndpoints(
  steps: Map<string, StepDef>,
  edges: Edge[],
): { entry_point: string; terminal_points: string[] } {
  // Entry point: step with no incoming edges
  const allTargets = new Set(edges.map(e => e.to));
  const entryCandidates = [...steps.keys()].filter(id => !allTargets.has(id));
  const entry_point = entryCandidates[0] ?? [...steps.keys()][0] ?? '';

  // Terminal points: steps with type 'terminal' or no outgoing edges
  const allSources = new Set(edges.map(e => e.from));
  const terminal_points = [...steps.keys()].filter(id => {
    const step = steps.get(id)!;
    return step.type === 'terminal' || !allSources.has(id);
  });

  return { entry_point, terminal_points };
}