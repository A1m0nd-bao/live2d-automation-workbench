-- Morph Live2D production foundation. This migration is safe for Supabase's
-- hosted Postgres and exposes no privileged key to the browser.
create type public.morph_role as enum ('admin', 'creator');
create type public.project_status as enum ('intake', 'queued', 'processing', 'needs_review', 'revision_requested', 'approved', 'failed', 'archived');
create type public.artifact_retention as enum ('permanent', 'diagnostic');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role public.morph_role not null default 'creator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 160),
  input_mode text not null check (input_mode in ('image', 'psd', 'stretch', 'pro')),
  status public.project_status not null default 'intake',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_owner_updated_idx on public.projects(owner_id, updated_at desc);

create table public.jobs (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  stage text not null check (stage in ('intake', 'preparation', 'decomposition', 'rigging', 'validation', 'delivery')),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  relay_job_id text unique,
  message text,
  error_detail text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_project_updated_idx on public.jobs(project_id, updated_at desc);

create table public.artifacts (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  kind text not null check (kind in ('source', 'prepared_image', 'psd', 'cmo3', 'moc3_bundle', 'stretch', 'report', 'preview', 'diagnostic')),
  storage_path text not null unique,
  filename text not null check (char_length(filename) between 1 and 180),
  mime_type text,
  byte_size bigint not null check (byte_size >= 0),
  retention_class public.artifact_retention not null default 'permanent',
  delete_after timestamptz,
  created_at timestamptz not null default now(),
  check ((retention_class = 'permanent' and delete_after is null) or (retention_class = 'diagnostic' and delete_after is not null))
);
create index artifacts_project_created_idx on public.artifacts(project_id, created_at desc);

create table public.reviews (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  artifact_id uuid references public.artifacts(id) on delete set null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  checklist jsonb not null default '{}'::jsonb,
  note text,
  reviewer_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_created_idx on public.audit_events(created_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
for each row execute procedure public.set_updated_at();
create trigger projects_updated_at before update on public.projects
for each row execute procedure public.set_updated_at();
create trigger jobs_updated_at before update on public.jobs
for each row execute procedure public.set_updated_at();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, lower(new.email))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- A narrowly scoped helper avoids recursive RLS lookups. It is never exposed
-- to anonymous visitors and reads only the caller's own immutable role row.
create function public.is_morph_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;
revoke all on function public.is_morph_admin() from public;
grant execute on function public.is_morph_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.jobs enable row level security;
alter table public.artifacts enable row level security;
alter table public.reviews enable row level security;
alter table public.audit_events enable row level security;

grant usage on schema public to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update on public.projects to authenticated;
grant select, insert, update on public.jobs to authenticated;
grant select, insert on public.artifacts to authenticated;
grant select, insert, update on public.reviews to authenticated;
grant select on public.audit_events to authenticated;

create policy "profiles: self or admin can read" on public.profiles for select to authenticated
using (id = (select auth.uid()) or public.is_morph_admin());
create policy "profiles: admin can update" on public.profiles for update to authenticated
using (public.is_morph_admin()) with check (public.is_morph_admin());

create policy "projects: owner or admin can read" on public.projects for select to authenticated
using (owner_id = (select auth.uid()) or public.is_morph_admin());
create policy "projects: creator inserts own" on public.projects for insert to authenticated
with check (owner_id = (select auth.uid()));
create policy "projects: owner or admin can update" on public.projects for update to authenticated
using (owner_id = (select auth.uid()) or public.is_morph_admin())
with check (owner_id = (select auth.uid()) or public.is_morph_admin());

create policy "jobs: project member can read" on public.jobs for select to authenticated
using (exists (select 1 from public.projects where projects.id = jobs.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())));
create policy "jobs: project member can insert" on public.jobs for insert to authenticated
with check (exists (select 1 from public.projects where projects.id = jobs.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())));
create policy "jobs: project member can update" on public.jobs for update to authenticated
using (exists (select 1 from public.projects where projects.id = jobs.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())))
with check (exists (select 1 from public.projects where projects.id = jobs.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())));

create policy "artifacts: project member can read" on public.artifacts for select to authenticated
using (exists (select 1 from public.projects where projects.id = artifacts.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())));
create policy "artifacts: project member can insert" on public.artifacts for insert to authenticated
with check (exists (select 1 from public.projects where projects.id = artifacts.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())));

create policy "reviews: project member can read" on public.reviews for select to authenticated
using (exists (select 1 from public.projects where projects.id = reviews.project_id and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())));
create policy "reviews: admin can insert" on public.reviews for insert to authenticated
with check (public.is_morph_admin() and reviewer_id = (select auth.uid()));
create policy "reviews: admin can update" on public.reviews for update to authenticated
using (public.is_morph_admin()) with check (public.is_morph_admin());

create policy "audit: admin can read" on public.audit_events for select to authenticated
using (public.is_morph_admin());

insert into storage.buckets (id, name, public, file_size_limit)
values ('morph-assets', 'morph-assets', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = 104857600;

create policy "morph assets: project member can read" on storage.objects for select to authenticated
using (
  bucket_id = 'morph-assets' and exists (
    select 1 from public.projects
    where projects.id::text = (storage.foldername(name))[1]
      and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())
  )
);
create policy "morph assets: project member can upload" on storage.objects for insert to authenticated
with check (
  bucket_id = 'morph-assets' and exists (
    select 1 from public.projects
    where projects.id::text = (storage.foldername(name))[1]
      and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())
  )
);
create policy "morph assets: project member can delete own uploads" on storage.objects for delete to authenticated
using (
  bucket_id = 'morph-assets' and exists (
    select 1 from public.projects
    where projects.id::text = (storage.foldername(name))[1]
      and (projects.owner_id = (select auth.uid()) or public.is_morph_admin())
  )
);
