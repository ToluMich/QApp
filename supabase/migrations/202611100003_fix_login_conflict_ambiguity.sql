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
  on conflict on constraint user_sessions_pkey do update
  set role = excluded.role, moderator_id = excluded.moderator_id,
      created_at = now(), expires_at = excluded.expires_at;

  insert into public.activity_logs (action, actor_name, moderator_id, moderator_name)
  values (found_user.assigned_role || '.login', found_user.name, found_user.id, found_user.name);

  return query select found_user.id, found_user.name::text, found_user.assigned_role;
end;
$$;
