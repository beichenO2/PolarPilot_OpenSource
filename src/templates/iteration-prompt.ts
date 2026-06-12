import { getCommitMessagePromptFields, type CommitMessageConfig } from '../core/commit-message';
import { selectPattern, type Pattern } from './pattern-router';
import type { Target } from '../pilot/types';

export interface IterationPromptOptions {
  n: number;
  runId: string;
  prompt: string;
  stopWhen?: string;
  commitMessage?: CommitMessageConfig;
  target?: { id: string; title: string; description: string; type?: string; suggested_pattern?: string; };
}

function formatPatternSection(pattern: Pattern): string {
  const steps = pattern.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `## Thinking Framework: ${pattern.name}\n\n${pattern.description}\n\nFollow these steps in order:\n${steps}`;
}

export function buildIterationPrompt(p: IterationPromptOptions): string {
  const fields = ['- success: whether meaningful contribution was made', '- summary: concise one-sentence summary', '- key_changes_made: array of key changes', '- key_learnings: array of new learnings'];
  for (const f of getCommitMessagePromptFields(p.commitMessage)) { fields.push('- ' + f.name + ': ' + f.description); }
  if (p.stopWhen) fields.push('- should_fully_stop: true when stop condition met');
  fields.push('- shot_outcome (optional): "hit" or "miss"', '- shot_delta (optional): deviation from target');

  let s = '';

  if (p.target) {
    const matchTarget: Target = {
      id: p.target.id,
      title: p.target.title,
      description: p.target.description,
      type: (p.target.type as 'root_target' | 'test_target') ?? 'test_target',
      parent_id: null,
      children_ids: [],
      status: 'active',
      stop_conditions: { route_broken: { n_failed_shots: 3, current: 0 }, data_missing: { depends_on: [] }, human_intervention: { irreversible_actions: [], auth_needed: [] }, unreachable: { m_total_shots: 5, current: 0, moveboard_count: 0 }, completed: {} },
      polaris_feature_ref: null,
      arrow_logs: [],
      created_at: '',
      updated_at: '',
      suggested_pattern: p.target.suggested_pattern,
    };
    const pattern = selectPattern(matchTarget);
    if (pattern) {
      s += formatPatternSection(pattern) + '\n\n';
    }
  }

  s += 'Iteration ' + p.n + '. Read .polarpilot/runs/' + p.runId + '/notes.md first.\n\n## Output\n\n' + fields.join('\n');
  if (p.stopWhen) s += '\n\n## Stop Condition\n\n' + p.stopWhen;
  if (p.target) s += '\n\n## Target\n\nID: ' + p.target.id + '\nTitle: ' + p.target.title + '\n\n' + p.target.description;
  s += '\n\n## Objective\n\n' + p.prompt;
  return s;
}
