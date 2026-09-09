-- Cloudflare D1 durable ledger. R2 holds all binary assets privately.
create table if not exists users (
  id text primary key,
  email text not null unique,
  role text not null check (role in ('admin', 'creator')),
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at text not null,
  created_at text not null default (datetime('now'))
);
create index if not exists sessions_hash_idx on sessions(token_hash);
create table if not exists projects (
  id text primary key,
  owner_id text not null references users(id),
  title text not null,
  input_mode text not null check (input_mode in ('image', 'psd', 'stretch', 'pro')),
  status text not null default 'intake' check (status in ('intake','queued','processing','needs_review','revision_requested','approved','failed','archived')),
  metadata text not null default '{}',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create index if not exists projects_owner_updated_idx on projects(owner_id, updated_at desc);
create table if not exists jobs (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  stage text not null check (stage in ('intake','preparation','decomposition','rigging','validation','delivery')),
  status text not null check (status in ('queued','running','succeeded','failed','blocked','cancelled')),
  attempt integer not null default 0,
  relay_job_id text unique,
  message text,
  error_detail text,
  payload text not null default '{}',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);
create index if not exists jobs_project_updated_idx on jobs(project_id, updated_at desc);
create table if not exists artifacts (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  job_id text references jobs(id) on delete set null,
  kind text not null check (kind in ('source','prepared_image','psd','cmo3','moc3_bundle','stretch','report','preview','diagnostic')),
  storage_key text not null unique,
  filename text not null,
  mime_type text,
  byte_size integer not null,
  retention_class text not null check (retention_class in ('permanent','diagnostic')),
  delete_after text,
  created_at text not null default (datetime('now'))
);
create index if not exists artifacts_project_created_idx on artifacts(project_id, created_at desc);
create table if not exists reviews (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  artifact_id text references artifacts(id) on delete set null,
  status text not null check (status in ('pending','approved','rejected')),
  checklist text not null default '{}',
  note text,
  reviewer_id text references users(id),
  created_at text not null default (datetime('now')),
  decided_at text
);
create table if not exists audit_events (
  id integer primary key autoincrement,
  actor_id text references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  detail text not null default '{}',
  created_at text not null default (datetime('now'))
);
create index if not exists audit_events_created_idx on audit_events(created_at desc);
