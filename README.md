# signal — private Nifty crossover dashboard

A small, private, **read-only** web app. It watches the ITM Nifty weekly options through the official Kite Connect API, applies the CE/PE high–low crossover rules, stores **every signal in SQLite** (append-only), and charts each CPCP / PCPC / CCPP / PPCC event with its signal value.

It never places, modifies or cancels orders. The code calls only session, profile, instruments and historical-candle endpoints. A test (`test/safety.test.ts`) fails the build if any order, GTT or margin call appears in `src/`.

> Personal analysis tool. Not financial advice.

---

## Contents
1. [How a signal is made](#how-a-signal-is-made)
2. [Default assumptions](#default-assumptions-decisions-taken-for-you)
3. [Run it locally](#run-it-locally)
4. [Kite Connect app registration](#kite-connect-app-registration)
5. [Users (max 5)](#users-max-5)
6. [Deploy](#deploy)
7. [Backups and restore](#backups-and-restore)
8. [Security model](#security-model)
9. [Project layout and scripts](#project-layout-and-scripts)
10. [Manual checklist](#manual-checklist)

---

## How a signal is made

All rule logic is in [`src/server/signal/engine.ts`](src/server/signal/engine.ts): pure functions, no I/O. The constants live in one place, [`src/server/signal/config.ts`](src/server/signal/config.ts).

1. **Strikes** use a 50-point step. ITM CE = highest strike ≤ spot. ITM PE = lowest strike ≥ spot. Spot 22515 gives 22500 CE and 22550 PE. The contract is from the nearest weekly expiry in the Kite instruments dump, which is cached once per day.
2. **Four values** come from each candle: CE low, CE high, PE low and PE high.
3. **Sort ascending** and label each value C or P. That gives a 4-letter pattern.
4. **Signal value** applies only to the interleaved patterns, **CPCP and PCPC**. Take the two middle values:
   - if `|v1 − v2| ≤ 20` (inclusive), the value is the cross value, by default the average (`CROSS_VALUE_MODE`, which can also be `call` or `put`);
   - if `|v1 − v2| > 20`, the value is `(v1 + v2) / 2`.
5. **Trigger.** A signal fires when the pattern's group flips. Bullish = CCPP, CPCP. Bearish = PPCC, PCPC. The mapping is `DIRECTION_MAP`.
6. **Worked example** (this is a unit test). CE 102/202 and PE 85/165 sort to 85P 102C 165P 202C, giving **PCPC**. The middle values are 102 and 165, the diff is 63 > 20, so the value is **133.5**. The source document labels this CPCP; the sort is what counts.

Evaluation happens on every candle close (default **15-minute** candles, set by `TIMEFRAME`).

## Default assumptions (decisions taken for you)

| Topic | Default | Where to change |
|---|---|---|
| Patterns **CPPC / PCCP** (one range inside the other: possible, but missing from the source doc) | **Neutral**: stored as evaluations, but they never fire a signal and never reset direction. The next directional pattern is compared with the last *directional* one. | `DIRECTION_MAP` |
| Ties (equal values) | Deterministic order: **C before P**, then **low before high** | `sortPoints()` |
| Cross value for diff ≤ 20 | Average of the two middle values | `CROSS_VALUE_MODE` |
| Spot used for strikes | The **close** of that candle's Nifty 50 bar. Strikes are re-picked every candle. | `Processor.processDay` |
| Spot on an exact strike | CE and PE both use that strike | `selectStrikes()` |
| First candle with no history | Never fires; the first directional pattern only seeds the state | `isTrigger()` |
| Missing CE/PE candle or missing contract | The window is skipped (counted as `skipped`) | `Processor` |
| Live mode | **Polls historical candles** 8 seconds after each candle close, using the exact code path the backfill uses. The WebSocket ticker isn't used. | `LiveRunner` |
| Signal value on the chart | The premium pane holds the CE/PE high–low lines plus a short segment and label at the value. It is separate from the Nifty pane because spot (~24,000) and premium (~130) can't share a scale. | `chart.ts` |
| Candle colours | Monochrome (hollow up, filled down). **Green/red are reserved for bullish/bearish.** | `chart.ts` |
| Roles | `admin` can connect Kite and run backfills; `member` can only read | `npm run user:add -- … --admin` |
| Backfill limits | Kite only serves history for contracts that are **still listed**, so past expiries can't be replayed after they expire. Your stored history is kept forever. | — |
| Signals table | **Append-only**: SQLite triggers block UPDATE and DELETE | `drizzle/0001_guards.sql` |
| Demo data | `KITE_MODE=mock` uses a deterministic synthetic market, so you can see everything before you have Kite credentials | `src/server/kite/mock.ts` |

## Run it locally

Requires Node 22+.

```bash
npm install
```

```bash
cp .env.example .env
```

For local use, set these in `.env`: `NODE_ENV=development`, `KITE_MODE=mock`, `PUBLIC_ORIGIN=http://localhost:8080`, and any `TOKEN_ENC_KEY`.

```bash
npm run build:client
```

```bash
npm run user:add -- you@example.com --admin
```

```bash
npm run dev
```

Open **http://localhost:8080** (use `localhost`, not `127.0.0.1`: the Origin check compares against `PUBLIC_ORIGIN`). In mock mode the last week is replayed on boot, so the chart has data right away.

Quality gates:

```bash
npm run check
```

That runs lint, typecheck and the full test suite (unit, auth integration, processor, safety, backup).

## Kite Connect app registration

1. Sign in at **https://developers.kite.trade** and create an app (type: *Connect*). Make sure your plan includes **historical data**, which the chart and backfill need.
2. **Redirect URL**: `https://<your-domain>/kite/callback`. It must match exactly, scheme and path included.
3. Postback URL: leave it empty. The app takes no order postbacks.
4. Copy the **API key** and **API secret** into `.env` as `KITE_API_KEY` / `KITE_API_SECRET`. Set `KITE_MODE=live`.
5. Each trading morning, an admin opens **Kite & data → Connect Kite**, logs in at Zerodha, and is sent back to the app. Kite tokens expire around 06:00 IST. When a token expires or Kite rejects it, every page shows a **"Kite session expired — Reconnect Kite"** banner and live updates pause; nothing fails silently.

How the callback stays authenticated: the session cookie is `SameSite=Strict`, so the browser doesn't send it on the redirect back from Zerodha. The auth gate sends the callback to `/login?next=…`. The login page checks `/api/me` (a same-origin request, so the cookie is sent) and re-navigates on-site, at which point the cookie is present. A one-time `state` nonce, passed through Kite's `redirect_params`, stops cross-site request forgery on the callback.

The access token is encrypted at rest with AES-256-GCM using `TOKEN_ENC_KEY`. It never reaches the browser and never appears in logs (query strings are stripped from request logs).

## Users (max 5)

There is **no signup route**. Users are created only from the CLI on the server:

```bash
npm run user:add -- someone@example.com            # member
npm run user:add -- someone@example.com --admin    # admin
npm run user:list
npm run user:disable -- someone@example.com        # also ends their sessions
npm run user:add -- --reset someone@example.com    # new one-time password
```

A strong random password is printed **once**; share it privately. To set your own password instead, pipe it in with `--password-stdin` (at least 12 characters).

The **hard cap of 5 active users** is enforced twice: in code (`createUser`) and by SQLite triggers on INSERT and on re-activation. Both are covered by tests. To add a sixth person, disable someone first.

Inside Docker:

```bash
docker compose exec app node dist/server/server/cli/user.js add someone@example.com --admin
```

## Deploy

One container (`Dockerfile`) and one volume (`/data`) holding the database and daily backups. All configuration comes from environment variables (`.env.example`).

### Option A (recommended): VPS + Cloudflare Tunnel + Cloudflare Access

Nothing listens on the open internet. The app binds to `127.0.0.1`, and `cloudflared` dials out to Cloudflare. Cloudflare Access only lets your 5 emails through, before a request ever reaches the app.

1. Get a small VPS (Hetzner CX22 or a DigitalOcean $6 droplet), install Docker, and clone this repo to `/opt/signal`.
2. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create tunnel** (cloudflared). Copy the token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. In the tunnel, add a **public hostname**: `signal.yourdomain.com` → service `http://app:8080`.
4. **Zero Trust → Access → Applications → Add → Self-hosted**: domain `signal.yourdomain.com`. Policy: *Allow*, rule *Emails*, list the 5 addresses. Session duration: 24h.
5. Fill in `.env` (`PUBLIC_ORIGIN=https://signal.yourdomain.com`, `TOKEN_ENC_KEY`, Kite keys, `TRUST_PROXY=true`).
6. Start it:
   ```bash
   docker compose --profile tunnel up -d --build
   ```
7. Create users (see above), then register the Kite redirect URL.

The Kite redirect back to `/kite/callback` is a normal top-level navigation, so the Access cookie travels with it.

### Option B: Tailscale (no public hostname at all)

Install Tailscale on the VPS and on each user's device, then share the machine with just those users. Run Caddy with `SIGNAL_DOMAIN=<machine>.<tailnet>.ts.net` and use `tailscale cert` for TLS, or use `tailscale serve --https=443 http://127.0.0.1:8080`. Kite's redirect works too, because the browser that follows it is on the tailnet.

### Option C: Public VPS + Caddy (automatic HTTPS)

```bash
docker compose --profile caddy up -d --build
```

Point DNS at the server and set `SIGNAL_DOMAIN`. Caddy obtains Let's Encrypt certificates. Use this only together with Cloudflare Access (proxied DNS) or IP allowlisting in the firewall. The app's own login is solid, but the brief asks that it not be reachable at all.

### Fly.io / Railway

Both work with the Dockerfile. Attach a persistent volume mounted at `/data` (Fly: `fly volumes create signal_data --size 1`, then `[mounts] destination="/data"`), set secrets with `fly secrets set` / Railway variables, and run a single instance (SQLite is single-writer). Put Cloudflare Access in front of the custom domain.

### Health

`GET /healthz` answers `{"ok":true}` only to loopback (the container's own HEALTHCHECK) or to signed-in users. Everyone else gets the login redirect.

## Backups and restore

- **Automatic**: the app writes a consistent online snapshot (SQLite backup API, safe while writing) to `/data/backups/signal-YYYY-MM-DD.db` once a day and keeps the newest `BACKUP_KEEP` (default 14).
- **On demand**:
  ```bash
  docker compose exec app node dist/server/server/cli/backup.js
  ```
- **Off-site** (recommended): `deploy/backup-offsite.sh` uploads the newest snapshot with `rclone`; schedule it from host cron (instructions are in the file).
- **Restore**:
  ```bash
  docker compose stop app
  VOL=$(docker volume inspect -f '{{ .Mountpoint }}' signal_signal-data)
  cp "$VOL/backups/signal-2026-11-14.db" "$VOL/signal.db"
  rm -f "$VOL/signal.db-wal" "$VOL/signal.db-shm"
  docker compose start app
  ```

## Security model

- **Every** page, API and asset sits behind the session gate. Pages redirect to `/login`; APIs return `401` with no data. The only public resources are `/login`, the separate login bundle under `/_l/` (no app code), `POST /api/auth/login`, and `robots.txt` (disallow all). The integration test walks every route without a session.
- Passwords use **argon2id** (19 MiB, t=2). Lockout: 15 minutes after 5 failures per account. Rate limit: 10 login attempts per IP per 15 minutes. Unknown emails take the same time and get the same message as wrong passwords.
- Sessions: random 256-bit token, stored only as a SHA-256 hash, cookie `__Host-sid` (`HttpOnly; Secure; SameSite=Strict`). They expire after 12h absolute or 4h idle.
- CSRF has two layers: an exact `Origin` check on every non-GET request, plus a per-session synchroniser token (`X-CSRF-Token`) on authenticated mutations. Login accepts only JSON.
- Headers (helmet): strict CSP (`default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`), HSTS, `nosniff`, `Referrer-Policy: no-referrer`, a restrictive Permissions-Policy, `X-Robots-Tag: noindex` on every response, and `Cache-Control: no-store` except for hashed assets. The page title is just "Sign in" / "Signal".
- Fonts and the chart library are bundled and self-hosted. There are no CDN or third-party requests at runtime.
- The audit log records logins, failures, lockouts, logouts, Kite connects/expiries/failures, backfills and user changes. Secrets, tokens and passwords are never logged.
- `npm audit --omit=dev` is clean. `kiteconnect` wrongly ships `mocha` as a runtime dependency, so `serialize-javascript` is pinned to a patched version via `overrides`. The remaining moderate advisories are in dev-only tooling (drizzle-kit, typescript-eslint) and never reach the image.
- Container: non-root user, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, port bound to `127.0.0.1`.

## Project layout and scripts

```
src/server/signal/      pure engine + config   (unit-tested)
src/server/kite/        read-only client interface, real adapter, mock market, throttle/retry
src/server/services/    processor (backfill = live), live runner, Kite session, backup
src/server/auth/        users (5-cap, argon2, lockout), sessions
src/server/routes/      auth, api, kite
src/server/cli/         user, backfill, backup
src/client/app/         chart (Lightweight Charts v5), panel, history table, connect page
src/client/login/       separate public login bundle
drizzle/                SQL migrations (+ append-only and user-cap triggers)
deploy/                 Caddyfile, off-site backup script
test/                   engine, processor, auth/route integration, safety, backup
```

| Script | What it does |
|---|---|
| `npm run dev` | watch-build both bundles + run the server with tsx |
| `npm run build` / `npm start` | production build / run |
| `npm run check` | lint + typecheck + tests |
| `npm run backfill -- 2026-11-02 2026-11-13 [15minute]` | replay a date range from the CLI |
| `npm run db:backup` | snapshot now |
| `npm run db:generate` | new migration after editing `schema.ts` |

The schema avoids SQLite-only types: integer epoch seconds, `real` prices, and JSON as `text`. Moving to Postgres means switching the drizzle dialect, regenerating migrations, and rewriting the two trigger files as PL/pgSQL.

## Manual checklist

Things only you can do:

- [ ] **Kite**: create the Connect app at developers.kite.trade (with historical data) and copy the API key and secret into `.env`.
- [ ] **Kite**: set the redirect URL to `https://<your-domain>/kite/callback`.
- [ ] **Secrets**: generate `TOKEN_ENC_KEY` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and keep `.env` out of git (already in `.gitignore`).
- [ ] **Server**: provision a VPS, install Docker, clone the repo, and fill in `.env` (`PUBLIC_ORIGIN`, `KITE_MODE=live`, `TRUST_PROXY=true`).
- [ ] **DNS**: add the domain to Cloudflare (or set an A record for the Caddy option).
- [ ] **Cloudflare**: create the Tunnel, the public hostname, and the **Access application with an allowlist of the 5 emails**.
- [ ] **Start**: `docker compose --profile tunnel up -d --build`.
- [ ] **Users**: create the admin(s) and members (max 5) and send each their one-time password privately.
- [ ] **Daily**: an admin clicks **Connect Kite** each trading morning.
- [ ] **Backups**: configure `rclone` and schedule `deploy/backup-offsite.sh` in cron. Test a restore once.
- [ ] Optionally, run a backfill from **Kite & data** to fill the chart with recent sessions.
