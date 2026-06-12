import type { Target } from '../pilot/types.js';

export function buildReviewPrompt(target: Target, shotDelta: string): string {
  return `## Independent Review

You are reviewing code changes for the FIRST TIME. You have NO prior context about this task —
no assumptions, no history, no bias. Your job is to independently judge whether the changes
actually achieve the stated goal.

### Target

- **ID**: ${target.id}
- **Type**: ${target.type}
- **Title**: ${target.title}
- **Description**: ${target.description}

### Changes Made (Shot Delta)

${shotDelta}

### Your Task

1. Read the target description carefully.
2. Read the changes (shot delta) carefully.
3. Judge whether the changes genuinely satisfy the target's requirements.
4. Watch for: superficial fixes, incomplete implementations, side effects, missing edge cases,
   tests that pass trivially, or changes that look correct but don't actually work.

### Response Format

Return ONLY a JSON object with no other text:

\`\`\`json
{
  "approved": true | false,
  "feedback": "Concise explanation of your decision. If rejected, explain what's missing or wrong."
}
\`\`\``;
}
