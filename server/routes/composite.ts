/* server/routes/composite.ts — the writes that are more than one upsert.

   Each is one call to the same domain function the offline app called, run
   through mutate(): borrowing is an account and a movement in one domain call
   and therefore one transaction, catch-up is however many months it is, an
   import is the whole state. Concurrency is the lock's job (and the unique
   keys' as a backstop), not these handlers'. */

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as Backup from '../../src/domain/backup.ts';
import * as Debt from '../../src/domain/debt.ts';
import * as Forecast from '../../src/domain/forecast.ts';
import { todayISO } from '../../src/domain/period.ts';
import * as Records from '../../src/domain/records.ts';
import * as Reconcile from '../../src/domain/reconcile.ts';
import * as Recurring from '../../src/domain/recurring.ts';
import { isDebtAccount } from '../../src/domain/selectors.ts';
import type { AppState } from '../../src/domain/types.ts';
import type { AppDeps, AppEnv } from '../app.ts';
import { withUser } from '../db.ts';
import { HttpError } from '../errors.ts';
import { mutate } from '../mutate.ts';
import type { Mutation } from '../mutate.ts';
import { loadState } from '../repo.ts';
import {
  borrowBody, generateBody, goalBody, linkBody, moveBody, reconcileBody, repayBody
} from '../validate.ts';

/** A backup of several years is a few hundred KB; this is far beyond that. */
const IMPORT_LIMIT = 10 * 1024 * 1024;

export function compositeRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const write = <R>(userId: string, run: (state: AppState) => Mutation<R>) => mutate(deps.sql, userId, run);

  app.post('/api/recurring/catch-up', async (c) =>
    c.json(await write(c.get('userId'), (state) => Recurring.catchUp(state))));

  app.post('/api/recurring/generate', async (c) => {
    const { collection, period } = generateBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => {
      const made = collection === 'bills' ? Recurring.generateBills(state, period) : Recurring.generateIncome(state, period);
      return { state: made.state, result: made.created };
    }));
  });

  app.post('/api/recurring/link', async (c) => {
    const { collection, template } = linkBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => {
      const done = Recurring.linkGeneratedTo(state, collection, template);
      return { state: done.state, result: done.linked };
    }));
  });

  app.put('/api/goals/:id', async (c) => {
    const { draft, paid } = goalBody.parse(await c.req.json());
    const id = c.req.param('id');
    return c.json(await write(c.get('userId'), (state) => ({
      state: Forecast.saveGoal(state, { ...(draft as Records.Draft<'goals'>), id }, paid ?? {}),
      result: null
    })));
  });

  app.post('/api/goals/:id/move', async (c) => {
    const { delta } = moveBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => ({
      state: Forecast.moveGoal(state, c.req.param('id'), delta), result: null
    })));
  });

  app.post('/api/debts', async (c) => {
    const taken = borrowBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => ({ state: Debt.borrow(state, taken), result: null })));
  });

  app.post('/api/debts/:id/repay', async (c) => {
    const paid = repayBody.parse(await c.req.json());
    const id = c.req.param('id');
    return c.json(await write(c.get('userId'), (state) => {
      if (!isDebtAccount(Records.byId(state, 'accounts', id))) throw new HttpError(404, 'not_found', 'No such debt.');
      return { state: Debt.repay(state, id, paid), result: null };
    }));
  });

  app.post('/api/accounts/:id/reconcile', async (c) => {
    const { actual, date } = reconcileBody.parse(await c.req.json());
    const id = c.req.param('id');
    return c.json(await write(c.get('userId'), (state) => {
      if (!Records.byId(state, 'accounts', id)) throw new HttpError(404, 'not_found', 'No such account.');
      const { difference } = Reconcile.reconciliation(state, id, actual);
      return { state: Reconcile.reconcile(state, id, actual, date), result: difference };
    }));
  });

  app.get('/api/backup', async (c) => {
    const userId = c.get('userId');
    const { state } = await withUser(deps.sql, userId, (tx) => loadState(userId, tx));
    return c.body(Backup.exportJSON(state), 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="income-tracker-backup-${todayISO()}.json"`
    });
  });

  /* Replaces everything the user has. Gold prices in the file are ignored: they
     are shared, and the server's own are newer. */
  app.post('/api/backup/import',
    bodyLimit({
      maxSize: IMPORT_LIMIT,
      onError: () => { throw new HttpError(400, 'too_large', 'That file is too large to import.'); }
    }),
    async (c) => {
      const text = await c.req.text();
      return c.json(await write(c.get('userId'), (state) => {
        const imported = Backup.importJSON(text);
        return { state: { ...imported.state, goldPrices: state.goldPrices }, result: imported.counts };
      }));
    });

  app.delete('/api/data', async (c) =>
    c.json(await write(c.get('userId'), (state) => ({
      state: { ...Records.blankState(), goldPrices: state.goldPrices }, result: null
    }))));
}
