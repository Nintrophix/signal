import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { audit } from '../audit.js';
import { createSession, destroySession } from '../auth/sessions.js';
import { checkLogin } from '../auth/users.js';

const LoginBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(256),
});

export const authRoutes =
  (deps: AppDeps, cookieName: string): FastifyPluginAsync =>
  async (app) => {
    const { db, config } = deps;

    app.post(
      '/api/auth/login',
      {
        config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      },
      async (req, reply) => {
        // JSON-only: forces a CORS preflight for any cross-site attempt.
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return reply.code(415).send({ error: 'unsupported media type' });
        }
        const body = LoginBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'Email and password are required.' });

        const result = await checkLogin(db, body.data.email, body.data.password);
        if (!result.ok) {
          audit(db, result.reason === 'locked' ? 'login.locked' : 'login.failure', {
            ip: req.ip,
            detail: `email=${body.data.email.slice(0, 254).toLowerCase()}`,
          });
          const msg =
            result.reason === 'locked'
              ? 'Too many attempts. This account is locked for 15 minutes.'
              : 'Email or password is incorrect.';
          return reply.code(401).send({ error: msg });
        }

        const { token } = createSession(db, result.user.id, config.SESSION_TTL_HOURS);
        audit(db, 'login.success', { userId: result.user.id, ip: req.ip });
        reply.setCookie(cookieName, token, {
          path: '/',
          httpOnly: true,
          secure: config.cookieSecure,
          sameSite: 'strict',
          maxAge: Math.round(config.SESSION_TTL_HOURS * 3600),
        });
        return { ok: true };
      },
    );

    app.post('/api/auth/logout', async (req, reply) => {
      if (req.user) {
        destroySession(db, req.user.sessionId);
        audit(db, 'logout', { userId: req.user.userId, ip: req.ip });
      }
      reply.clearCookie(cookieName, { path: '/' });
      return { ok: true };
    });

    app.get('/api/me', async (req) => ({
      email: req.user!.email,
      role: req.user!.role,
      csrfToken: req.user!.csrfToken,
    }));
  };
