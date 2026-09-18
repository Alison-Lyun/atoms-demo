-- Upgrade existing installations without changing table data, RLS, ownership checks,
-- RPC signatures or execute privileges. CREATE OR REPLACE preserves function grants.
-- PostgREST 14 retries SQLSTATE 40001 indefinitely. A stale expected revision
-- is deterministic and must be returned to the caller as HTTP 409 instead.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
begin;

create or replace function public.save_project_snapshot(p_project jsonb, p_expected_revision bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  project_id_value uuid := (p_project ->> 'id')::uuid;
  existing_owner uuid;
  existing_revision bigint;
  existing_created_at timestamptz;
  version_count_value integer;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < -1
    or jsonb_typeof(p_project) is distinct from 'object'
    or jsonb_typeof(p_project -> 'messages') is distinct from 'array'
    or jsonb_typeof(p_project -> 'versions') is distinct from 'array'
    or jsonb_typeof(p_project -> 'runs') is distinct from 'array'
    or jsonb_typeof(p_project -> 'appState') is distinct from 'object'
    or (p_project ->> 'revision')::bigint is distinct from p_expected_revision + 1
    or (p_project ->> 'dataRevision')::bigint is null then
    raise exception 'Invalid project snapshot' using errcode = '22023';
  end if;
  if p_project ->> 'currentVersionId' is not null and not exists (
    select 1 from jsonb_array_elements(p_project -> 'versions') v
    where v ->> 'id' = p_project ->> 'currentVersionId' and v ->> 'status' = 'ready'
  ) then
    raise exception 'Current version must refer to a ready version in this project' using errcode = '22023';
  end if;
  select count(*)::integer into version_count_value
    from jsonb_array_elements(p_project -> 'versions') v where v ->> 'status' = 'ready';

  if p_expected_revision = -1 then
    -- A creation collision fails; it never overwrites an existing owner's row.
    insert into public.projects(id, owner_id, title, created_at, updated_at, revision, data_revision, current_version_id, version_count)
      values(project_id_value, caller, p_project ->> 'title', (p_project ->> 'createdAt')::timestamptz,
        (p_project ->> 'updatedAt')::timestamptz, 0, (p_project ->> 'dataRevision')::bigint,
        p_project ->> 'currentVersionId', version_count_value);
  else
    select p.owner_id, p.revision, p.created_at into existing_owner, existing_revision, existing_created_at
      from public.projects p where p.id = project_id_value for update;
    if not found or existing_owner <> caller then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
    if existing_revision <> p_expected_revision then
      -- This is a deterministic CAS conflict, not a retryable serialization failure.
      raise exception 'Revision conflict' using errcode = 'PT409';
    end if;
    if (p_project ->> 'createdAt')::timestamptz is distinct from existing_created_at then
      raise exception 'Project creation time is immutable' using errcode = '22023';
    end if;
    update public.projects set title = p_project ->> 'title',
      updated_at = (p_project ->> 'updatedAt')::timestamptz,
      revision = p_expected_revision + 1, data_revision = (p_project ->> 'dataRevision')::bigint,
      current_version_id = p_project ->> 'currentVersionId', version_count = version_count_value
      where id = project_id_value and owner_id = caller;
  end if;

  delete from public.messages where project_id = project_id_value and owner_id = caller;
  delete from public.versions where project_id = project_id_value and owner_id = caller;
  delete from public.runs where project_id = project_id_value and owner_id = caller;
  delete from public.app_state where project_id = project_id_value and owner_id = caller;

  insert into public.messages(project_id, owner_id, id, ordinal, payload)
    select project_id_value, caller, value ->> 'id', (ordinality - 1)::integer, value
    from jsonb_array_elements(p_project -> 'messages') with ordinality;
  insert into public.versions(project_id, owner_id, id, ordinal, payload)
    select project_id_value, caller, value ->> 'id', (ordinality - 1)::integer, value
    from jsonb_array_elements(p_project -> 'versions') with ordinality;
  insert into public.runs(project_id, owner_id, id, ordinal, payload)
    select project_id_value, caller, value ->> 'id', (ordinality - 1)::integer, value
    from jsonb_array_elements(p_project -> 'runs') with ordinality;
  insert into public.app_state(project_id, owner_id, payload)
    values(project_id_value, caller, p_project -> 'appState');
  -- Every table update above belongs to this one transaction. Any constraint
  -- error rolls back the project row, versions, messages, runs and app data.
end;
$$;

commit;
