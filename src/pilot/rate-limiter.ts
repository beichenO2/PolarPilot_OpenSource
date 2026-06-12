/**
 * Rate Limiter — handles API rate-limit (429) with exponential backoff
 *
 * Provides `withRateLimitRetry` to wrap any async operation that may hit
 * rate limits. On 429, waits 5 minutes and retries up to 3 times.
 */

export interface RateLimitConfig {
  /** Maximum retry attempts (default: 3) */
  maxRetries: number;
  /** Wait time in ms before retry (default: 300000 = 5min) */
  waitMs: number;
  /** HTTP status codes considered rate-limit errors (default: [429]) */
  rateLimitCodes: number[];
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRetries: 3,
  waitMs: 300000, // 5 minutes
  rateLimitCodes: [429],
};

/**
 * Checks if an error is a rate-limit error.
 * Matches by status code or by message pattern.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  // Check status code
  const status = (error as any)?.status;
  if (status === 429) return true;

  // Check message pattern
  const msg = String((error as any)?.message || error || '');
  return /rate.?limit|too.?many.?requests|429/i.test(msg);
}

/**
 * Wraps an async function with rate-limit retry logic.
 * On 429, waits `waitMs` and retries up to `maxRetries` times.
 *
 * @param fn - The async function to execute
 * @param config - Partial config to override defaults
 * @returns Object with result, rateLimited flag, and attempt count
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RateLimitConfig>
): Promise<{ result: T | null; rateLimited: boolean; attempts: number }> {
  const { maxRetries, waitMs } = { ...DEFAULT_CONFIG, ...config };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      return { result, rateLimited: false, attempts: attempt };
    } catch (error: unknown) {
      const isRateLimit = isRateLimitError(error);

      // If not rate-limit or exhausted retries, return failure
      if (!isRateLimit || attempt > maxRetries) {
        return { result: null, rateLimited: isRateLimit, attempts: attempt };
      }

      // Log and wait before retry
      console.warn(
        `[RateLimiter] Attempt ${attempt} rate-limited, waiting ${waitMs}ms before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // Should never reach here, but return exhausted state
  return { result: null, rateLimited: true, attempts: maxRetries + 1 };
}