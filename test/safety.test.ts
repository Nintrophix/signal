import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decrypt, deriveKey, encrypt } from '../src/server/crypto.js';
import { Throttle, withRetry } from '../src/server/kite/throttle.js';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

describe('real-money safety', () => {
  it('source never references order / GTT / margin endpoints', () => {
    const banned = /\b(placeOrder|modifyOrder|cancelOrder|exitOrder|placeGTT|modifyGTT|deleteGTT|placeMFOrder|cancelMFOrder|placeMFSIP|convertPosition|getOrderMargins|orders?\/regular)\b/;
    const offenders = walk('src').filter((f) => /\.(ts|tsx|js)$/.test(f) && banned.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('token encryption at rest', () => {
  const key = deriveKey('b'.repeat(64));
  it('round-trips', () => expect(decrypt(encrypt('secret-token', key), key)).toBe('secret-token'));
  it('ciphertext does not contain the plaintext and is randomised', () => {
    const a = encrypt('secret-token', key);
    expect(a).not.toContain('secret-token');
    expect(encrypt('secret-token', key)).not.toBe(a);
  });
  it('tampering is detected', () => {
    const parts = encrypt('secret-token', key).split(':');
    parts[3] = Buffer.from('tampered!!!!').toString('base64');
    expect(() => decrypt(parts.join(':'), key)).toThrow();
  });
  it('wrong key fails', () => expect(() => decrypt(encrypt('x', key), deriveKey('c'.repeat(64)))).toThrow());
});

describe('rate limiting and retry', () => {
  it('throttle spaces calls to the configured rate', async () => {
    const t = new Throttle(10);
    const starts: number[] = [];
    await Promise.all([1, 2, 3, 4].map(() => t.run(async () => starts.push(Date.now()))));
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(100);
  });
  it('retries transient errors with backoff, then succeeds', async () => {
    let n = 0;
    const delays: number[] = [];
    const v = await withRetry(
      async () => {
        if (++n < 3) throw new Error('blip');
        return 'ok';
      },
      { baseMs: 10, sleep: async (ms) => void delays.push(ms) },
    );
    expect(v).toBe('ok');
    expect(delays).toHaveLength(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]! - 10);
  });
  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(
      withRetry(async () => {
        n++;
        throw new Error('auth');
      }, { isRetryable: () => false, sleep: async () => {} }),
    ).rejects.toThrow('auth');
    expect(n).toBe(1);
  });
});
