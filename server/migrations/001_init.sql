-- 001_init.sql — the app schema.
--
-- Every per-user table is keyed (user_id, id): ids are TEXT and may be made in
-- the browser (uid()), and the composite key is what stops two users' ids from
-- ever colliding. `seq` keeps rows in the order they were first written, which
-- the domain relies on (lastAccountFor reads the newest entry) and which the
-- sqlite store kept for free. Columns mirror server/schema.ts; test/migrate.ts
-- checks that they agree.

create table users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  state_version bigint not null default 0
);

create table settings (
  user_id uuid primary key references users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);

create table income (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  template_id text,
  date text,
  period text generated always as (substr(date, 1, 7)) stored,
  source text,
  category text,
  amount bigint,
  account_id text,
  method text,
  notes text,
  primary key (user_id, id),
  unique (user_id, template_id, period)
);

create table income_templates (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  source text,
  category text,
  frequency text,
  pay_day integer,
  expected bigint,
  account_id text,
  method text,
  active boolean,
  anchor text,
  generated_through text,
  notes text,
  primary key (user_id, id)
);

create table bill_templates (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  name text,
  category text,
  provider text,
  frequency text,
  due_day integer,
  expected bigint,
  account_id text,
  method text,
  active boolean,
  anchor text,
  generated_through text,
  notes text,
  primary key (user_id, id)
);

create table bills (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  template_id text,
  name text,
  category text,
  provider text,
  period text,
  due_date text,
  amount bigint,
  account_id text,
  units double precision,
  unit_rate double precision,
  status text,
  paid_date text,
  method text,
  notes text,
  primary key (user_id, id),
  unique (user_id, template_id, period)
);

create table purchases (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  goal_id text,
  date text,
  item text,
  category text,
  amount bigint,
  account_id text,
  method text,
  notes text,
  primary key (user_id, id)
);

create table accounts (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  name text,
  type text,
  target bigint,
  opening bigint,
  notes text,
  -- Phase 3. The repository writes the user's base currency on insert; the
  -- default only covers a row written some other way.
  currency char(3) not null default 'EGP',
  primary key (user_id, id)
);

create table goals (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  name text,
  price bigint,
  priority integer,
  bought_date text,
  notes text,
  primary key (user_id, id)
);

create table savings_tx (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  date text,
  account_id text,
  from_account_id text,
  direction text,
  amount bigint,
  notes text,
  primary key (user_id, id)
);

create table gold (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  date text,
  direction text,
  karat integer,
  grams double precision,
  price_per_gram bigint,
  amount bigint,
  account_id text,
  dealer text,
  notes text,
  primary key (user_id, id)
);

-- Phase 3, schema only.
create table fx_rates (
  user_id uuid not null references users (id) on delete cascade,
  date date not null,
  currency char(3) not null,
  rate_to_base numeric not null,
  primary key (user_id, date, currency)
);

-- Shared by everyone: the world price is the same for all users. Written by
-- the daily job, read into every state.
create table gold_prices (
  date text primary key,
  usd_per_oz double precision,
  egp_per_usd double precision,
  egp_per_gram24 bigint,
  source text,
  fetched_at text
);

create index income_by_date on income (user_id, date);
create index purchases_by_date on purchases (user_id, date);
create index bills_by_period on bills (user_id, period);
create index savings_tx_by_date on savings_tx (user_id, date);
create index gold_by_date on gold (user_id, date);

-- Row-level security: the backstop behind server/repo.ts, which already names
-- user_id in every statement. current_setting(..., true) is null when nothing
-- was set, and null matches no row, so a query outside withUser() sees nothing.
do $$
declare t text;
begin
  foreach t in array array['settings', 'income', 'income_templates', 'bill_templates', 'bills',
                           'purchases', 'accounts', 'goals', 'savings_tx', 'gold', 'fx_rates'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy own_rows on %I '
      'using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) '
      'with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
  end loop;
end $$;

alter table users enable row level security;
create policy own_row on users
  using (id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.user_id', true), '')::uuid);

grant usage on schema public to app;
grant select, insert, update, delete on
  users, settings, income, income_templates, bill_templates, bills, purchases,
  accounts, goals, savings_tx, gold, fx_rates, gold_prices
to app;
