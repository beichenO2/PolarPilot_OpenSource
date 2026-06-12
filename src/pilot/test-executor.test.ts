import { describe, it, expect } from 'vitest';
import { createTestExecutor, createMockTestExecutor, createPassingTestExecutor, createFailingTestExecutor } from './test-executor.js';

describe('TestExecutor', () => {
  describe('createTestExecutor', () => {
    it('should execute a passing test command', async () => {
      const executor = createTestExecutor();
      const result = await executor.execute('echo "test passed"', process.cwd());

      expect(result.passed).toBe(true);
      expect(result.output).toContain('test passed');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should execute a failing test command', async () => {
      const executor = createTestExecutor();
      const result = await executor.execute('exit 1', process.cwd());

      expect(result.passed).toBe(false);
    });

    it('should handle timeout', async () => {
      const executor = createTestExecutor({ timeoutMs: 100 });
      const result = await executor.execute('sleep 10', process.cwd());

      expect(result.passed).toBe(false);
      expect(result.output).toContain('TIMEOUT');
    }, 10000);
  });

  describe('createMockTestExecutor', () => {
    it('should return mock results', async () => {
      const results = new Map([
        ['/tmp:npm test', { passed: true, output: 'Mock passed', durationMs: 50 }],
      ]);
      const executor = createMockTestExecutor(results);

      const result = await executor.execute('npm test', '/tmp');
      expect(result.passed).toBe(true);
      expect(result.output).toContain('Mock passed');
    });

    it('should return default passing result for unknown commands', async () => {
      const executor = createMockTestExecutor(new Map());
      const result = await executor.execute('unknown', '/tmp');

      expect(result.passed).toBe(true);
    });
  });

  describe('createPassingTestExecutor', () => {
    it('should always pass', async () => {
      const executor = createPassingTestExecutor();
      const result = await executor.execute('any command', '/any/path');

      expect(result.passed).toBe(true);
    });
  });

  describe('createFailingTestExecutor', () => {
    it('should always fail', async () => {
      const executor = createFailingTestExecutor('Custom reason');
      const result = await executor.execute('any command', '/any/path');

      expect(result.passed).toBe(false);
      expect(result.output).toContain('Custom reason');
    });
  });
});
