-- Morph production foundation. Apply this to a dedicated Supabase project
-- through a reviewed migration; never run it against an unrelated project.
-- Browser clients use only the publishable key. Worker/API use service_role.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 2 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'creator')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text not null check (char_length(title) between 1 and 160),
  status text not null default 'intake' check (status in (
    'intake', 'queued', 'processing', 'needs_review', 'revision_requested',
    'approved', 'failed', 'archived'
  )),
  input_mode text not null default 'image' check (input_mode in ('image', 'psd', 'stretch', 'pro')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_workspace_updated_idx on public.projects (workspace_id, updated_at desc);

create table if not exists public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stage text not null check (stage in ('intake', 'preparation', 'decomposition', 'rigging', 'validation', 'delivery')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  worker_job_id text unique,
  message text,
  error_code text,
  error_detail text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pipeline_jobs_project_updated_idx on public.pipeline_jobs (project_id, updated_at desc);
create index if not exists pipeline_jobs_pending_idx on public.pipeline_jobs (status, created_at) where status in ('queued', 'blocked');

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  job_id uuid references public.pipeline_jobs(id) on delete set null,
  kind text not null check (kind in ('source', 'prepared_image', 'psd', 'cmo3', 'moc3_bundle', 'stretch', 'report', 'preview', 'diagnostic')),
  storage_bucket text not null default 'live2d-assets',
  storage_path text not null unique,
  filename text not null,
  mime_type text,
  byte_size bigint check (byte_size >= 0),
  sha256 text,
  retention_class text not null default 'permanent' check (retention_class in ('permanent', 'transient', 'diagnostic')),
  delete_after timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists artifacts_project_kind_idx on public.artifacts (project_id, kind, created_at desc);

create table if not exists public.review_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  artifact_id uuid references public.artifacts(id) on delete set null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  checklist jsonb not null default '{}'::jsonb,
  note text,
  reviewer_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_events_workspace_created_idx on public.audit_events (workspace_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute procedure public.touch_updated_at();
drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at before update on public.projects for each row execute procedure public.touch_updated_at();
drop trigger if exists pipeline_jobs_touch_updated_at on public.pipeline_jobs;
create trigger pipeline_jobs_touch_updated_at before update on public.pipeline_jobs for each row execute procedure public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (new.id, coalesce(new.email, ''), new.raw_user_meta_data ->> 'display_name')
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;
drop trigger if exists auth_user_profile on auth.users;
create trigger auth_user_profile after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = target_workspace and m.user_id = auth.uid());
$$;
create or replace function public.is_workspace_admin(target_workspace uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = target_workspace and m.user_id = auth.uid() and m.role = 'admin');
$$;
create or replace function public.storage_workspace_id(object_name text)
returns uuid language plpgsql immutable set search_path = public as $$
begin return split_part(object_name, '/', 1)::uuid;
exception when others then return null;
end;
$$;

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.pipeline_jobs enable row level security;
alter table public.artifacts enable row level security;
alter table public.review_decisions enable row level security;
alter table public.audit_events enable row level security;

create policy "profiles read self" on public.profiles for select to authenticated using (user_id = auth.uid());
create policy "profiles update self" on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "workspaces read membership" on public.workspaces for select to authenticated using (public.is_workspace_member(id));
create policy "members read membership" on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "projects read membership" on public.projects for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "projects create creator" on public.projects for insert to authenticated with check (public.is_workspace_member(workspace_id) and created_by = auth.uid());
create policy "projects update creator or admin" on public.projects for update to authenticated using (created_by = auth.uid() or public.is_workspace_admin(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "jobs read membership" on public.pipeline_jobs for select to authenticated using (exists (select 1 from public.projects p where p.id = project_id and public.is_workspace_member(p.workspace_id)));
create policy "artifacts read membership" on public.artifacts for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "artifacts create own project" on public.artifacts for insert to authenticated with check (
  public.is_workspace_member(workspace_id) and exists (
    select 1 from public.projects p where p.id = project_id and p.workspace_id = workspace_id and p.created_by = auth.uid()
  )
);
create policy "reviews read membership" on public.review_decisions for select to authenticated using (exists (select 1 from public.projects p where p.id = project_id and public.is_workspace_member(p.workspace_id)));
create policy "reviews admin write" on public.review_decisions for all to authenticated using (exists (select 1 from public.projects p where p.id = project_id and public.is_workspace_admin(p.workspace_id))) with check (exists (select 1 from public.projects p where p.id = project_id and public.is_workspace_admin(p.workspace_id)));
create policy "audit admin read" on public.audit_events for select to authenticated using (public.is_workspace_admin(workspace_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('live2d-assets', 'live2d-assets', false, 104857600, array['image/png', 'image/jpeg', 'image/vnd.adobe.photoshop', 'application/zip', 'application/json', 'application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create policy "assets read workspace" on storage.objects for select to authenticated using (bucket_id = 'live2d-assets' and public.is_workspace_member(public.storage_workspace_id(name)));
create policy "assets upload workspace" on storage.objects for insert to authenticated with check (bucket_id = 'live2d-assets' and public.is_workspace_member(public.storage_workspace_id(name)));

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles, public.projects to authenticated;
grant select, insert on public.artifacts to authenticated;
grant select on public.workspaces, public.workspace_members, public.pipeline_jobs, public.review_decisions, public.audit_events to authenticated;
grant insert, update, delete on public.review_decisions to authenticated;
grant execute on function public.is_workspace_member(uuid), public.is_workspace_admin(uuid), public.storage_workspace_id(text) to authenticated;

-- Bootstrap only after an invited first user has signed in once:
-- insert into public.workspaces (slug, name) values ('morph-studio', 'Morph Studio') returning id;
-- insert into public.workspace_members (workspace_id, user_id, role) values ('<workspace uuid>', '<auth user uuid>', 'admin');
