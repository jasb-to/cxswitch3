create table if not exists public.cxswitch_kv (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz null,
  updated_at timestamptz not null default now()
);
create index if not exists cxswitch_kv_expires_at_idx on public.cxswitch_kv (expires_at);
alter table public.cxswitch_kv enable row level security;

create or replace function public.cxswitch_kv_claim(
  p_key text, p_value jsonb, p_expires_at timestamptz default null
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.cxswitch_kv(key,value,expires_at,updated_at)
  values (p_key,p_value,p_expires_at,now())
  on conflict (key) do nothing;
  return found;
end;
$$;

revoke all on function public.cxswitch_kv_claim(text,jsonb,timestamptz) from public, anon, authenticated;
grant execute on function public.cxswitch_kv_claim(text,jsonb,timestamptz) to service_role;
revoke all on table public.cxswitch_kv from anon, authenticated;
grant all on table public.cxswitch_kv to service_role;

create or replace function public.cxswitch_kv_cleanup_expired()
returns integer language sql security definer set search_path = public as $$
  with deleted as (
    delete from public.cxswitch_kv where expires_at is not null and expires_at <= now() returning 1
  ) select count(*)::integer from deleted;
$$;
revoke all on function public.cxswitch_kv_cleanup_expired() from public, anon, authenticated;
grant execute on function public.cxswitch_kv_cleanup_expired() to service_role;
