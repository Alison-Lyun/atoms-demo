-- Run once in the Supabase SQL editor or with `supabase db push`.
-- Enable Anonymous Sign-Ins in Authentication > Providers separately.
begin;

create table public.projects (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null check (revision >= 0),
  data_revision bigint not null check (data_revision >= 0),
  current_version_id text,
  version_count integer not null default 0 check (version_count >= 0),
  unique (id, owner_id)
);
create index projects_owner_updated on public.projects (owner_id, updated_at desc);

-- Child identifiers are scoped to a project. Composite foreign keys prevent a
-- child with one user's owner_id from ever pointing at another user's project.
create table public.messages (
  project_id uuid not null,
  owner_id uuid not null,
  id text not null,
  ordinal integer not null check (ordinal >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (project_id, id),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);
create table public.versions (
  project_id uuid not null,
  owner_id uuid not null,
  id text not null,
  ordinal integer not null check (ordinal >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (project_id, id),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);
create table public.runs (
  project_id uuid not null,
  owner_id uuid not null,
  id text not null,
  ordinal integer not null check (ordinal >= 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (project_id, id),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);
create table public.app_state (
  project_id uuid primary key,
  owner_id uuid not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  foreign key (project_id, owner_id) references public.projects(id, owner_id) on delete cascade
);

alter table public.projects enable row level security;
alter table public.messages enable row level security;
alter table public.versions enable row level security;
alter table public.runs enable row level security;
alter table public.app_state enable row level security;

create policy projects_owner_select on public.projects for select to authenticated
  using (owner_id = (select auth.uid()));
create policy messages_owner_select on public.messages for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())
  ));
create policy versions_owner_select on public.versions for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())
  ));
create policy runs_owner_select on public.runs for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())
  ));
create policy app_state_owner_select on public.app_state for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())
  ));

-- Table mutation is intentionally unavailable to clients. Writes must go
-- through the ownership-checked transactional RPC below, preserving CAS.
revoke all on public.projects, public.messages, public.versions, public.runs, public.app_state from anon, authenticated;
grant select on public.projects, public.messages, public.versions, public.runs, public.app_state to authenticated;

-- One SELECT provides a consistent MVCC snapshot across every child table.
-- This function runs as the caller and is also protected by table RLS.
create function public.load_project_snapshot(p_project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'createdAt', p.created_at, 'updatedAt', p.updated_at,
    'revision', p.revision, 'dataRevision', p.data_revision, 'currentVersionId', p.current_version_id,
    'messages', coalesce((select jsonb_agg(m.payload order by m.ordinal) from public.messages m where m.project_id = p.id and m.owner_id = auth.uid()), '[]'::jsonb),
    'versions', coalesce((select jsonb_agg(v.payload order by v.ordinal) from public.versions v where v.project_id = p.id and v.owner_id = auth.uid()), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(r.payload order by r.ordinal) from public.runs r where r.project_id = p.id and r.owner_id = auth.uid()), '[]'::jsonb),
    'appState', coalesce((select s.payload from public.app_state s where s.project_id = p.id and s.owner_id = auth.uid()), '{}'::jsonb)
  )
  from public.projects p where p.id = p_project_id and p.owner_id = auth.uid();
$$;

create function public.save_project_snapshot(p_project jsonb, p_expected_revision bigint)
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

revoke all on function public.load_project_snapshot(uuid) from public, anon;
revoke all on function public.save_project_snapshot(jsonb, bigint) from public, anon;
grant execute on function public.load_project_snapshot(uuid) to authenticated;
grant execute on function public.save_project_snapshot(jsonb, bigint) to authenticated;
commit;
