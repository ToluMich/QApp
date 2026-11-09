create extension if not exists pgcrypto with schema extensions;

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  text varchar(280) not null check (char_length(btrim(text)) between 1 and 280),
  status text not null default 'unanswered' check (status in ('unanswered', 'answered')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  answered_by uuid,
  answered_by_name text,
  constraint answered_question_has_metadata check (
    status <> 'answered' or (answered_at is not null and answered_by is not null and answered_by_name is not null)
  )
);

create index if not exists questions_created_at_idx on public.questions (created_at desc);
create index if not exists questions_status_created_at_idx on public.questions (status, created_at desc);

create table if not exists public.moderators (
  id uuid primary key default gen_random_uuid(),
  name varchar(80) not null check (char_length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  pin_hash text not null,
  pin_digest text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.user_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'moderator')),
  moderator_id uuid references public.moderators(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint moderator_session_has_moderator check (
    (role = 'moderator' and moderator_id is not null) or (role = 'admin' and moderator_id is null)
  )
);

create table if not exists public.activity_logs (
  id bigint generated always as identity primary key,
  action text not null,
  actor_name text not null,
  moderator_id uuid references public.moderators(id) on delete set null,
  moderator_name text,
  question_id uuid references public.questions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.pin_login_attempts (
  fingerprint text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

alter table public.questions enable row level security;
alter table public.moderators enable row level security;
alter table public.user_sessions enable row level security;
alter table public.activity_logs enable row level security;
alter table public.pin_login_attempts enable row level security;

revoke all on public.questions, public.moderators, public.user_sessions, public.activity_logs, public.pin_login_attempts from anon, authenticated;
grant select, insert on public.questions to anon, authenticated;
grant usage, select on sequence public.activity_logs_id_seq to service_role;
grant all on public.questions, public.moderators, public.user_sessions, public.activity_logs, public.pin_login_attempts to service_role;

create or replace function public.qroom_can_read_questions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_sessions s
    left join public.moderators m on m.id = s.moderator_id
    where s.user_id = (select auth.uid())
      and s.expires_at > now()
      and (s.role = 'admin' or (s.role = 'moderator' and m.active = true))
  );
$$;

revoke all on function public.qroom_can_read_questions() from public, anon;
grant execute on function public.qroom_can_read_questions() to authenticated;

create policy "Visitors can submit valid anonymous questions"
on public.questions for insert to anon, authenticated
with check (
  status = 'unanswered'
  and answered_at is null
  and answered_by is null
  and answered_by_name is null
  and char_length(btrim(text)) between 1 and 280
);

create policy "Active moderators and admins can read questions"
on public.questions for select to authenticated
using ((select public.qroom_can_read_questions()));

create or replace function public.qroom_begin_pin_login(p_fingerprint text)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_attempt public.pin_login_attempts%rowtype;
begin
  insert into public.pin_login_attempts (fingerprint, attempts, window_started_at)
  values (p_fingerprint, 0, now())
  on conflict (fingerprint) do nothing;

  select * into current_attempt
  from public.pin_login_attempts
  where fingerprint = p_fingerprint
  for update;

  if current_attempt.locked_until is not null and current_attempt.locked_until > now() then
    return query select false, greatest(1, ceil(extract(epoch from (current_attempt.locked_until - now())))::integer);
    return;
  end if;

  if current_attempt.window_started_at < now() - interval '15 minutes' then
    update public.pin_login_attempts
    set attempts = 0, window_started_at = now(), locked_until = null
    where fingerprint = p_fingerprint;
  end if;

  return query select true, 0;
end;
$$;

create or replace function public.qroom_record_pin_failure(p_fingerprint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_attempts integer;
begin
  insert into public.pin_login_attempts (fingerprint, attempts, window_started_at)
  values (p_fingerprint, 1, now())
  on conflict (fingerprint) do update
  set attempts = case
        when public.pin_login_attempts.window_started_at < now() - interval '15 minutes' then 1
        else public.pin_login_attempts.attempts + 1
      end,
      window_started_at = case
        when public.pin_login_attempts.window_started_at < now() - interval '15 minutes' then now()
        else public.pin_login_attempts.window_started_at
      end,
      locked_until = case
        when public.pin_login_attempts.window_started_at < now() - interval '15 minutes' then null
        when public.pin_login_attempts.attempts + 1 >= 10 then now() + interval '15 minutes'
        else public.pin_login_attempts.locked_until
      end
  returning attempts into new_attempts;
end;
$$;

create or replace function public.qroom_clear_pin_failures(p_fingerprint text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.pin_login_attempts where fingerprint = p_fingerprint;
$$;

create or replace function public.qroom_login_moderator(
  p_user_id uuid,
  p_pin text,
  p_pin_digest text
)
returns table (moderator_id uuid, moderator_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_moderator public.moderators%rowtype;
begin
  select * into found_moderator
  from public.moderators
  where pin_digest = p_pin_digest and active = true;

  if not found or found_moderator.pin_hash <> extensions.crypt(p_pin, found_moderator.pin_hash) then
    return;
  end if;

  insert into public.user_sessions (user_id, role, moderator_id, expires_at)
  values (p_user_id, 'moderator', found_moderator.id, now() + interval '30 days')
  on conflict (user_id) do update
  set role = 'moderator', moderator_id = found_moderator.id,
      created_at = now(), expires_at = now() + interval '30 days';

  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values ('moderator.login', found_moderator.name, found_moderator.id, found_moderator.name);

  return query select found_moderator.id, found_moderator.name;
end;
$$;

create or replace function public.qroom_create_moderator(
  p_actor_id uuid,
  p_name text,
  p_pin text,
  p_pin_digest text
)
returns table (id uuid, name text, active boolean, has_pin boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created public.moderators%rowtype;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;

  insert into public.moderators (name, active, pin_hash, pin_digest)
  values (btrim(p_name), true, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), p_pin_digest)
  returning * into created;

  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values ('moderator.create', 'Admin', created.id, created.name);

  return query select created.id, created.name, created.active, true;
end;
$$;

create or replace function public.qroom_update_moderator(
  p_actor_id uuid,
  p_moderator_id uuid,
  p_active boolean,
  p_pin text default null,
  p_pin_digest text default null
)
returns table (id uuid, name text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated public.moderators%rowtype;
  action_name text;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;

  if p_pin is not null then
    update public.moderators
    set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), pin_digest = p_pin_digest
    where moderators.id = p_moderator_id
    returning * into updated;
    action_name := 'moderator.pin_change';
  else
    update public.moderators
    set active = p_active
    where moderators.id = p_moderator_id
    returning * into updated;
    action_name := case when p_active then 'moderator.activate' else 'moderator.deactivate' end;
  end if;

  if not found then raise exception 'Moderator not found'; end if;
  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values (action_name, 'Admin', updated.id, updated.name);
  return query select updated.id, updated.name, updated.active;
end;
$$;

create or replace function public.qroom_update_all_moderators(p_actor_id uuid, p_active boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;

  update public.moderators set active = p_active;
  get diagnostics updated_count = row_count;
  insert into public.activity_logs (action, actor_name)
  values (case when p_active then 'moderators.activate_all' else 'moderators.deactivate_all' end, 'Admin');
  return updated_count;
end;
$$;

create or replace function public.qroom_mark_answered(p_user_id uuid, p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.user_sessions%rowtype;
  actor_name text;
begin
  select * into actor from public.user_sessions
  where user_id = p_user_id and expires_at > now();
  if not found then raise exception 'Not authorized'; end if;

  if actor.role = 'moderator' then
    select name into actor_name from public.moderators
    where id = actor.moderator_id and active = true;
    if not found then raise exception 'Moderator is inactive'; end if;
  else
    actor_name := 'Admin';
  end if;

  update public.questions
  set status = 'answered', answered_at = now(), answered_by = coalesce(actor.moderator_id, p_user_id), answered_by_name = actor_name
  where id = p_question_id and status = 'unanswered';
  if not found then raise exception 'Question not found or already answered'; end if;

  insert into public.activity_logs (action, actor_name, moderator_id, question_id)
  values ('question.answer', actor_name, actor.moderator_id, p_question_id);
end;
$$;

create or replace function public.qroom_reopen_question(p_user_id uuid, p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_user_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;

  update public.questions
  set status = 'unanswered', answered_at = null, answered_by = null, answered_by_name = null
  where id = p_question_id and status = 'answered';
  if not found then raise exception 'Question not found or is not answered'; end if;

  insert into public.activity_logs (action, actor_name, question_id)
  values ('question.reopen', 'Admin', p_question_id);
end;
$$;

revoke all on function public.qroom_begin_pin_login(text) from public, anon, authenticated;
revoke all on function public.qroom_record_pin_failure(text) from public, anon, authenticated;
revoke all on function public.qroom_clear_pin_failures(text) from public, anon, authenticated;
revoke all on function public.qroom_login_moderator(uuid, text, text) from public, anon, authenticated;
revoke all on function public.qroom_create_moderator(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.qroom_update_moderator(uuid, uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.qroom_update_all_moderators(uuid, boolean) from public, anon, authenticated;
revoke all on function public.qroom_mark_answered(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qroom_reopen_question(uuid, uuid) from public, anon, authenticated;

grant execute on function public.qroom_begin_pin_login(text) to service_role;
grant execute on function public.qroom_record_pin_failure(text) to service_role;
grant execute on function public.qroom_clear_pin_failures(text) to service_role;
grant execute on function public.qroom_login_moderator(uuid, text, text) to service_role;
grant execute on function public.qroom_create_moderator(uuid, text, text, text) to service_role;
grant execute on function public.qroom_update_moderator(uuid, uuid, boolean, text, text) to service_role;
grant execute on function public.qroom_update_all_moderators(uuid, boolean) to service_role;
grant execute on function public.qroom_mark_answered(uuid, uuid) to service_role;
grant execute on function public.qroom_reopen_question(uuid, uuid) to service_role;

do $$
begin
  alter publication supabase_realtime add table public.questions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;
