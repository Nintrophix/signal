/**
 * Serialises calls to at most `perSecond` starts per second and retries
 * transient failures with exponential backoff + jitter.
 */
export class Throttle {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private readonly gapMs: number;

  constructor(perSecond: number, private readonly sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
    this.gapMs = Math.ceil(1000 / perSecond) + 10; // small safety margin
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next.then(fn);
  }
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 4, baseMs = 500, isRetryable = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
      attempt++;
      await sleep(delay);
    }
  }
}
