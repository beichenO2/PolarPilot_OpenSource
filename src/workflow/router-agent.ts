import type { ComplexityJudgment, WorkflowPlan, TaskChain, PilotConfig, AssistantTask } from './types.js';

export interface RouterAgentConfig {
  polarPrivateUrl?: string;
  fastModel?: string;
}

export interface RouterAgent {
  judgeComplexity(task: string, config: PilotConfig): Promise<ComplexityJudgment>;
  resolveAssistantTask(taskFromClaw: string): Promise<AssistantTask>;
}

export function createRouterAgent(config: RouterAgentConfig = {}): RouterAgent {
  return {
    async judgeComplexity(task: string, pilotConfig: PilotConfig): Promise<ComplexityJudgment> {
      // If mode is 'assistant', always direct execute
      if (pilotConfig.mode === 'assistant') {
        return {
          action: 'direct_execute',
          reason: 'Assistant mode: single-task direct execution',
        };
      }

      // If mode is 'research', always split and race
      if (pilotConfig.mode === 'research') {
        return {
          action: 'split_and_race',
          reason: 'Research mode: multi-step workflow required',
          initialSplit: createDefaultPlan(task),
        };
      }

      // Guard mode: use fast model to judge complexity
      const prompt = `Analyze this task and judge its complexity. Reply with JSON only:
{"action":"direct_execute"|"split_and_race","reason":"..."}

Task: ${task}`;

      const result = await callFastModel(prompt, config);
      if (result) {
        try {
          const parsed = JSON.parse(result) as ComplexityJudgment;
          if (parsed.action === 'split_and_race') {
            parsed.initialSplit = parsed.initialSplit ?? createDefaultPlan(task);
          }
          return parsed;
        } catch {
          // Fall through to heuristic
        }
      }

      // Heuristic fallback: tasks with multiple steps or "and" are complex
      const stepKeywords = ['然后', '之后', '接着', 'and then', 'after that', 'step'];
      const isComplex = stepKeywords.some(kw => task.toLowerCase().includes(kw));
      if (isComplex) {
        return {
          action: 'split_and_race',
          reason: 'Heuristic: task contains multi-step indicators',
          initialSplit: createDefaultPlan(task),
        };
      }

      return {
        action: 'direct_execute',
        reason: 'Heuristic: single-step task detected',
      };
    },

    async resolveAssistantTask(taskFromClaw: string): Promise<AssistantTask> {
      const prompt = `Parse this assistant task into structured format. Reply with JSON only:
{"fundamentalGoal":"...","executionApproach":"...","stopCondition":{"successCriteria":"...","failureCriteria":"..."}}

Task: ${taskFromClaw}`;

      const result = await callFastModel(prompt, config);
      if (result) {
        try {
          return JSON.parse(result) as AssistantTask;
        } catch {
          // Fall through to default
        }
      }

      // Fallback: use the raw task as the goal
      return {
        fundamentalGoal: taskFromClaw,
        executionApproach: 'Execute directly as a single task',
        stopCondition: {
          successCriteria: 'Task completed successfully',
          failureCriteria: 'Task cannot be completed after reasonable attempts',
        },
      };
    },
  };
}

function createDefaultPlan(task: string): WorkflowPlan {
  const chain: TaskChain = {
    id: 'chain-1',
    tasks: ['analyze', 'execute', 'verify'],
  };
  return {
    chains: [chain],
    parallelGroups: [],
  };
}

async function callFastModel(prompt: string, config: RouterAgentConfig): Promise<string | null> {
  if (!config.polarPrivateUrl) return null;

  try {
    const model = config.fastModel ?? 'qwen3:0.6b';
    const resp = await fetch(`${config.polarPrivateUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { message?: { content?: string } };
    return data.message?.content ?? null;
  } catch {
    return null;
  }
}