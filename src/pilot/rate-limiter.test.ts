/**
 * Unit tests for rate-limiter.ts
 *
 * Tests 429 rate-limit retry behavior:
 * - 429 triggers retry with 5min wait
 * - Max 3 retries before giving up
 * - Uses vi.useFakeTimers for time control
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { withRateLimitRetry, isRateLimitError } from './rate-limiter.js';

describe('rate-limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isRateLimitError', () => {
    it('should detect 429 status code', () => {
      const error = { status: 429 };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect rate limit in message', () => {
      const error = { message: 'Rate limit exceeded' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect "too many requests" in message', () => {
      const error = { message: 'Too many requests' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect "429" in message', () => {
      const error = { message: 'Error 429 from API' };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should return false for non-rate-limit errors', () => {
      const error = { status: 500, message: 'Internal server error' };
      expect(isRateLimitError(error)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
    });
  });

  describe('withRateLimitRetry', () => {
    it('should return result immediately on success', async () => {
      const fn = async () => 'success';
      const result = await withRateLimitRetry(fn);
      
      expect(result.result).toBe('success');
      expect(result.rateLimited).toBe(false);
      expect(result.attempts).toBe(1);
    });

    it('should retry on 429 error with 5min wait', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 3) {
          const error = new Error('Rate limit') as any;
          error.status = 429;
          throw error;
        }
        return 'success';
      };

      const promise = withRateLimitRetry(fn);
      
      // First attempt fails with 429
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      
      // Wait 5 minutes for retry
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(attempts).toBe(2);
      
      // Wait another 5 minutes for second retry
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(attempts).toBe(3);
      
      const result = await promise;
      expect(result.result).toBe('success');
      expect(result.rateLimited).toBe(false);
      expect(result.attempts).toBe(3);
    });

    it('should give up after max retries (3)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const error = new Error('Rate limit') as any;
        error.status = 429;
        throw error;
      };

      const promise = withRateLimitRetry(fn);
      
      // First attempt
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      
      // 3 retries with 5min wait each
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // retry 1
      expect(attempts).toBe(2);
      
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // retry 2
      expect(attempts).toBe(3);
      
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // retry 3
      expect(attempts).toBe(4);
      
      const result = await promise;
      expect(result.result).toBe(null);
      expect(result.rateLimited).toBe(true);
      expect(result.attempts).toBe(4); // 1 initial + 3 retries
    });

    it('should return immediately on non-rate-limit error', async () => {
      const fn = async () => {
        throw new Error('Internal error');
      };

      const result = await withRateLimitRetry(fn);
      
      expect(result.result).toBe(null);
      expect(result.rateLimited).toBe(false);
      expect(result.attempts).toBe(1);
    });

    it('should use custom config', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        if (attempts < 2) {
          const error = new Error('Rate limit') as any;
          error.status = 429;
          throw error;
        }
        return 'success';
      };

      const promise = withRateLimitRetry(fn, {
        maxRetries: 1,
        waitMs: 60000, // 1 minute
      });
      
      // First attempt
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      
      // Wait 1 minute for retry
      await vi.advanceTimersByTimeAsync(60000);
      expect(attempts).toBe(2);
      
      const result = await promise;
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(2);
    });

    it('should verify 3 retries with 5min intervals (total 15min)', async () => {
      let attempts = 0;
      const fn = async () => {
        attempts++;
        const error = new Error('429 Too Many Requests') as any;
        error.status = 429;
        throw error;
      };

      const startTime = Date.now();
      const promise = withRateLimitRetry(fn);
      
      // Verify each retry happens at 5min intervals
      for (let i = 1; i <= 3; i++) {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(attempts).toBe(i + 1);
      }
      
      const result = await promise;
      const elapsed = Date.now() - startTime;
      
      // Total time: 3 waits of 5min = 15min
      expect(elapsed).toBe(15 * 60 * 1000);
      expect(result.rateLimited).toBe(true);
      expect(result.attempts).toBe(4); // 1 initial + 3 retries
    });
  });
});
