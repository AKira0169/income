/* server/main.ts — the api process: migrate, then serve, then run jobs.

   Migrations connect as the superuser (they create tables); everything after
   connects as `app`, which owns nothing, so RLS applies to every request. */

import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { connect } from './db.ts';
import { startJobs } from './jobs.ts';
import { kratosWhoami } from './kratos.ts';
import { migrate } from './migrate.ts';
import { cachedWhoami } from './session.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const appDomain = required('APP_DOMAIN');

const admin = connect(required('MIGRATION_DATABASE_URL'), { max: 1 });
const applied = await migrate(admin);
await admin.end();
if (applied.length) console.log(JSON.stringify({ migrated: applied }));

const sql = connect(required('DATABASE_URL'));
const app = createApp({
  sql,
  appOrigin: `https://${appDomain}`,
  whoami: cachedWhoami(kratosWhoami(process.env['KRATOS_PUBLIC_URL'] ?? 'http://kratos:4433'))
});
const jobs = startJobs(sql);

const port = Number(process.env['PORT'] ?? 3000);
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' },
  (info) => console.log(JSON.stringify({ listening: info.port })));

const shutdown = (): void => {
  jobs.stop();
  server.close(() => { void sql.end().then(() => process.exit(0)); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
