/* state/actions.ts — every write the screen can make.

   The same names and the same answers as the offline build — upsert hands back
   the saved record, reconcile the difference, catchUp the counts — but each is
   now a request, so each returns a promise. The rules still live in domain/,
   on the server now: these functions only say which one to run. */

import * as Backup from '../../domain/backup.ts';
import type * as Debt from '../../domain/debt.ts';
import type * as Forecast from '../../domain/forecast.ts';
import { uid } from '../../domain/records.ts';
import type { Draft } from '../../domain/records.ts';
import type {
  CatchUpResult, Cents, CollectionKey, Id, IsoDate, Period, RecordOf, Settings
} from '../../domain/types.ts';
import type { UserCollection } from '../../wire.ts';
import { mutate } from './api.ts';
import { snapshot } from './app.ts';

const at = (id: Id): string => encodeURIComponent(id);

export const upsert = <K extends UserCollection>(collection: K, record: Draft<K>): Promise<RecordOf<K>> =>
  mutate<RecordOf<K>>('POST', `/api/${collection}`, record);

export async function remove(collection: UserCollection, id: Id): Promise<void> {
  await mutate('DELETE', `/api/${collection}/${at(id)}`);
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  await mutate('PATCH', '/api/settings', patch);
}

/** Replaces everything with the backup in `text`. */
export const importJSON = (text: string): Promise<Record<CollectionKey, number>> =>
  mutate('POST', '/api/backup/import', undefined, text);

export async function replaceState(next: unknown): Promise<void> {
  await importJSON(JSON.stringify(next));
}

export async function clearAll(): Promise<void> {
  await mutate('DELETE', '/api/data');
}

/** Built from what is on screen, which is what the server holds. */
export const exportJSON = (): string => Backup.exportJSON(snapshot());

/* ------------------------------------------------------------- generation */

export const generateBills = (period: Period): Promise<number> =>
  mutate('POST', '/api/recurring/generate', { collection: 'bills', period });

export const generateIncome = (period: Period): Promise<number> =>
  mutate('POST', '/api/recurring/generate', { collection: 'income', period });

export const catchUp = (): Promise<CatchUpResult> => mutate('POST', '/api/recurring/catch-up', {});

export async function linkGeneratedTo(
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): Promise<number> {
  // The domain answers 0 for this without looking; no need to ask the server.
  if (!template?.id || !template.accountId) return 0;
  return mutate('POST', '/api/recurring/link', {
    collection, template: { id: template.id, accountId: template.accountId }
  });
}

/* ------------------------------------------------------------------ goals */

/* A new goal is given its id here, so it can be addressed like any other. */
export async function saveGoal(draft: Draft<'goals'>, paid: Forecast.GoalPayment = {}): Promise<void> {
  const { id = uid('gol'), ...fields } = draft;
  await mutate('PUT', `/api/goals/${at(id)}`, { draft: fields, paid });
}

export async function moveGoal(id: Id, delta: number): Promise<void> {
  await mutate('POST', `/api/goals/${at(id)}/move`, { delta });
}

/* ------------------------------------------------- debts and reconciling */

export async function borrow(taken: Debt.Borrowing): Promise<void> {
  await mutate('POST', '/api/debts', taken);
}

export async function repay(debtId: Id, paid: Debt.Repayment): Promise<void> {
  await mutate('POST', `/api/debts/${at(debtId)}/repay`, paid);
}

/** Writes the row that makes an account agree with its real balance, and says
    what it corrected by. Zero means it already agreed and nothing was written. */
export const reconcile = (accountId: Id, actual: Cents, date: IsoDate): Promise<Cents> =>
  mutate('POST', `/api/accounts/${at(accountId)}/reconcile`, { actual, date });
