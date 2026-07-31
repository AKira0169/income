/* domain/catalog.ts — the fixed lists the app offers and the constants that go
   with them. No behaviour, only vocabulary.

   Categories are offered as lists but stored as free strings: a database written
   by an earlier build may hold a name that has since been dropped, and an
   editor that silently retyped it would corrupt the record on save. */

import type { CollectionKey, Frequency } from './types.ts';

export const SCHEMA_VERSION = 1;

export const INCOME_CATEGORIES: readonly string[] = [
  'Salary', 'Freelance', 'Business', 'Rental', 'Investment', 'Interest',
  'Bonus', 'Commission', 'Pension', 'Refund', 'Gift', 'Other'
];

export const BILL_CATEGORIES: readonly string[] = [
  'Electricity', 'Water', 'Gas', 'Internet', 'Mobile', 'Landline',
  'Rent', 'Mortgage', 'Council Tax', 'Refuse', 'TV / Streaming',
  'Insurance', 'Loan Repayment', 'Credit Card', 'Childcare', 'Education',
  'Health', 'Subscriptions', 'Maintenance', 'Other'
];

export const PURCHASE_CATEGORIES: readonly string[] = [
  'Groceries', 'Dining Out', 'Household', 'Clothing', 'Electronics',
  'Pharmacy', 'Fuel', 'Transport', 'Entertainment', 'Gifts',
  'Home Improvement', 'Kids', 'Pets', 'Travel', 'Personal Care', 'Other'
];

export const PAYMENT_METHODS: readonly string[] = [
  'Bank Transfer', 'Direct Debit', 'Card', 'Cash', 'Standing Order',
  'Mobile Money', 'Cheque', 'Other'
];

/* Accounts are every place money sits, not only the pots you save into: the
   card the salary lands on is an account too, and every income, purchase and
   paid bill moves a balance somewhere. */
export const ACCOUNT_TYPES = [
  'Current Account', 'Card / Wallet', 'Savings', 'Emergency Fund',
  'Fixed Deposit', 'Investment', 'Pension', 'Cash', 'Goal Pot', 'Other'
] as const;

/* Which of those count as money put aside. Moving pay from a card into one of
   these is saving; moving it back out is not. */
export const SAVINGS_TYPES: readonly string[] = [
  'Savings', 'Emergency Fund', 'Fixed Deposit', 'Investment', 'Pension', 'Goal Pot'
];

export const FREQUENCIES = [
  'Monthly', 'Bi-monthly', 'Quarterly', 'Half-yearly', 'Yearly', 'One-off'
] as const;

/* Karats sold by weight in Egypt. 24 is pure; the rest are that fraction of
   pure gold, which is exactly how a jeweller prices them. */
export const GOLD_KARATS: readonly number[] = [24, 22, 21, 18, 14];
export const GRAMS_PER_OZ = 31.1034768;   // troy ounce, the unit gold is quoted in

/** How many times a year each frequency bills — used to put bills of different
    cadences on a comparable monthly footing. */
export const PER_YEAR: Readonly<Record<Frequency, number>> = {
  'Monthly': 12, 'Bi-monthly': 6, 'Quarterly': 4,
  'Half-yearly': 2, 'Yearly': 1, 'One-off': 0
};

/* Utility categories carry a meter reading, so cost can be read against
   consumption rather than on its own. */
export const METERED: Readonly<Record<string, string>> = {
  'Electricity': 'kWh',
  'Water': 'm³',
  'Gas': 'm³'
};

export const COLLECTION_KEYS: readonly CollectionKey[] = [
  'income', 'incomeTemplates', 'billTemplates', 'bills', 'purchases',
  'accounts', 'goals', 'savingsTx', 'gold', 'goldPrices'
];

/** Id prefixes, so a record's origin is readable in the database. */
export const ID_PREFIX: Readonly<Record<CollectionKey, string>> = {
  income: 'inc', incomeTemplates: 'itp', billTemplates: 'tpl', bills: 'bil',
  purchases: 'pur', accounts: 'acc', goals: 'gol', savingsTx: 'sav',
  gold: 'gld', goldPrices: 'gpr'
};
