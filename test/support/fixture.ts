/* test/support/fixture.ts — one realistic person, built through the domain so
   every derived field (bill periods and statuses, template marks) is exactly
   what the app itself would have written. Used by the repo and api suites, and
   exported as a backup file for the browser suite's import check. */

import { exportJSON } from '../../src/domain/backup.ts';
import { borrow } from '../../src/domain/debt.ts';
import { saveGoal } from '../../src/domain/forecast.ts';
import { blankState, upsert } from '../../src/domain/records.ts';
import type { Draft } from '../../src/domain/records.ts';
import type { AppState, CollectionKey } from '../../src/domain/types.ts';

export function fixtureState(): AppState {
  let s = blankState();
  const put = <K extends CollectionKey>(collection: K, record: Draft<K>): void => {
    s = upsert(s, collection, record).state;
  };
  put('accounts', { id: 'acc_card', name: 'Salary card', type: 'Current Account', opening: 1500000, target: 0, notes: '' });
  put('accounts', { id: 'acc_pot', name: 'Emergency fund', type: 'Emergency Fund', opening: 500000, target: 5000000, notes: 'six months' });
  put('incomeTemplates', { id: 'itp_sal', source: 'Employer', category: 'Salary', frequency: 'Monthly', payDay: 25, expected: 4000000, accountId: 'acc_card', method: 'Bank Transfer', active: true, anchor: '2026-05', generatedThrough: '2026-07', notes: '' });
  put('billTemplates', { id: 'tpl_rent', name: 'Rent', category: 'Rent', provider: 'Landlord', frequency: 'Monthly', dueDay: 1, expected: 1200000, accountId: 'acc_card', method: 'Bank Transfer', active: true, anchor: '2026-05', generatedThrough: '2026-07', notes: '' });
  for (const p of ['2026-05', '2026-06', '2026-07']) {
    put('income', { id: `inc_${p}`, templateId: 'itp_sal', date: `${p}-25`, source: 'Employer', category: 'Salary', amount: 4000000, accountId: 'acc_card', method: 'Bank Transfer', notes: '' });
    put('bills', { id: `bil_${p}`, templateId: 'tpl_rent', name: 'Rent', category: 'Rent', provider: 'Landlord', dueDate: `${p}-01`, amount: 1200000, accountId: 'acc_card', units: null, unitRate: null, paidDate: p === '2026-07' ? '' : `${p}-01`, method: 'Bank Transfer', notes: '' });
  }
  put('bills', { id: 'bil_elec', templateId: null, name: 'Electricity', category: 'Electricity', provider: 'Grid', dueDate: '2026-07-20', amount: 85075, accountId: 'acc_card', units: 412.5, unitRate: 2.06, paidDate: '2026-07-19', method: 'Card', notes: 'Ünïcode ✓' });
  put('purchases', { id: 'pur_food', goalId: null, date: '2026-07-03', item: 'Groceries', category: 'Groceries', amount: 245050, accountId: 'acc_card', method: 'Card', notes: '' });
  put('savingsTx', { id: 'sav_1', date: '2026-07-26', accountId: 'acc_pot', fromAccountId: 'acc_card', direction: 'transfer', amount: 800000, notes: '' });
  put('gold', { id: 'gld_1', date: '2026-06-10', direction: 'buy', karat: 21, grams: 8.25, pricePerGram: 590000, amount: 4867500, accountId: 'acc_card', dealer: 'Souq', notes: '' });
  put('goals', { id: 'gol_gpu', name: 'Graphics card', price: 4500000, priority: 1, boughtDate: '', notes: '' });
  put('goals', { id: 'gol_desk', name: 'Desk', price: 900000, priority: 2, boughtDate: '', notes: '' });
  s = saveGoal(s, { id: 'gol_desk', boughtDate: '2026-07-12' }, { accountId: 'acc_card', method: 'Card' });
  s = borrow(s, { name: 'Brother', amount: 1000000, date: '2026-07-05', intoAccountId: 'acc_card' });
  return { ...s, settings: { ...s.settings, savingsGoalRate: 25 } };
}

export const fixtureBackup = (): string => exportJSON(fixtureState());
