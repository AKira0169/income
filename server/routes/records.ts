/* server/routes/records.ts — the generic collection endpoints.

   POST is the domain's upsert: an id means update, no id (or an unknown one)
   means insert — exactly what the screens have always called. PUT and DELETE
   address one existing record and are 404 for anything this user does not
   have, which is how "someone else's record" looks from outside. */

import type { Hono } from 'hono';
import * as Records from '../../src/domain/records.ts';
import type { AppDeps, AppEnv } from '../app.ts';
import { withUser } from '../db.ts';
import { HttpError } from '../errors.ts';
import { mutate } from '../mutate.ts';
import { getRecord, listRecords } from '../repo.ts';
import { normalizeRecord } from '../schema.ts';
import { parseCollection, parseDraft, settingsPatch } from '../validate.ts';

const missing = (): HttpError => new HttpError(404, 'not_found', 'No such record.');

export function recordRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.patch('/api/settings', async (c) => {
    const patch = settingsPatch.parse(await c.req.json());
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => ({
      state: Records.updateSettings(state, patch), result: null
    })));
  });

  app.get('/api/:collection', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const userId = c.get('userId');
    return c.json(await withUser(deps.sql, userId, (tx) => listRecords(userId, tx, collection)));
  });

  app.get('/api/:collection/:id', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const userId = c.get('userId');
    const record = await withUser(deps.sql, userId, (tx) => getRecord(userId, tx, collection, c.req.param('id')));
    if (!record) throw missing();
    return c.json(record);
  });

  app.post('/api/:collection', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const draft = parseDraft(collection, await c.req.json());
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => {
      const saved = Records.upsert(state, collection, draft);
      return { state: saved.state, result: normalizeRecord(collection, saved.record) };
    }));
  });

  app.put('/api/:collection/:id', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const id = c.req.param('id');
    const draft = { ...parseDraft(collection, await c.req.json()), id };
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => {
      if (!Records.byId(state, collection, id)) throw missing();
      const saved = Records.upsert(state, collection, draft);
      return { state: saved.state, result: normalizeRecord(collection, saved.record) };
    }));
  });

  app.delete('/api/:collection/:id', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const id = c.req.param('id');
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => {
      if (!Records.byId(state, collection, id)) throw missing();
      return { state: Records.remove(state, collection, id), result: null };
    }));
  });
}
