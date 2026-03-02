-- Run in Supabase SQL Editor
create table if not exists public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  notes_json jsonb not null default '[]'::jsonb,
  table_json jsonb not null default '{"columns":[],"rows":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

do $$ begin
  create policy "users can select own state" on public.app_state
  for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "users can insert own state" on public.app_state
  for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "users can update own state" on public.app_state
  for update using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "users can delete own state" on public.app_state
  for delete using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
