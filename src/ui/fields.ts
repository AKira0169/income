/* ui/fields.ts — the field specs each screen's forms are declared from.

   Kept apart from the screens so that add, edit and recurring forms for the
   same record cannot drift out of step with one another. Both form engines —
   the old hand-built one and the Preact one replacing it — read these, which is
   what stops a field appearing in one and not the other mid-port. */

import {
  ACCOUNT_TYPES, BILL_CATEGORIES, FREQUENCIES, GOLD_KARATS, INCOME_CATEGORIES,
  PAYMENT_METHODS, PURCHASE_CATEGORIES
} from '../domain/catalog.ts';
import { todayISO } from '../domain/period.ts';
import { defaultSavingsAccount, lastAccountFor } from '../domain/selectors.ts';
import type { AppState } from '../domain/types.ts';

export type FieldType = 'text' | 'select' | 'account' | 'date' | 'money' | 'number' | 'checkbox';

export interface FieldSpec {
  key: string;
  label: string;
  /** Defaults to a plain text input. */
  type?: FieldType;
  required?: boolean;
  /** Spans both columns of the form grid. */
  wide?: boolean;
  placeholder?: string;
  options?: readonly string[];
  /** Display labels for option values, e.g. `21` -> `21k — usual here`. */
  labels?: Readonly<Record<string, string>>;
  /** A literal, or a function given the state when the form is built. */
  def?: unknown;
  min?: number;
  step?: string | number;
}

/** 21 is what most jewellery sold in Egypt is; 24 is bullion and coins. */
const KARAT_LABELS: Readonly<Record<string, string>> = {
  24: '24k — pure / bullion', 22: '22k', 21: '21k — usual here', 18: '18k', 14: '14k'
};

