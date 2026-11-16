import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { loadSession, type SessionUser } from './auth/sessions.js';
import type { Config } from './config.js';
import { safeEqual } from './crypto.js';
import type { DB } from './db/client.js';
import type { MarketDataClient } from './kite/types.js';
import { apiRoutes } from './routes/api.js';
import { authRoutes } from './routes/auth.js';
import { kiteRoutes } from './routes/kite.js';
import type { BackfillJob } from './services/backfill.js';
import type { KiteSession } from './services/kiteSession.js';
import type { LiveRunner } from './services/live.js';
import type { Processor } from './services/processor.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export interface AppDeps {
  config: Config;
  db: DB;
  client: MarketDataClient;
  kite: KiteSession;
  processor: Processor;
  live: LiveRunner;
  backfill: BackfillJob;
  clientDir?: string;
}

export const sessionCookieName = (secure: boolean) => (secure ? '__Host-sid' : 'sid');

/** Exact (method, path) pairs reachable without a session. */
const PUBLIC_ROUTES = new Set(['GET /login', 'HEAD /login', 'POST /api/auth/login', 'GET /robots.txt', 'HEAD /robots.txt']);
const PUBLIC_PREFIX = '/_l/'; // login-page assets only (separate bundle, no app code)
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const APP_PAGES = new Set(['/', '/connect', '/history']);

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export async function buildApp(deps: AppDeps) {
  const { config, db } = deps;
  const clientDir = deps.clientDir ?? path.resolve('dist/client');
  const cookieName = sessionCookieName(config.cookieSecure);

  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 32 * 1024,
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
            serializers: {
              // Strip query strings: they may carry Kite request tokens.
              req: (req) => ({ method: req.method, url: req.url.split('?')[0], ip: req.ip }),
            },
          },
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: config.cookieSecure ? { maxAge: 63072000, includeSubDomains: true, preload: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });

  app.decorateRequest('user', null);

  // ── Auth gate: every request, including static assets ──────────────────
  app.addHook('onRequest', async (req, reply) => {
    const urlPath = req.url.split('?')[0]!;
    const token = req.cookies[cookieName];
    req.user = loadSession(db, token);

    // CSRF layer 1: unsafe methods must come from our own origin.
    if (!SAFE_METHODS.has(req.method) && !sameOrigin(req, config.PUBLIC_ORIGIN)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    if (req.user) {
      // CSRF layer 2: synchroniser token for authenticated unsafe requests.
      if (!SAFE_METHODS.has(req.method)) {
        const sent = req.headers['x-csrf-token'];
        if (typeof sent !== 'string' || !safeEqual(sent, req.user.csrfToken)) {
          return reply.code(403).send({ error: 'forbidden' });
        }
      }
      return;
    }

    if (PUBLIC_ROUTES.has(`${req.method} ${urlPath}`)) return;
    if ((req.method === 'GET' || req.method === 'HEAD') && urlPath.startsWith(PUBLIC_PREFIX)) return;
    if (urlPath === '/healthz' && isLoopback(req.socket.remoteAddress ?? '')) return;

    if (token) reply.clearCookie(cookieName, { path: '/' });
    return denyUnauthenticated(req, reply, urlPath);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    const urlPath = req.url.split('?')[0]!;
    if (/\/assets\/.+-[A-Za-z0-9_-]{8,}\.\w+$/.test(urlPath)) {
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // ── Public bits ─────────────────────────────────────────────────────────
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));

  const html = (name: 'app' | 'login') => {
    const file = path.join(clientDir, name, 'index.html');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  const cache = new Map<string, string | null>();
  const page = (name: 'app' | 'login') => {
    if (config.NODE_ENV !== 'production') return html(name);
    if (!cache.has(name)) cache.set(name, html(name));
    return cache.get(name)!;
  };

  app.get('/login', async (req, reply) => {
    if (req.user) return reply.redirect(safeNext((req.query as { next?: string }).next));
    const body = page('login');
    if (!body) return reply.code(503).type('text/plain').send('Client not built. Run npm run build:client.');
    return reply.type('text/html; charset=utf-8').send(body);
  });

  if (fs.existsSync(path.join(clientDir, 'login'))) {
    await app.register(fastifyStatic, { root: path.join(clientDir, 'login'), prefix: PUBLIC_PREFIX, decorateReply: false, index: false, wildcard: true });
  }
  if (fs.existsSync(path.join(clientDir, 'app', 'assets'))) {
    await app.register(fastifyStatic, { root: path.join(clientDir, 'app', 'assets'), prefix: '/assets/', decorateReply: false, index: false });
  }

  app.get('/healthz', async () => ({ ok: true }));

  // ── Authenticated app shell ─────────────────────────────────────────────
  for (const p of APP_PAGES) {
    app.get(p, async (_req, reply) => {
      const body = page('app');
      if (!body) return reply.code(503).type('text/plain').send('Client not built. Run npm run build:client.');
      return reply.type('text/html; charset=utf-8').send(body);
    });
  }

  await app.register(authRoutes(deps, cookieName));
  await app.register(apiRoutes(deps));
  await app.register(kiteRoutes(deps));

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.code(404).type('text/plain').send('Not found');
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err: err.message }, 'request failed');
    reply.code(status).send({ error: status === 429 ? 'too many requests' : status >= 500 ? 'internal error' : err.message });
  });

  return app;
}

function denyUnauthenticated(req: FastifyRequest, reply: FastifyReply, urlPath: string) {
  const isApi = urlPath.startsWith('/api/');
  if (isApi || (req.method !== 'GET' && req.method !== 'HEAD')) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const next = req.url;
  const target = next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login';
  return reply.redirect(target, 302);
}

function sameOrigin(req: FastifyRequest, expected: string): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string') return origin === expected;
  const referer = req.headers.referer;
  if (typeof referer === 'string') {
    try {
      return new URL(referer).origin === expected;
    } catch {
      return false;
    }
  }
  return false;
}

/** Only allow same-site relative redirects. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}
