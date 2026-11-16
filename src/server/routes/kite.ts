import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../app.js';
import { audit } from '../audit.js';
import { setKiteState } from '../auth/sessions.js';
import { randomToken, safeEqual } from '../crypto.js';

/**
 * Daily Kite login: /kite/connect → Kite login → /kite/callback.
 *
 * The session cookie is SameSite=Strict, so it is NOT sent on the cross-site
 * redirect back from kite.zerodha.com. The auth gate therefore bounces the
 * callback to /login?next=…; the login page checks /api/me (same-origin, cookie
 * sent) and re-navigates same-site, at which point the cookie is present.
 * A per-session `state` nonce (via Kite redirect_params) prevents CSRF.
 */
export const kiteRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { db, kite, client } = deps;

    app.get('/kite/connect', async (req, reply) => {
      if (req.user!.role !== 'admin') return reply.code(403).type('text/plain').send('Only an admin can connect Kite.');
      const state = randomToken(18);
      setKiteState(db, req.user!.sessionId, state);
      return reply.redirect(client.loginUrl(state), 302);
    });

    app.get('/kite/callback', async (req, reply) => {
      const q = req.query as { status?: string; request_token?: string; state?: string };
      const user = req.user!;
      const expected = user.kiteState;
      // One-shot nonce.
      setKiteState(db, user.sessionId, null);
      if (user.role !== 'admin' || !expected || typeof q.state !== 'string' || !safeEqual(q.state, expected)) {
        audit(db, 'kite.connect.failed', { userId: user.userId, ip: req.ip, detail: 'state mismatch' });
        return reply.redirect('/connect?kite=state', 302);
      }
      if (q.status !== 'success' || typeof q.request_token !== 'string' || q.request_token.length > 128) {
        audit(db, 'kite.connect.failed', { userId: user.userId, ip: req.ip, detail: `status=${String(q.status).slice(0, 20)}` });
        return reply.redirect('/connect?kite=denied', 302);
      }
      try {
        await kite.connect(q.request_token, user.userId, req.ip);
      } catch (e) {
        req.log.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'kite session exchange failed');
        audit(db, 'kite.connect.failed', { userId: user.userId, ip: req.ip, detail: 'token exchange failed' });
        return reply.redirect('/connect?kite=error', 302);
      }
      // Catch up today's candles in the background.
      void deps.live.runOnce();
      return reply.redirect('/connect?kite=ok', 302);
    });
  };
