# Deploying Income Tracker

On [Dokploy](https://dokploy.com), as a Docker Compose app from this
repository. Dokploy's Traefik holds the HTTPS certificate (Let's Encrypt) and
forwards your domain to one service, `caddy`, which routes everything else
inside the stack.

## What runs

| Service | What it is |
| --- | --- |
| `caddy` | The stack's one entrypoint, plain HTTP on port 80, no ports published. Serves the web app, proxies `/auth/*` to Kratos and `/api/*` to the api. Built with the `caddy-ratelimit` plugin: 20 sign-in form submissions a minute per visitor IP (read from Traefik's `X-Forwarded-For`), 600 api requests. Sends HSTS, a strict CSP and no-framing headers. |
| `api` | Node 26, Hono. Applies database migrations on start, then serves. Fetches the gold price once a day. |
| `kratos` | Ory Kratos v1.3.1: accounts, passwords, 2FA, email verification and recovery. Its admin API is never exposed. |
| `config-check` | Checks the environment settings before anything else starts, then exits. A failed deploy that stops here names the bad setting in its log. |
| `kratos-migrate` | Runs Kratos's own migrations once, then exits. |
| `postgres` | Postgres 17, two databases: `app` and `kratos`. Data in the `pgdata` volume. |

## First deployment

1. **DNS.** Create an `A` record for your domain (e.g. `money.example.com`)
   pointing at the Dokploy server's IP.
2. **Create the app.** In Dokploy: your project → **Create Service → Compose**.
   - Source: this Git repository and branch `main`.
   - Compose type: **Docker Compose** (not Stack — Stack mode cannot `build`).
   - Compose path: `./deploy/compose.yaml`.
3. **Environment.** In the app's **Environment** tab, paste the contents of
   [`.env.example`](.env.example) and fill every value. Generate the secrets with:

   ```bash
   openssl rand -hex 32   # POSTGRES_PASSWORD, APP_DB_PASSWORD, KRATOS_DB_PASSWORD, KRATOS_COOKIE_SECRET — one each
   openssl rand -hex 16   # KRATOS_CIPHER_SECRET — must be exactly 32 characters
   ```

   Use only those generated values: **no symbols**. The passwords go inside
   `postgres://` connection URLs, and Compose deletes anything after a `$`.
   The cipher secret must be exactly 32 characters. If a value is wrong, the
   `config-check` service stops the deploy and its log says which and why.

   `APP_DOMAIN` is the bare domain (`money.example.com`, no `https://`).
   `SMTP_URI` / `SMTP_FROM` must be a real mail provider: verification and
   recovery codes are sent by email. Dokploy writes these to a `.env` beside
   the compose file and passes it to `docker compose`, which is what fills in
   the `${…}` in `compose.yaml`.
4. **Domain.** In the **Domains** tab, add one domain:
   - Service: `caddy`, container port `80`, host `money.example.com`, path `/`
   - HTTPS on, certificate **Let's Encrypt**

   Do not add domains for `api` or `kratos`: Caddy reaches them on the
   stack's own network, and Kratos's admin port must stay unreachable.
5. **Deploy.** Press **Deploy** and follow the log. If a deploy fails at
   `config-check` or `kratos-migrate`, the reason is in that service's log
   (**Logs** tab, or `docker logs <app>-config-check-1`). After changing a
   password, delete the `pgdata` volume before redeploying if the database
   holds nothing yet: Postgres keeps the passwords it was first started with. The first build takes a
   few minutes (the web bundle and Caddy's rate-limit plugin are compiled).
6. **Check.** `https://money.example.com` shows the sign-in screen;
   `curl https://money.example.com/auth/health/ready` prints `{"status":"ok"}`.
   Create your account, then **Settings → Import backup (.json)** with the
   backup downloaded from the offline version.

## Backups

The database is the only state worth keeping. Either use Dokploy's
**Volume Backups** on the `pgdata` volume, or a nightly dump from a Dokploy
**Schedule** (or the server's cron), kept for 14 days:

```bash
docker exec "$(docker ps -qf name=postgres -f label=com.docker.compose.service=postgres | head -1)" \
  pg_dumpall -U postgres | gzip > /var/backups/income-$(date +%F).sql.gz
find /var/backups -name 'income-*.sql.gz' -mtime +14 -delete
```

Copy the dumps off the server too. To restore onto a fresh stack: let only
`postgres` start, `gunzip -c income-YYYY-MM-DD.sql.gz | docker exec -i <postgres container> psql -U postgres`,
then redeploy.

Each user can also download their own JSON backup from **Settings**.

## Upgrades

Push to `main` and press **Deploy** (or turn on auto-deploy for the
repository). The api applies new migrations on start. Before a Kratos version
bump, take a backup, change the tag in `deploy/compose.yaml` for both
`kratos` and `kratos-migrate`, and read Ory's upgrade notes for that release.

## Logs

In Dokploy, the app's **Logs** tab, service `api`. The api logs one JSON line
per request with a `requestId`; the same id is in the `x-request-id` response
header, so a user's error can be found in the log.

## Without Dokploy

Any reverse proxy that terminates HTTPS for `$APP_DOMAIN` and forwards it to
`caddy:80` (on the same Docker network, with `X-Forwarded-For` set) works the
same way. For local development, `pnpm stack:dev` runs the stack with Caddy
doing its own HTTPS on `https://localhost` instead.
