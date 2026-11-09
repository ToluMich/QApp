create or replace function public.qroom_delete_moderator(
  p_actor_id uuid,
  p_moderator_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_name text;
begin
  if not exists (
    select 1 from public.user_sessions
    where user_id = p_actor_id and role = 'admin' and expires_at > now()
  ) then
    raise exception 'Not authorized';
  end if;

  delete from public.moderators
  where id = p_moderator_id
  returning name into deleted_name;

  if not found then raise exception 'Moderator not found'; end if;

  insert into public.activity_logs (action, actor_name, moderator_name)
  values ('moderator.delete', 'Admin', deleted_name);
end;
$$;

create or replace function public.qroom_delete_all_questions(p_actor_id uuid)
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

  delete from public.questions;
  get diagnostics deleted_count = row_count;

  insert into public.activity_logs (action, actor_name)
  values ('questions.delete_all', 'Admin');

  return deleted_count;
end;
$$;

revoke all on function public.qroom_delete_moderator(uuid, uuid) from public, anon, authenticated;
revoke all on function public.qroom_delete_all_questions(uuid) from public, anon, authenticated;

grant execute on function public.qroom_delete_moderator(uuid, uuid) to service_role;
grant execute on function public.qroom_delete_all_questions(uuid) to service_role;
