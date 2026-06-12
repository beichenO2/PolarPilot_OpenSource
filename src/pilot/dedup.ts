/**
 * Event deduplication — same dedup_key within a configurable window
 * (default 10 min) only triggers one lobster wake-up.
 *
 * The dedup state is in-memory only; the events file is never mutated.
 */

export interface DedupConfig {
  windowMs: number;
}

export function createDedup(config: DedupConfig) {
  const seen = new Map<string, number>();

  let purgeTimer: ReturnType<typeof setInterval> | null = null;

  function startPurge() {
    if (purgeTimer) return;
    purgeTimer = setInterval(() => {
      const cutoff = Date.now() - config.windowMs;
      for (const [key, ts] of seen) {
        if (ts < cutoff) seen.delete(key);
      }
    }, Math.min(config.windowMs, 60_000));

    if (typeof purgeTimer === 'object' && 'unref' in purgeTimer) {
      purgeTimer.unref();
    }
  }

  return {
    /**
     * Returns true if the event should be processed (not a duplicate).
     * Returns false if we've already seen this key within the window.
     */
    shouldProcess(dedupKey: string): boolean {
      startPurge();
      const now = Date.now();
      const lastSeen = seen.get(dedupKey);
      if (lastSeen !== undefined && now - lastSeen < config.windowMs) {
        return false;
      }
      seen.set(dedupKey, now);
      return true;
    },

    /** Manually mark a key as seen right now. */
    markSeen(dedupKey: string): void {
      seen.set(dedupKey, Date.now());
    },

    /** Get the number of tracked keys. */
    size(): number {
      return seen.size;
    },

    /** Stop the purge timer. */
    stop(): void {
      if (purgeTimer) {
        clearInterval(purgeTimer);
        purgeTimer = null;
      }
    },

    /** Clear all tracked keys. */
    clear(): void {
      seen.clear();
    },
  };
}

export type Dedup = ReturnType<typeof createDedup>;
