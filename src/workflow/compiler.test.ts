import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkflowCompiler } from './compiler.js';

describe('WorkflowCompiler', () => {
  let tmpDir: string;
  let workflowPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `wf-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    workflowPath = join(tmpDir, 'test-workflow.md');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('should compile a simple linear workflow', () => {
    const content = `# Workflow: Simple Linear

## 框图
+------------------+
| [S1] Step One    |
+------------------+
        |
        v
+------------------+
| [S2] Step Two    |
+------------------+
        |
        v
+------------------+
| [END] Done       |
+------------------+

## 步骤定义
[S1]: Step One
  type: research
  agent: qwen3:0.6b
  input: topic
  output: analysis

[S2]: Step Two
  type: implement
  agent: qwen3:0.6b
  input: S1.output
  output: result

[END]: Done
  type: terminal
`;
    writeFileSync(workflowPath, content);
    const compiler = createWorkflowCompiler();
    const result = compiler.compile(workflowPath);

    expect(result.name).toBe('Simple Linear');
    expect(result.steps.size).toBe(3);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.entry_point).toBeDefined();
    expect(result.terminal_points).toContain('END');
  });

  it('should parse step definitions correctly', () => {
    const content = `# Workflow: Step Parse Test

## 框图
+------------------+
| [S1] Research    |
+------------------+

## 步骤定义
[S1]: Research
  type: research
  agent: qwen3:0.6b
  input: topic, keywords
  output: key_papers, gaps
  timeout: 30m
  leaf_test: echo "pass"
`;
    writeFileSync(workflowPath, content);
    const compiler = createWorkflowCompiler();
    const result = compiler.compile(workflowPath);

    const s1 = result.steps.get('S1');
    expect(s1).toBeDefined();
    expect(s1!.name).toBe('Research');
    expect(s1!.type).toBe('research');
    expect(s1!.agent).toBe('qwen3:0.6b');
    expect(s1!.input).toEqual(['topic', 'keywords']);
    expect(s1!.output).toEqual(['key_papers', 'gaps']);
    expect(s1!.timeout).toBe('30m');
    expect(s1!.leaf_test).toBe('echo "pass"');
  });

  it('should handle branching edges', () => {
    const content = `# Workflow: Branch Test

## 框图
+------------------+
| [S1] Start       |
+------------------+
        |
        v
+------------------+
| [S2] Branch A    |
+------------------+

## 步骤定义
[S1]: Start
  type: research
  agent: qwen3:0.6b
  input: topic
  output: analysis

[S2]: Branch A
  type: implement
  agent: qwen3:0.6b
  input: S1.output
  output: result
`;
    writeFileSync(workflowPath, content);
    const compiler = createWorkflowCompiler();
    const result = compiler.compile(workflowPath);

    expect(result.edges.length).toBeGreaterThan(0);
    // S1 → S2 should exist
    const s1ToS2 = result.edges.find(e => e.from === 'S1' && e.to === 'S2');
    expect(s1ToS2).toBeDefined();
  });

  it('should handle on_failure with retry', () => {
    const content = `# Workflow: Retry Test

## 框图
+------------------+
| [S1] Retry Step  |
+------------------+

## 步骤定义
[S1]: Retry Step
  type: design
  agent: qwen3:0.6b
  input: spec
  output: result
  on_failure: retry(S1, max=3)
`;
    writeFileSync(workflowPath, content);
    const compiler = createWorkflowCompiler();
    const result = compiler.compile(workflowPath);

    const s1 = result.steps.get('S1');
    expect(s1!.on_failure).toBeDefined();
    expect(s1!.on_failure!.action).toBe('retry');
    expect(s1!.on_failure!.max_retry).toBe(3);
  });

  it('should extract workflow name from header', () => {
    const content = `# Workflow: My Custom Workflow

## 框图
+------------------+
| [S1] Step        |
+------------------+

## 步骤定义
[S1]: Step
  type: implement
  agent: default
  input: data
  output: result
`;
    writeFileSync(workflowPath, content);
    const compiler = createWorkflowCompiler();
    const result = compiler.compile(workflowPath);

    expect(result.name).toBe('My Custom Workflow');
  });

  it('should identify entry and terminal points', () => {
    const content = `# Workflow: Endpoint Test

## 框图
+------------------+
| [S1] First       |
+------------------+
        |
        v
+------------------+
| [END] Terminal   |
+------------------+

## 步骤定义
[S1]: First
  type: research
  agent: default
  input: topic
  output: analysis

[END]: Terminal
  type: terminal
`;
    writeFileSync(workflowPath, content);
    const compiler = createWorkflowCompiler();
    const result = compiler.compile(workflowPath);

    expect(result.entry_point).toBe('S1');
    expect(result.terminal_points).toContain('END');
  });
});