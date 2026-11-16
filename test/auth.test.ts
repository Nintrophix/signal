import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { createUser, disableUser, UserCapError } from '../src/server/auth/users.js';
import { loadConfig } from '../src/server/config.js';
import { createContext } from '../src/server/context.js';
import { openDb } from '../src/server/db/client.js';
import { auditLog, instruments, kiteTokens, users } from '../src/server/db/schema.js';
import { MockKiteClient } from '../src/server/kite/mock.js';

const ORIGIN = 'https://signal.test';
const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: ORIGIN,
  TOKEN_ENC_KEY: 'a'.repeat(64),
  KITE_MODE: 'mock',
  DATABASE_PATH: ':memory:',
});
const db = openDb(':memory:');
const client = new MockKiteClient();
const ctx = createContext(config, { db, client });
let app: Awaited<ReturnType<typeof buildApp>>;
const COOKIE = '__Host-sid';
const PW = 'correct horse battery staple';

beforeAll(async () => {
  app = await buildApp({ ...ctx, clientDir: 'does-not-exist' });
  await createUser(db, 'admin@example.com', PW, 'admin');
  await createUser(db, 'member@example.com', PW, 'member');
});
afterAll(async () => {
  await app.close();
  db.$client.close();
});

let ipCounter = 1;
async function login(email: string, password = PW, ip = `198.51.100.${ipCounter++ % 250}`) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: ip,
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: { email, password },
  });
  const c = res.cookies.find((x) => x.name === COOKIE);
  return { res, cookie: c?.value };
}

// Every route the app exposes (pages, APIs, assets, admin, kite flow).
const PROTECTED: Array<[string, string]> = [
  ['GET', '/'],
  ['GET', '/connect'],
  ['GET', '/history'],
  ['GET', '/assets/index-abc12345.js'],
  ['GET', '/assets/anything.css'],
  ['GET', '/api/me'],
  ['GET', '/api/status'],
  ['GET', '/api/meta'],
  ['GET', '/api/candles'],
  ['GET', '/api/evaluations'],
  ['GET', '/api/signals'],
  ['GET', '/api/signals.csv'],
  ['GET', '/api/signals/1'],
  ['POST', '/api/backfill'],
  ['POST', '/api/auth/logout'],
  ['GET', '/kite/connect'],
  ['GET', '/kite/callback?request_token=x&state=y&status=success'],
  ['GET', '/healthz'],
  ['GET', '/some/unknown/path'],
  ['GET', '/api/unknown'],
  ['DELETE', '/api/signals/1'],
];

describe('unauthenticated access is denied everywhere', () => {
  for (const [method, url] of PROTECTED) {
    it(`${method} ${url}`, async () => {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { origin: ORIGIN },
        remoteAddress: '203.0.113.9',
      });
      if (url.startsWith('/api/') || method !== 'GET') {
        expect(res.statusCode === 401 || res.statusCode === 403).toBe(true);
        expect(res.body).not.toMatch(/signal_value|ce_strike|email/i);
      } else {
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toMatch(/^\/login/);
        expect(res.body).toBe('');
      }
      expect(res.headers['x-robots-tag']).toContain('noindex');
    });
  }

  it('a forged/unknown session cookie is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE]: 'forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('robots.txt disallows everything', async () => {
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Disallow: /');
  });

  it('health endpoint is reachable from loopback only', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', remoteAddress: '127.0.0.1' });
    expect(res.statusCode).toBe(200);
  });

  it('security headers are set', async () => {
    const res = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('login', () => {
  it('rejects a wrong password with a generic message', async () => {
    const { res } = await login('admin@example.com', 'wrong password!!');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Email or password is incorrect.');
  });

  it('unknown email gets the same message', async () => {
    const { res } = await login('nobody@example.com', 'whatever whatever');
    expect(res.json().error).toBe('Email or password is incorrect.');
  });

  it('requires our Origin (CSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { email: 'admin@example.com', password: PW },
    });
    expect(res.statusCode).toBe(403);
  });

  it('sets an httpOnly, Secure, SameSite=Strict cookie', async () => {
    const { res, cookie } = await login('admin@example.com');
    expect(res.statusCode).toBe(200);
    expect(cookie).toBeTruthy();
    const c = res.cookies.find((x) => x.name === COOKIE)!;
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe('Strict');
  });

  it('authenticated session can read the API', async () => {
    const { cookie } = await login('admin@example.com');
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE]: cookie! } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('admin@example.com');
    const sig = await app.inject({ method: 'GET', url: '/api/signals', cookies: { [COOKIE]: cookie! } });
    expect(sig.statusCode).toBe(200);
  });

  it('authenticated POST without CSRF token is rejected', async () => {
    const { cookie } = await login('admin@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN },
      cookies: { [COOKIE]: cookie! },
    });
    expect(res.statusCode).toBe(403);
  });

  it('logout with CSRF token ends the session', async () => {
    const { cookie } = await login('admin@example.com');
    const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE]: cookie! } });
    const csrf = me.json().csrfToken as string;
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: ORIGIN, 'x-csrf-token': csrf },
      cookies: { [COOKIE]: cookie! },
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/me', cookies: { [COOKIE]: cookie! } });
    expect(after.statusCode).toBe(401);
  });

  it('locks the account after 5 failures', async () => {
    await createUser(db, 'lock@example.com', PW);
    for (let i = 0; i < 4; i++) expect((await login('lock@example.com', 'nope nope nope')).res.statusCode).toBe(401);
    const fifth = await login('lock@example.com', 'nope nope nope');
    expect(fifth.res.json().error).toMatch(/locked/);
    const right = await login('lock@example.com', PW);
    expect(right.res.statusCode).toBe(401);
    expect(right.res.json().error).toMatch(/locked/);
    disableUser(db, 'lock@example.com');
  });

  it('rate-limits login attempts per IP (10 / 15 min)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await login('nobody@example.com', 'whatever whatever', '192.0.2.77')).res.statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('audit-logs logins', () => {
    const events = db.select().from(auditLog).all().map((r) => r.event);
    expect(events).toContain('login.success');
    expect(events).toContain('login.failure');
    expect(events).toContain('login.locked');
    // No passwords in the audit log.
    expect(JSON.stringify(db.select().from(auditLog).all())).not.toContain(PW);
  });

  it('disabled users cannot log in', async () => {
    const { res } = await login('lock@example.com');
    expect(res.statusCode).toBe(401);
  });
});

