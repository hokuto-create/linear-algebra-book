-- DayFlow 課金基盤: subscriptions / ai_usage テーブルと RLS
--
-- 設計方針:
--   * subscriptions は「本人のみ SELECT 可」。書き込みポリシーは一切作らない
--     （= service role(Edge Function の stripe-webhook) だけが書ける）
--   * ai_usage も同様に本人 SELECT のみ（残り回数の表示用）。
--     カウントの加算は security definer 関数経由で service role が行う。

-- ---------------------------------------------------------------
-- subscriptions: ユーザーごと1行の購読状態（Stripe webhook が更新する）
-- ---------------------------------------------------------------
create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  -- plan は null を許す（Checkout 前に customer を紐付けた段階では未課金）
  plan                   text check (plan in ('standard', 'premium')),
  status                 text,
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- 本人のみ SELECT 可。INSERT/UPDATE/DELETE のポリシーは作らない
-- → anon/authenticated からの書き込みは RLS で全て拒否され、
--   service role（RLS バイパス）だけが書き込める。
create policy "subscriptions_select_own"
  on public.subscriptions
  for select
  to authenticated
  using (auth.uid() = user_id);

create index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id);

-- ---------------------------------------------------------------
-- ai_usage: AI目次取り込みの日次実行回数（乱用対策）
-- ---------------------------------------------------------------
create table if not exists public.ai_usage (
  user_id    uuid not null references auth.users (id) on delete cascade,
  usage_date date not null default ((now() at time zone 'utc'))::date,
  count      integer not null default 0,
  primary key (user_id, usage_date)
);

alter table public.ai_usage enable row level security;

-- 本人のみ SELECT 可（「今日あと◯回」の表示用）。書き込みポリシーなし。
create policy "ai_usage_select_own"
  on public.ai_usage
  for select
  to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- increment_ai_usage: 上限チェックとカウント加算をアトミックに行う。
-- 上限未満なら加算して true、上限到達済みなら加算せず false を返す。
-- Edge Function (ai-toc-import) が service role で呼び出す。
-- ---------------------------------------------------------------
create or replace function public.increment_ai_usage(p_user_id uuid, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean;
begin
  with upsert as (
    insert into public.ai_usage as u (user_id, usage_date, count)
    values (p_user_id, ((now() at time zone 'utc'))::date, 1)
    on conflict (user_id, usage_date)
    do update set count = u.count + 1
    where u.count < p_limit
    returning u.count
  )
  select exists (select 1 from upsert) into allowed;

  return allowed;
end;
$$;

-- クライアントから直接叩けないようにする（service role のみ）
revoke all on function public.increment_ai_usage(uuid, integer) from public;
revoke all on function public.increment_ai_usage(uuid, integer) from anon;
revoke all on function public.increment_ai_usage(uuid, integer) from authenticated;
