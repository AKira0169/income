# Deploying Income Tracker

One Linux server, one domain, Docker Compose. Caddy gets the HTTPS
certificate from Let's Encrypt by itself.

## What runs

| Service | What it is |
| --- | --- |
| `caddy` | The only public port (80/443). Serves the web app, proxies `/auth/*` to Kratos and `/api/*` to the api. Built with the `caddy-ratelimit` plugin: 20 sign-in form submissions a minute per IP, 600 api requests. Sends HSTS, a strict CSP and no-framing headers. |
| `api` | Node 26, Hono. Applies database migrations on start, then serves. Fetches the gold price once a day. |
| `kratos` | Ory Kratos v1.3.1: accounts, passwords, 2FA, email verification and recovery. Its admin API is never exposed. |
| `kratos-migrate` | Runs Kratos's own migrations once, then exits. |
| `postgres` | Postgres 17, two databases: `app` and `kratos`. Data in the `pgdata` volume. |

## First deployment

1. **DNS.** Create an `A` record for your domain (e.g. `money.example.com`)
   pointing at the server's public IP. Wait until `dig +short money.example.com`
   prints that IP — Caddy needs it to get a certificate.
2. **Server.** Install Docker Engine with the Compose plugin. Open ports 80 and
   443 (TCP) and 443 (UDP) in the firewall.
3. **Code.** `git clone` this repository onto the server and `cd` into it.
4. **Configuration.**

   ```bash
   cp deploy/.env.example deploy/.env
   openssl rand -hex 32   # POSTGRES_PASSWORD, APP_DB_PASSWORD, KRATOS_DB_PASSWORD, KRATOS_COOKIE_SECRET — one each
   openssl rand -hex 16   # KRATOS_CIPHER_SECRET — must be exactly 32 characters
   ```

   Edit `deploy/.env`: set `APP_DOMAIN`, paste the secrets, and fill in
   `SMTP_URI` / `SMTP_FROM` with a real mail provider (verification and
   recovery codes are sent by email). `chmod 600 deploy/.env`.
5. **Start.**

   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
   docker compose --env-file deploy/.env -f deploy/compose.yaml ps
   ```

6. **Check.** `https://money.example.com` shows the sign-in screen;
   `curl https://money.example.com/auth/health/ready` prints `{"status":"ok"}`.
   Create your account, then **Settings → Import backup (.json)** with the
   backup downloaded from the offline version.

## Backups

The database is the only state worth keeping (Caddy's certificates are
re-issued if lost). A nightly dump, kept for 14 days — `crontab -e`:

```cron
15 3 * * * cd /srv/income && docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres pg_dumpall -U postgres | gzip > /var/backups/income-$(date +\%F).sql.gz && find /var/backups -name 'income-*.sql.gz' -mtime +14 -delete
```

Copy `/var/backups` off the server too. To restore onto a fresh stack: start
only `postgres`, then
`gunzip -c income-YYYY-MM-DD.sql.gz | docker compose … exec -T postgres psql -U postgres`,
then start everything else.

Each user can also download their own JSON backup from **Settings**.

## Upgrades

```bash
git pull
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

The api applies new migrations on start. Before a Kratos version bump, take a
backup, change the tag in `deploy/compose.yaml` for both `kratos` and
`kratos-migrate`, and read Ory's upgrade notes for that release.

## Logs

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f api
```

The api logs one JSON line per request with a `requestId`; the same id is in
the `x-request-id` response header, so a user's error can be found in the log.
