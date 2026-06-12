/**
 * Test Executor — 客观测试执行器
 *
 * 在 processShot 中实现客观评估前置：
 * 当 target 有 leaf_test 字段时，先执行测试，测试通过才进入 Review；
 * 测试不通过直接 MoveBoard。
 */

import { spawn } from 'node:child_process';
import type { TestExecutor, TestResult } from './types.js';

export interface TestExecutorConfig {
  /** 默认超时时间（毫秒），默认 60000 */
  timeoutMs?: number;
  /** 环境变量 */
  env?: Record<string, string>;
}

/**
 * 创建默认的测试执行器（基于 shell 执行）
 */
export function createTestExecutor(config: TestExecutorConfig = {}): TestExecutor {
  const { timeoutMs = 60000, env = {} } = config;

  return {
    async execute(testCommand: string, cwd: string): Promise<TestResult> {
      const start = Date.now();

      return new Promise((resolve) => {
        let output = '';
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        // 使用 shell 执行命令
        const proc = spawn(testCommand, [], {
          cwd,
          shell: true,
          env: { ...process.env, ...env },
        });

        // 设置超时
        if (timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            proc.kill('SIGTERM');
            output += '\n[TIMEOUT] Test execution timed out';
          }, timeoutMs);
        }

        proc.stdout.on('data', (data) => {
          output += data.toString();
        });

        proc.stderr.on('data', (data) => {
          output += data.toString();
        });

        proc.on('close', (code) => {
          if (timeoutId) clearTimeout(timeoutId);

          const durationMs = Date.now() - start;
          resolve({
            passed: code === 0,
            output: output.trim(),
            durationMs,
          });
        });

        proc.on('error', (err) => {
          if (timeoutId) clearTimeout(timeoutId);

          const durationMs = Date.now() - start;
          resolve({
            passed: false,
            output: `Failed to execute test: ${err.message}`,
            durationMs,
          });
        });
      });
    },
  };
}

/**
 * 创建模拟测试执行器（用于测试）
 */
export function createMockTestExecutor(
  results: Map<string, TestResult>,
): TestExecutor {
  return {
    async execute(testCommand: string, cwd: string): Promise<TestResult> {
      const key = `${cwd}:${testCommand}`;
      const result = results.get(key);
      if (result) return result;

      // 默认返回通过
      return {
        passed: true,
        output: `Mock test passed: ${testCommand}`,
        durationMs: 100,
      };
    },
  };
}

/**
 * 创建总是通过的测试执行器
 */
export function createPassingTestExecutor(): TestExecutor {
  return {
    async execute(testCommand: string): Promise<TestResult> {
      return {
        passed: true,
        output: `Test passed: ${testCommand}`,
        durationMs: 0,
      };
    },
  };
}

/**
 * 创建总是失败的测试执行器
 */
export function createFailingTestExecutor(reason: string = 'Test failed'): TestExecutor {
  return {
    async execute(testCommand: string): Promise<TestResult> {
      return {
        passed: false,
        output: `${reason}: ${testCommand}`,
        durationMs: 0,
      };
    },
  };
}
