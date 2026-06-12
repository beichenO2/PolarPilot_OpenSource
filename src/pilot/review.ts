import type { Target } from './types.js';
import type { AgentName } from '../core/config.js';
import { createAgent } from '../core/agents/factory.js';
import { buildReviewPrompt } from '../templates/review-prompt.js';

export interface ReviewResult {
  approved: boolean;
  feedback: string;
}

/**
 * Spawn a fresh Agent with independent context to review a shot result.
 * The "fresh eyes" effect catches false positives that the executing
 * Agent's accumulated context would miss.
 */
export async function reviewShot(
  target: Target,
  shotDelta: string,
  cwd: string,
  agentType?: AgentName,
): Promise<ReviewResult> {
  const prompt = buildReviewPrompt(target, shotDelta);
  const agent = createAgent(agentType ?? 'claude');

  try {
    const result = await agent.run(prompt, cwd);
    return parseReviewResponse(result.output.summary);
  } finally {
    await agent.close?.();
  }
}

function parseReviewResponse(raw: string): ReviewResult {
  const jsonMatch = raw.match(/\{[\s\S]*?"approved"[\s\S]*?\}/);
  if (!jsonMatch) {
    return { approved: false, feedback: `Failed to parse review response: ${raw.slice(0, 200)}` };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { approved?: unknown; feedback?: unknown };
    return {
      approved: Boolean(parsed.approved),
      feedback: String(parsed.feedback ?? ''),
    };
  } catch {
    return { approved: false, feedback: `Invalid JSON in review response: ${raw.slice(0, 200)}` };
  }
}
