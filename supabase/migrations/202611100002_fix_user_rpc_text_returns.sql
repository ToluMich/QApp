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

  return query select found_user.id, found_user.name::text;
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

  return query select found_user.id, found_user.name::text, found_user.assigned_role;
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

  return query select created.id, created.name::text, created.assigned_role, created.active, true;
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

  return query select updated.id, updated.name::text, updated.assigned_role, updated.active;
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
  return query select updated.id, updated.name::text, updated.active;
end;
$$;