export const FIELDS = {
  income: [
    { key: 'date', label: 'Date', type: 'date', required: true, def: todayISO },
    { key: 'source', label: 'Source', type: 'text', placeholder: 'Employer or client', required: true },
    { key: 'category', label: 'Category', type: 'select', options: INCOME_CATEGORIES, def: 'Salary' },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'accountId', label: 'Paid into', type: 'account', def: (s: AppState) => lastAccountFor(s, 'income') },
    { key: 'method', label: 'Received via', type: 'select', options: PAYMENT_METHODS, def: 'Bank Transfer' },
    { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
  ],
  purchase: [
    { key: 'date', label: 'Date', type: 'date', required: true, def: todayISO },
    { key: 'item', label: 'What you bought', type: 'text', placeholder: 'e.g. weekly shop', required: true },
    { key: 'category', label: 'Category', type: 'select', options: PURCHASE_CATEGORIES, def: 'Groceries' },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'accountId', label: 'Paid from', type: 'account', def: (s: AppState) => lastAccountFor(s, 'purchases') },
    { key: 'method', label: 'Paid with', type: 'select', options: PAYMENT_METHODS, def: 'Card' },
    { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
  ],
  incomeTemplate: [
    { key: 'source', label: 'Source', type: 'text', placeholder: 'e.g. Acme Ltd — salary', required: true },
    { key: 'category', label: 'Category', type: 'select', options: INCOME_CATEGORIES, def: 'Salary' },
    { key: 'frequency', label: 'How often', type: 'select', options: FREQUENCIES, def: 'Monthly' },
    { key: 'payDay', label: 'Paid on day', type: 'number', min: 1, step: 1, placeholder: '28' },
    { key: 'expected', label: 'Amount', type: 'money', required: true },
    { key: 'accountId', label: 'Paid into', type: 'account', def: (s: AppState) => lastAccountFor(s, 'income') },
    { key: 'method', label: 'Received via', type: 'select', options: PAYMENT_METHODS, def: 'Bank Transfer' },
    { key: 'active', label: 'Active', type: 'checkbox', def: true },
    { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
  ],
  billTemplate: [
    { key: 'name', label: 'Bill name', type: 'text', placeholder: 'e.g. Electricity', required: true },
    { key: 'category', label: 'Category', type: 'select', options: BILL_CATEGORIES, def: 'Electricity' },
    { key: 'provider', label: 'Provider', type: 'text', placeholder: 'Who bills you' },
    { key: 'frequency', label: 'How often', type: 'select', options: FREQUENCIES, def: 'Monthly' },
    { key: 'dueDay', label: 'Due day', type: 'number', min: 1, step: 1, placeholder: '1' },
    { key: 'expected', label: 'Typical amount', type: 'money' },
    { key: 'accountId', label: 'Paid from', type: 'account', def: (s: AppState) => lastAccountFor(s, 'bills') },
    { key: 'method', label: 'Paid by', type: 'select', options: PAYMENT_METHODS, def: 'Direct Debit' },
    { key: 'active', label: 'Active', type: 'checkbox', def: true }
  ],
  bill: [
    { key: 'name', label: 'Bill', type: 'text', required: true },
    { key: 'category', label: 'Category', type: 'select', options: BILL_CATEGORIES, def: 'Electricity' },
    { key: 'provider', label: 'Provider', type: 'text' },
    { key: 'dueDate', label: 'Due date', type: 'date', required: true },
    { key: 'amount', label: 'Amount billed', type: 'money', required: true },
    { key: 'accountId', label: 'Paid from', type: 'account', def: (s: AppState) => lastAccountFor(s, 'bills') },
    { key: 'units', label: 'Units used', type: 'number', placeholder: 'kWh / m³' },
    { key: 'unitRate', label: 'Rate per unit', type: 'number', placeholder: 'e.g. 0.31' },
    { key: 'paidDate', label: 'Date paid', type: 'date' },
    { key: 'method', label: 'Paid by', type: 'select', options: PAYMENT_METHODS, def: 'Direct Debit' },
    { key: 'notes', label: 'Notes', type: 'text', wide: true }
  ],
  account: [
    { key: 'name', label: 'Account name', type: 'text', placeholder: 'e.g. Visa, Meeza, Emergency Fund', required: true },
    { key: 'type', label: 'Type', type: 'select', options: ACCOUNT_TYPES, def: 'Current Account' },
    { key: 'opening', label: 'Opening balance', type: 'money' },
    { key: 'target', label: 'Target (optional)', type: 'money' },
    { key: 'notes', label: 'Notes', type: 'text', wide: true }
  ],
  goal: [
    { key: 'name', label: 'What you want', type: 'text', placeholder: 'e.g. RTX 5080', required: true },
    { key: 'price', label: 'Price', type: 'money', placeholder: 'Leave empty if you do not know yet' },
    { key: 'boughtDate', label: 'Bought on', type: 'date' },
    { key: 'notes', label: 'Notes', type: 'text', wide: true }
  ],
  gold: [
    { key: 'date', label: 'Date', type: 'date', required: true, def: todayISO },
    {
      key: 'direction', label: 'Bought or sold', type: 'select', options: ['buy', 'sell'],
      labels: { buy: 'Bought', sell: 'Sold' }, def: 'buy'
    },
    { key: 'karat', label: 'Karat', type: 'select', options: GOLD_KARATS.map(String), labels: KARAT_LABELS, def: '21' },
    { key: 'grams', label: 'Grams', type: 'number', step: '0.001', min: 0, placeholder: 'e.g. 8', required: true },
    { key: 'amount', label: 'Total paid', type: 'money', required: true },
    { key: 'accountId', label: 'Paid from', type: 'account', def: (s: AppState) => lastAccountFor(s, 'gold') },
    { key: 'dealer', label: 'Shop', type: 'text', placeholder: 'Optional' },
    { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
  ]
} as const satisfies Record<string, readonly FieldSpec[]>;

/** Movements between accounts. A transfer needs two accounts, so it is only
    offered once there are two to move between. */
export function savingsFields(state: AppState): FieldSpec[] {
  const directions = state.accounts.length > 1 ? ['transfer', 'in', 'out'] : ['in', 'out'];
  return [
    { key: 'date', label: 'Date', type: 'date', required: true, def: todayISO },
    {
      key: 'direction', label: 'Movement', type: 'select', options: directions,
      labels: {
        transfer: 'Transfer between accounts',
        in: 'Money in (from outside)',
        out: 'Money out (to outside)'
      },
      def: directions[0]
    },
    { key: 'fromAccountId', label: 'From account', type: 'account', def: (s: AppState) => lastAccountFor(s, 'income') },
    { key: 'accountId', label: 'To account', type: 'account', def: (s: AppState) => defaultSavingsAccount(s) },
    { key: 'amount', label: 'Amount', type: 'money', required: true },
    { key: 'notes', label: 'Notes', type: 'text', placeholder: 'Optional', wide: true }
  ];
}
