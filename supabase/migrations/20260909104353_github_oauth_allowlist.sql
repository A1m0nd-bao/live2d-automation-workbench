-- GitHub is the no-mail login provider. This allowlist is evaluated inside the
-- auth.users trigger, so enabling GitHub signup does not open the workspace.
create table public.access_allowlist (
  email text primary key check (email = lower(email)),
  role public.morph_role not null default 'creator',
  created_at timestamptz not null default now()
);

alter table public.access_allowlist enable row level security;
grant select, insert, update, delete on public.access_allowlist to authenticated;

create policy "allowlist: admin can read" on public.access_allowlist for select to authenticated
using (public.is_morph_admin());
create policy "allowlist: admin can insert" on public.access_allowlist for insert to authenticated
with check (public.is_morph_admin());
create policy "allowlist: admin can update" on public.access_allowlist for update to authenticated
using (public.is_morph_admin()) with check (public.is_morph_admin());
create policy "allowlist: admin can delete" on public.access_allowlist for delete to authenticated
using (public.is_morph_admin());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(coalesce(new.email, new.raw_user_meta_data ->> 'email', ''));
  approved_role public.morph_role;
begin
  if normalized_email = '' then
    raise exception 'A verified GitHub email address is required for this workspace.';
  end if;
  select role into approved_role from public.access_allowlist where email = normalized_email;
  if not found then
    raise exception 'This GitHub email has not been approved for the Morph workspace.';
  end if;
  insert into public.profiles (id, email, role)
  values (new.id, normalized_email, approved_role)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
