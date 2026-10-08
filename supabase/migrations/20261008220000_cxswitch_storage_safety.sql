-- CXSwitch Supabase storage safety net.
-- The Vercel cron already cleans application state; this adds a database-side
-- backstop so cleanup continues even if Vercel cron is temporarily unavailable.

create extension if not exists pg_cron;

create or replace function public.cxswitch_kv_safety_cleanup()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_count integer := 0;
  telegram_pruned integer := 0;
  overflow_pruned integer := 0;
  total_rows integer := 0;
  keep_telegram integer := 100;
  max_rows integer := 150;
begin
  delete from public.cxswitch_kv
  where expires_at is not null
    and expires_at <= now();
  get diagnostics expired_count = row_count;

  with keep as (
    select key
    from public.cxswitch_kv
    where key like 'cxswitch:telegram_alert:%'
    order by updated_at desc, key desc
    limit keep_telegram
  ),
  doomed as (
    select k.key
    from public.cxswitch_kv k
    where k.key like 'cxswitch:telegram_alert:%'
      and k.key not in (select key from keep)
  )
  delete from public.cxswitch_kv k
  using doomed d
  where k.key = d.key;
  get diagnostics telegram_pruned = row_count;

  select count(*) into total_rows from public.cxswitch_kv;

  if total_rows > max_rows then
    with protected as (
      select key
      from public.cxswitch_kv
      where key in (
        'cxswitch:active_signals',
        'cxswitch:signal_history',
        'cxswitch:latest_alerts',
        'cxswitch:card_resets',
        'cxswitch:market',
        'cxswitch:last_cron',
        'cxswitch:dashboard_snapshot',
        'cxswitch:migrated_v01',
        'cxswitch:cooldowns',
        'cxswitch:v28_breakout_state',
        'cxswitch:cleanup:bandwidth_20261002_v1',
        'cxswitch:cleanup:btc_short_20260923'
      )
      union all
      select key
      from public.cxswitch_kv
      where key like 'cxswitch:telegram_alert:%'
    ),
    doomed as (
      select k.key
      from public.cxswitch_kv k
      where not exists (select 1 from protected p where p.key = k.key)
      order by k.updated_at asc, k.key asc
      limit greatest(total_rows - max_rows, 0)
    )
    delete from public.cxswitch_kv k
    using doomed d
    where k.key = d.key;
    get diagnostics overflow_pruned = row_count;
  end if;

  return jsonb_build_object(
    'expired', expired_count,
    'telegram_pruned', telegram_pruned,
    'overflow_pruned', overflow_pruned,
    'row_count', (select count(*) from public.cxswitch_kv),
    'max_rows', max_rows,
    'telegram_retention', keep_telegram
  );
end;
$$;

revoke execute on function public.cxswitch_kv_safety_cleanup() from public;
revoke execute on function public.cxswitch_kv_safety_cleanup() from anon;
revoke execute on function public.cxswitch_kv_safety_cleanup() from authenticated;

do $$
begin
  perform cron.unschedule('cxswitch-kv-safety-cleanup');
exception
  when others then null;
end;
$$;

select cron.schedule(
  'cxswitch-kv-safety-cleanup',
  '*/5 * * * *',
  'select public.cxswitch_kv_safety_cleanup();'
);

do $$
begin
  perform cron.unschedule('cxswitch-cron-history-cleanup');
exception
  when others then null;
end;
$$;

select cron.schedule(
  'cxswitch-cron-history-cleanup',
  '0 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days';$$
);
