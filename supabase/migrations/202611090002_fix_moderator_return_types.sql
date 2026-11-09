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

  return query select found_moderator.id, found_moderator.name::text;
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

  return query select created.id, created.name::text, created.active, true;
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
  return query select updated.id, updated.name::text, updated.active;
end;
$$;
