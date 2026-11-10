alter table public.moderators
  add column if not exists assigned_role text not null default 'moderator';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.moderators'::regclass
      and conname = 'moderators_assigned_role_check'
  ) then
    alter table public.moderators
      add constraint moderators_assigned_role_check
      check (assigned_role in ('moderator', 'viewer'));
  end if;
end;
$$;

alter table public.user_sessions
  drop constraint if exists user_sessions_role_check;
alter table public.user_sessions
  add constraint user_sessions_role_check
  check (role in ('admin', 'moderator', 'viewer'));
alter table public.user_sessions
  drop constraint if exists moderator_session_has_moderator;
alter table public.user_sessions
  add constraint moderator_session_has_moderator
  check (
    (role in ('moderator', 'viewer') and moderator_id is not null)
    or (role = 'admin' and moderator_id is null)
  );

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
      and (
        s.role = 'admin'
        or (
          s.role in ('moderator', 'viewer')
          and m.active = true
          and m.assigned_role = s.role
        )
      )
  );
$$;

create or replace function public.qroom_can_submit_questions()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from public.user_sessions s
    where s.user_id = (select auth.uid())
      and s.expires_at > now()
  );
$$;

drop policy if exists "Visitors can submit valid anonymous questions" on public.questions;
create policy "Visitors can submit valid anonymous questions"
on public.questions for insert to anon, authenticated
with check (
  status = 'unanswered'
  and answered_at is null
  and answered_by is null
  and answered_by_name is null
  and char_length(btrim(text)) between 1 and 280
  and (select public.qroom_can_submit_questions())
);

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
  found_user public.moderators%rowtype;
begin
  if p_user_id is null or p_pin is null or p_pin !~ '^[0-9]{6}$'
    or p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$'
  then
    return;
  end if;

  select * into found_user
  from public.moderators
  where pin_digest = p_pin_digest and active = true and assigned_role = 'moderator'
  for update;

  if not found or found_user.pin_hash <> extensions.crypt(p_pin, found_user.pin_hash) then
    return;
  end if;

  insert into public.user_sessions (user_id, role, moderator_id, expires_at)
  values (p_user_id, 'moderator', found_user.id, now() + interval '30 days')
  on conflict (user_id) do update
  set role = 'moderator', moderator_id = found_user.id,
      created_at = now(), expires_at = now() + interval '30 days';

  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values ('moderator.login', found_user.name, found_user.id, found_user.name);

  return query select found_user.id, found_user.name;
end;
$$;

