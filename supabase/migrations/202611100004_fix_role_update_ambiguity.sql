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

  select m.assigned_role into previous_role
  from public.moderators as m
  where m.id = p_user_id
  for update;
  if not found then raise exception 'User not found'; end if;

  update public.moderators as m
  set assigned_role = p_role
  where m.id = p_user_id
  returning m.* into updated;

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
