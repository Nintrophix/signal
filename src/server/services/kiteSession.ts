import { and, desc, eq } from 'drizzle-orm';
import { audit } from '../audit.js';
import { decrypt, encrypt } from '../crypto.js';
import type { DB } from '../db/client.js';
import { kiteTokens } from '../db/schema.js';
import type { MarketDataClient } from '../kite/types.js';
import { nextKiteExpiry, nowS } from '../time.js';

export type KiteStatus = 'connected' | 'expired' | 'disconnected';

/**
 * Owns the Kite access token lifecycle: encrypted storage, daily expiry,
 * and the "Reconnect Kite" state.
 */
export class KiteSession {
  private status: KiteStatus = 'disconnected';
  private connectedAt: number | null = null;
  private expiresAt: number | null = null;

  constructor(
    private readonly db: DB,
    private readonly client: MarketDataClient,
    private readonly key: Buffer,
  ) {}

  /** Restore the latest stored token on boot. */
  restore(): void {
    if (this.client.mode === 'mock') {
      this.status = 'connected';
      this.connectedAt = nowS();
      return;
    }
    const row = this.db
      .select()
      .from(kiteTokens)
      .where(eq(kiteTokens.status, 'active'))
      .orderBy(desc(kiteTokens.id))
      .limit(1)
      .get();
    if (!row) return;
    if (row.expiresAt <= nowS()) {
      this.markExpired('stored token past daily expiry');
      return;
    }
    try {
      this.client.setAccessToken(decrypt(row.accessTokenEnc, this.key));
      this.status = 'connected';
      this.connectedAt = row.createdAt;
      this.expiresAt = row.expiresAt;
    } catch {
      this.markExpired('stored token could not be decrypted');
    }
  }

  current(): { status: KiteStatus; connectedAt: number | null; expiresAt: number | null; mode: 'live' | 'mock' } {
    if (this.status === 'connected' && this.expiresAt && this.expiresAt <= nowS()) this.markExpired('daily expiry');
    return { status: this.status, connectedAt: this.connectedAt, expiresAt: this.expiresAt, mode: this.client.mode };
  }

  isConnected(): boolean {
    return this.current().status === 'connected';
  }

  async connect(requestToken: string, userId: number, ip: string | null): Promise<void> {
    const { accessToken, kiteUserId } = await this.client.createSession(requestToken);
    const expiresAt = nextKiteExpiry(nowS());
    this.db.transaction((tx) => {
      tx.update(kiteTokens).set({ status: 'expired' }).where(eq(kiteTokens.status, 'active')).run();
      tx.insert(kiteTokens)
        .values({ accessTokenEnc: encrypt(accessToken, this.key), kiteUserId, connectedBy: userId, expiresAt })
        .run();
    });
    this.client.setAccessToken(accessToken);
    this.status = 'connected';
    this.connectedAt = nowS();
    this.expiresAt = expiresAt;
    audit(this.db, 'kite.connect', { userId, ip, detail: `kite user ${kiteUserId}` });
  }

  /** Called when any Kite call raises a TokenException. */
  markExpired(reason: string): void {
    if (this.status === 'expired') return;
    const wasConnected = this.status === 'connected';
    this.status = 'expired';
    if (this.client.mode === 'live') this.client.setAccessToken(null);
    this.db
      .update(kiteTokens)
      .set({ status: 'expired' })
      .where(and(eq(kiteTokens.status, 'active')))
      .run();
    if (wasConnected || reason) audit(this.db, 'kite.expired', { detail: reason });
  }
}
