/* server/validate.ts — the shape of every request body, in zod.

   Record drafts are built from the same column list the repository writes, so
   a field the database does not have cannot be sent, and one it does have
   cannot be refused. Field types are lenient in exactly the way the stored
   form is: "21" for a number is accepted and coerced on write (schema.ts), an
   object or array never is. Keys that are left out stay out — upsert() merges
   a draft over the record, and an absent key must not become a null. */

import { z } from 'zod';
import type { Draft } from '../src/domain/records.ts';
import { isUserCollection } from '../src/wire.ts';
import type { UserCollection } from '../src/wire.ts';
import { HttpError } from './errors.ts';
import { kindOf, TABLES } from './schema.ts';
import type { ColumnKind } from './schema.ts';

export function parseCollection(name: string): UserCollection {
  if (!isUserCollection(name)) {
    throw new HttpError(404, 'unknown_collection', `There is no collection called "${name}".`);
  }
  return name;
}

const scalar = (kind: ColumnKind) => {
  // A note is a few lines; this is far beyond any real one and far below a
  // body that could hurt.
  if (kind === 'text') return z.union([z.string().max(20_000), z.number()]).nullable().optional();
  if (kind === 'bool') return z.union([z.boolean(), z.number()]).nullable().optional();
  return z.union([z.number(), z.string()]).nullable().optional();
};

const id = z.string().min(1).max(120);

const drafts = new Map<UserCollection, z.ZodType<Record<string, unknown>>>();

export function draftSchema(collection: UserCollection): z.ZodType<Record<string, unknown>> {
  let schema = drafts.get(collection);
  if (!schema) {
    const shape: Record<string, z.ZodType> = {};
    for (const column of TABLES[collection]) shape[column] = column === 'id' ? id.optional() : scalar(kindOf(column));
    schema = z.object(shape) as unknown as z.ZodType<Record<string, unknown>>;
    drafts.set(collection, schema);
  }
  return schema;
}

export const parseDraft = <K extends UserCollection>(collection: K, body: unknown): Draft<K> =>
  draftSchema(collection).parse(body) as Draft<K>;

export const settingsPatch = z.strictObject({
  currencySymbol: z.string().max(16),
  currencyCode: z.string().max(16),
  locale: z.string().max(35),
  savingsGoalRate: z.number(),
  autoGenerate: z.boolean(),
  goldSync: z.boolean(),
  goldPremium: z.number(),
  goldManualPrice: z.number().int(),
  forecastSpendingAuto: z.boolean(),
  forecastSpending: z.number().int()
}).partial();

/* ------------------------------------------------ composite endpoints */

const period = z.string().regex(/^\d{4}-\d{2}$/);

export const generateBody = z.object({ collection: z.enum(['bills', 'income']), period });

export const linkBody = z.object({
  collection: z.enum(['incomeTemplates', 'billTemplates']),
  template: z.object({ id: z.string().optional(), accountId: z.string().optional() })
});

export const goalBody = z.object({
  draft: draftSchema('goals'),
  paid: z.object({ accountId: z.string().optional(), method: z.string().optional() }).optional()
});

export const moveBody = z.object({ delta: z.number().int().min(-1).max(1) });

export const borrowBody = z.object({
  name: z.string().max(200),
  amount: z.number().int(),
  date: z.string(),
  intoAccountId: z.string(),
  notes: z.string().max(2000).optional(),
  debtId: z.string().optional()
});

export const repayBody = z.object({
  amount: z.number().int(),
  date: z.string(),
  fromAccountId: z.string(),
  notes: z.string().max(2000).optional()
});

export const reconcileBody = z.object({ actual: z.number().int(), date: z.string() });
