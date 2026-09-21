-- 006: 課金状態（エンタイトルメント）をサーバーだけが書ける表に移す
--
-- これまでの課金判定には2つの穴があった。
--   1) 決済後の戻りURL（?paid=1）が付いているだけで有料版を開いていた
--   2) athlete_state.paid を利用者自身のアプリから書き込めた
-- どちらも「払わずに開ける」状態だったため、課金状態はこの表だけで判定する。
--
-- 書き込むのは Stripe の支払い通知を受ける Edge Function（service_role）だけ。
-- 利用者は自分の行を読むことしかできない（insert / update / delete のポリシーは作らない）。

create table if not exists public.entitlements (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  status               text not null check (status in ('active','trialing','past_due','canceled','unpaid','incomplete')),
  current_period_end   timestamptz,
  stripe_customer      text,
  stripe_subscription  text unique,
  updated_at           timestamptz not null default now()
);

alter table public.entitlements enable row level security;

drop policy if exists entitlements_read_own on public.entitlements;
create policy entitlements_read_own on public.entitlements for select to authenticated
  using (user_id = auth.uid());

-- 旧方式の列はもう信用しない（残すが、アプリは読まない）
comment on column public.athlete_state.paid is '廃止。課金判定は public.entitlements を使う';

-- 確認用
select
  (select count(*) from information_schema.tables where table_name = 'entitlements')   as "課金状態の表",
  (select count(*) from pg_policies where tablename = 'entitlements')                   as "ポリシー数（読むだけ=1）";
