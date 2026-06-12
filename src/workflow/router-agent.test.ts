import { describe, it, expect, vi } from 'vitest';
import { createRouterAgent } from './router-agent.js';
import type { PilotConfig, AssistantTask } from './types.js';

describe('RouterAgent', () => {
  it('should return direct_execute for assistant mode', async () => {
    const agent = createRouterAgent();
    const config: PilotConfig = { mode: 'assistant' };

    const result = await agent.judgeComplexity('do something', config);
    expect(result.action).toBe('direct_execute');
    expect(result.reason).toContain('Assistant mode');
  });

  it('should return split_and_race for research mode', async () => {
    const agent = createRouterAgent();
    const config: PilotConfig = { mode: 'research' };

    const result = await agent.judgeComplexity('research topic', config);
    expect(result.action).toBe('split_and_race');
    expect(result.reason).toContain('Research mode');
    expect(result.initialSplit).toBeDefined();
    expect(result.initialSplit!.chains.length).toBeGreaterThan(0);
  });

  it('should use heuristic for guard mode without fast model', async () => {
    const agent = createRouterAgent(); // no polarPrivateUrl
    const config: PilotConfig = { mode: 'guard' };

    // Simple task without multi-step indicators
    const simple = await agent.judgeComplexity('fix the bug', config);
    expect(simple.action).toBe('direct_execute');
    expect(simple.reason).toContain('Heuristic');

    // Complex task with step indicators
    const complex = await agent.judgeComplexity('research the topic and then write a report', config);
    expect(complex.action).toBe('split_and_race');
    expect(complex.reason).toContain('Heuristic');
  });

  it('should return default plan with chains for split_and_race', async () => {
    const agent = createRouterAgent();
    const config: PilotConfig = { mode: 'research' };

    const result = await agent.judgeComplexity('complex task', config);
    expect(result.initialSplit).toBeDefined();
    expect(result.initialSplit!.chains[0]!.tasks).toEqual(['analyze', 'execute', 'verify']);
  });

  it('should resolve assistant task without fast model', async () => {
    const agent = createRouterAgent(); // no polarPrivateUrl

    const result = await agent.resolveAssistantTask('Fix the login bug in auth.ts');
    expect(result.fundamentalGoal).toBe('Fix the login bug in auth.ts');
    expect(result.executionApproach).toBeDefined();
    expect(result.stopCondition).toBeDefined();
    expect(result.stopCondition.successCriteria).toBeDefined();
    expect(result.stopCondition.failureCriteria).toBeDefined();
  });

  it('should handle fetch failure gracefully for judgeComplexity', async () => {
    const agent = createRouterAgent({ polarPrivateUrl: 'http://localhost:99999' });
    const config: PilotConfig = { mode: 'guard' };

    // Should fall back to heuristic
    const result = await agent.judgeComplexity('simple task', config);
    expect(result.action).toBe('direct_execute');
  });

  it('should handle fetch failure gracefully for resolveAssistantTask', async () => {
    const agent = createRouterAgent({ polarPrivateUrl: 'http://localhost:99999' });

    const result = await agent.resolveAssistantTask('test task');
    expect(result.fundamentalGoal).toBe('test task');
  });
});