describe('5-user hard cap', () => {
  it('a 6th active user cannot be created (code)', async () => {
    const fresh = openDb(':memory:');
    for (let i = 1; i <= 5; i++) await createUser(fresh, `u${i}@example.com`, PW);
    await expect(createUser(fresh, 'u6@example.com', PW)).rejects.toBeInstanceOf(UserCapError);
    fresh.$client.close();
  });

  it('a 6th active user cannot be inserted even bypassing code (DB trigger)', async () => {
    const fresh = openDb(':memory:');
    for (let i = 1; i <= 5; i++) await createUser(fresh, `u${i}@example.com`, PW);
    expect(() => fresh.insert(users).values({ email: 'raw@example.com', passwordHash: 'x' }).run()).toThrow(/user cap/);
    fresh.$client.close();
  });

  it('re-enabling a disabled user past the cap is blocked', async () => {
    const fresh = openDb(':memory:');
    for (let i = 1; i <= 5; i++) await createUser(fresh, `u${i}@example.com`, PW);
    disableUser(fresh, 'u1@example.com');
    await createUser(fresh, 'u6@example.com', PW);
    expect(() => fresh.$client.prepare("UPDATE users SET active = 1 WHERE email = 'u1@example.com'").run()).toThrow(/user cap/);
    fresh.$client.close();
  });

  it('there is no signup route', async () => {
    for (const url of ['/api/auth/signup', '/api/auth/register', '/api/users', '/signup', '/register']) {
      const res = await app.inject({ method: 'POST', url, headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('kite connect flow', () => {
  it('admin round-trip with state nonce stores an encrypted token', async () => {
    const { cookie } = await login('admin@example.com');
    const go = await app.inject({ method: 'GET', url: '/kite/connect', cookies: { [COOKIE]: cookie! } });
    expect(go.statusCode).toBe(302);
    const cb = await app.inject({ method: 'GET', url: go.headers.location as string, cookies: { [COOKIE]: cookie! } });
    expect(cb.headers.location).toBe('/connect?kite=ok');
    const row = db.select().from(kiteTokens).all().at(-1)!;
    expect(row.accessTokenEnc.startsWith('v1:')).toBe(true);
    expect(row.accessTokenEnc).not.toContain('mock-');
    expect(db.select().from(auditLog).all().map((r) => r.event)).toContain('kite.connect');
  });

  it('a callback with the wrong state is refused', async () => {
    const { cookie } = await login('admin@example.com');
    await app.inject({ method: 'GET', url: '/kite/connect', cookies: { [COOKIE]: cookie! } });
    const cb = await app.inject({
      method: 'GET',
      url: '/kite/callback?status=success&request_token=x&state=forged',
      cookies: { [COOKIE]: cookie! },
    });
    expect(cb.headers.location).toBe('/connect?kite=state');
  });

  it('members cannot connect Kite', async () => {
    const { cookie } = await login('member@example.com');
    const res = await app.inject({ method: 'GET', url: '/kite/connect', cookies: { [COOKIE]: cookie! } });
    expect(res.statusCode).toBe(403);
  });

  it('expired Kite token surfaces as "expired" status', async () => {
    const { cookie } = await login('member@example.com');
    // Let the callback's background catch-up finish, then force fresh API calls.
    while (ctx.live.state.running) await new Promise((r) => setTimeout(r, 10));
    db.delete(instruments).run();
    client.expired = true;
    await ctx.live.runOnce();
    const st = await app.inject({ method: 'GET', url: '/api/status', cookies: { [COOKIE]: cookie! } });
    expect(st.json().kite.status).toBe('expired');
    client.expired = false;
  });
});