create or replace function public.qroom_login_user(
  p_user_id uuid,
  p_pin text,
  p_pin_digest text
)
returns table (user_id uuid, user_name text, assigned_role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  found_user public.moderators%rowtype;
begin
  if p_user_id is null or p_pin is null or p_pin !~ '^[0-9]{6}$'
    or p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$'
  then
    return;
  end if;

  select * into found_user
  from public.moderators
  where pin_digest = p_pin_digest and active = true
  for update;

  if not found or found_user.pin_hash <> extensions.crypt(p_pin, found_user.pin_hash) then
    return;
  end if;

  insert into public.user_sessions (user_id, role, moderator_id, expires_at)
  values (p_user_id, found_user.assigned_role, found_user.id, now() + interval '30 days')
  on conflict (user_id) do update
  set role = excluded.role, moderator_id = excluded.moderator_id,
      created_at = now(), expires_at = excluded.expires_at;

  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values (found_user.assigned_role || '.login', found_user.name, found_user.id, found_user.name);

  return query select found_user.id, found_user.name, found_user.assigned_role;
end;
$$;

create or replace function public.qroom_create_user(
  p_actor_id uuid,
  p_name text,
  p_role text,
  p_pin text,
  p_pin_digest text
)
returns table (id uuid, name text, assigned_role text, active boolean, has_pin boolean)
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
  if p_role is null or p_role not in ('moderator', 'viewer')
    or p_name is null or char_length(btrim(p_name)) not between 1 and 80
    or p_pin is null or p_pin !~ '^[0-9]{6}$'
    or p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$'
  then
    raise exception 'Invalid user details';
  end if;

  insert into public.moderators (name, assigned_role, active, pin_hash, pin_digest)
  values (
    btrim(p_name),
    p_role,
    true,
    extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
    p_pin_digest
  )
  returning * into created;

  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values ('user.create', 'Admin', created.id, created.name);

  return query select created.id, created.name, created.assigned_role, created.active, true;
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
begin
  return query
  select created.id, created.name, created.active, created.has_pin
  from public.qroom_create_user(p_actor_id, p_name, 'moderator', p_pin, p_pin_digest) created;
end;
$$;

create or replace function public.qroom_update_user_role(
  p_actor_id uuid,
  p_user_id uuid,
  p_role text
)
returns table (id uuid, name text, assigned_role text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated public.moderators%rowtype;
  previous_role text;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;
  if p_role is null or p_role not in ('moderator', 'viewer') then
    raise exception 'Invalid user role';
  end if;

  select assigned_role into previous_role
  from public.moderators
  where id = p_user_id
  for update;
  if not found then raise exception 'User not found'; end if;

  update public.moderators
  set assigned_role = p_role
  where id = p_user_id
  returning * into updated;

  if previous_role <> p_role then
    update public.user_sessions
    set expires_at = least(expires_at, now())
    where moderator_id = p_user_id;
    insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
    values ('user.role_change', 'Admin', updated.id, updated.name);
  end if;

  return query select updated.id, updated.name, updated.assigned_role, updated.active;
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
  user_found boolean := false;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;

  if p_pin is not null then
    if p_pin !~ '^[0-9]{6}$' or p_pin_digest is null or p_pin_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'Invalid access code';
    end if;
    update public.moderators
    set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), pin_digest = p_pin_digest
    where moderators.id = p_moderator_id
    returning * into updated;
    user_found := found;
    action_name := 'user.pin_change';
    if user_found then
      update public.user_sessions
      set expires_at = least(expires_at, now())
      where moderator_id = p_moderator_id;
    end if;
  else
    if p_active is null then raise exception 'Active status is required'; end if;
    update public.moderators
    set active = p_active
    where moderators.id = p_moderator_id
    returning * into updated;
    user_found := found;
    action_name := case when p_active then 'user.activate' else 'user.deactivate' end;
    if user_found and not p_active then
      update public.user_sessions
      set expires_at = least(expires_at, now())
      where moderator_id = p_moderator_id;
    end if;
  end if;

  if not user_found then raise exception 'User not found'; end if;
  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values (action_name, 'Admin', updated.id, updated.name);
  return query select updated.id, updated.name, updated.active;
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
  if not found or actor.role not in ('admin', 'moderator') then
    raise exception 'Not authorized';
  end if;

  if actor.role = 'moderator' then
    select name into actor_name from public.moderators
    where id = actor.moderator_id and active = true and assigned_role = 'moderator'
    for update;
    if not found then raise exception 'Moderator is inactive'; end if;
    select * into actor from public.user_sessions
    where user_id = p_user_id
      and role = 'moderator'
      and moderator_id = actor.moderator_id
      and expires_at > now()
    for update;
    if not found then raise exception 'Not authorized'; end if;
  else
    actor_name := 'Admin';
  end if;

  update public.questions
  set status = 'answered', answered_at = now(),
      answered_by = coalesce(actor.moderator_id, p_user_id), answered_by_name = actor_name
  where id = p_question_id and status = 'unanswered';
  if not found then raise exception 'Question not found or already answered'; end if;

  insert into public.activity_logs (action, actor_name, moderator_id, question_id)
  values ('question.answer', actor_name, actor.moderator_id, p_question_id);
end;
$$;

create or replace function public.qroom_delete_selected_questions(
  p_actor_id uuid,
  p_question_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;
  if p_question_ids is null
    or cardinality(p_question_ids) < 1
    or cardinality(p_question_ids) > 500
    or array_position(p_question_ids, null) is not null
    or cardinality(p_question_ids) <> (
      select count(distinct items.selected_id) from unnest(p_question_ids) as items(selected_id)
    )
  then
    raise exception 'Invalid question selection';
  end if;

  delete from public.questions where id = any(p_question_ids);
  get diagnostics deleted_count = row_count;
  insert into public.activity_logs (action, actor_name)
  values ('questions.delete_selected', 'Admin');
  return deleted_count;
end;
$$;

create or replace function public.qroom_is_recent_activity_log(p_log_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.qroom_can_read_activity_logs() and exists (
    select 1
    from (
      select id
      from public.activity_logs
      order by created_at desc, id desc
      limit 10
    ) recent
    where recent.id = p_log_id
  );
$$;

drop policy if exists "Admins can read activity logs" on public.activity_logs;
create policy "Admins can read latest activity logs"
on public.activity_logs for select to authenticated
using (
  (select public.qroom_can_read_activity_logs())
  and (select public.qroom_is_recent_activity_log(id))
);

revoke all on function public.qroom_login_user(uuid, text, text) from public, anon, authenticated;
revoke all on function public.qroom_can_submit_questions() from public;
revoke all on function public.qroom_create_user(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.qroom_update_user_role(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qroom_delete_selected_questions(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.qroom_is_recent_activity_log(bigint) from public, anon;
revoke all on function public.qroom_login_moderator(uuid, text, text) from public, anon, authenticated;
revoke all on function public.qroom_update_moderator(uuid, uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.qroom_mark_answered(uuid, uuid) from public, anon, authenticated;
grant execute on function public.qroom_login_user(uuid, text, text) to service_role;
grant execute on function public.qroom_can_submit_questions() to anon, authenticated;
grant execute on function public.qroom_create_user(uuid, text, text, text, text) to service_role;
grant execute on function public.qroom_update_user_role(uuid, uuid, text) to service_role;
grant execute on function public.qroom_delete_selected_questions(uuid, uuid[]) to service_role;
grant execute on function public.qroom_is_recent_activity_log(bigint) to authenticated;
grant execute on function public.qroom_login_moderator(uuid, text, text) to service_role;
grant execute on function public.qroom_update_moderator(uuid, uuid, boolean, text, text) to service_role;
grant execute on function public.qroom_mark_answered(uuid, uuid) to service_role;

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
  if p_active is null then raise exception 'Active status is required'; end if;

  update public.moderators set active = p_active where assigned_role = 'moderator';
  get diagnostics updated_count = row_count;
  if not p_active then
    update public.user_sessions
    set expires_at = least(expires_at, now())
    where moderator_id in (
      select id from public.moderators where assigned_role = 'moderator'
    );
  end if;
  insert into public.activity_logs (action, actor_name)
  values (case when p_active then 'users.activate_all' else 'users.deactivate_all' end, 'Admin');
  return updated_count;
end;
$$;

revoke all on function public.qroom_create_moderator(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.qroom_update_all_moderators(uuid, boolean) from public, anon, authenticated;
grant execute on function public.qroom_create_moderator(uuid, text, text, text) to service_role;
grant execute on function public.qroom_update_all_moderators(uuid, boolean) to service_role;
