create unique index if not exists moderators_name_unique_idx
on public.moderators (lower(btrim(name)));

create or replace function public.qroom_can_read_activity_logs()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_sessions s
    where s.user_id = (select auth.uid())
      and s.role = 'admin'
      and s.expires_at > now()
  );
$$;

revoke all on function public.qroom_can_read_activity_logs() from public, anon;
grant execute on function public.qroom_can_read_activity_logs() to authenticated;

grant select on public.activity_logs to authenticated;

create policy "Admins can read activity logs"
on public.activity_logs for select to authenticated
using ((select public.qroom_can_read_activity_logs()));

do $$
begin
  alter publication supabase_realtime add table public.activity_logs;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
