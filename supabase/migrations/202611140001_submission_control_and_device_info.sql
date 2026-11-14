create table if not exists public.qroom_settings (
  id boolean primary key default true check (id),
  accepting_questions boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.qroom_settings (id, accepting_questions)
values (true, true)
on conflict (id) do nothing;

alter table public.qroom_settings enable row level security;
revoke all on public.qroom_settings from anon, authenticated;
grant all on public.qroom_settings to service_role;

alter table public.questions
  add column if not exists device_info jsonb not null default '{}'::jsonb;

alter table public.user_sessions
  add column if not exists device_info jsonb not null default '{}'::jsonb;

alter table public.questions
  add constraint questions_device_info_check
  check (
    jsonb_typeof(device_info) = 'object'
    and device_info - 'userAgent' - 'platform' - 'language' = '{}'::jsonb
    and (not (device_info ? 'userAgent') or (jsonb_typeof(device_info -> 'userAgent') = 'string' and char_length(device_info ->> 'userAgent') <= 512))
    and (not (device_info ? 'platform') or (jsonb_typeof(device_info -> 'platform') = 'string' and char_length(device_info ->> 'platform') <= 128))
    and (not (device_info ? 'language') or (jsonb_typeof(device_info -> 'language') = 'string' and char_length(device_info ->> 'language') <= 32))
  );

alter table public.user_sessions
  add constraint user_sessions_device_info_check
  check (
    jsonb_typeof(device_info) = 'object'
    and device_info - 'userAgent' - 'platform' - 'language' = '{}'::jsonb
    and (not (device_info ? 'userAgent') or (jsonb_typeof(device_info -> 'userAgent') = 'string' and char_length(device_info ->> 'userAgent') <= 512))
    and (not (device_info ? 'platform') or (jsonb_typeof(device_info -> 'platform') = 'string' and char_length(device_info ->> 'platform') <= 128))
    and (not (device_info ? 'language') or (jsonb_typeof(device_info -> 'language') = 'string' and char_length(device_info ->> 'language') <= 32))
  );

create or replace function public.qroom_can_submit_questions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select settings.accepting_questions
    from public.qroom_settings as settings
    where settings.id = true
  ), false)
  and not exists (
    select 1
    from public.user_sessions as session
    where session.user_id = (select auth.uid())
      and session.expires_at > now()
      and not (
        session.role = 'admin'
        or (
          session.role = 'moderator'
          and exists (
            select 1
            from public.moderators as moderator
            where moderator.id = session.moderator_id
              and moderator.active = true
              and moderator.assigned_role = 'moderator'
          )
        )
      )
  );
$$;

revoke all on function public.qroom_can_submit_questions() from public;
grant execute on function public.qroom_can_submit_questions() to anon, authenticated;
