create extension if not exists pgcrypto with schema extensions;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  join_code_hash text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists companies_name_normalized_unique
  on public.companies (lower(btrim(name)));

create table if not exists public.company_members (
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id),
  unique (user_id)
);

create table if not exists public.door_entries (
  company_id uuid not null references public.companies(id) on delete cascade,
  id text not null,
  date date not null,
  address text not null,
  outcome text not null,
  contact text not null default '',
  phone text not null default '',
  notes text not null default '',
  lat double precision,
  lng double precision,
  updated_at timestamptz not null default now(),
  primary key (company_id, id)
);

create or replace function public.is_company_member(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.company_members
    where company_id = target_company_id and user_id = auth.uid()
  );
$$;

revoke all on function public.is_company_member(uuid) from public, anon;
grant execute on function public.is_company_member(uuid) to authenticated;

create or replace function public.create_company(p_company_name text, p_join_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  new_company public.companies%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before creating a company workspace.';
  end if;
  if p_company_name is null or length(btrim(p_company_name)) not between 2 and 120 then
    raise exception 'Enter a company name between 2 and 120 characters.';
  end if;
  if p_join_code is null or length(p_join_code) not between 16 and 128 then
    raise exception 'The private join code must be at least 16 characters.';
  end if;
  if exists (select 1 from public.company_members where user_id = auth.uid()) then
    raise exception 'This account already belongs to a company workspace.';
  end if;

  insert into public.companies (name, join_code_hash)
  values (btrim(p_company_name), extensions.crypt(p_join_code, extensions.gen_salt('bf')))
  returning * into new_company;

  insert into public.company_members (company_id, user_id, role)
  values (new_company.id, auth.uid(), 'owner');

  return jsonb_build_object(
    'company_id', new_company.id,
    'company_name', new_company.name,
    'role', 'owner'
  );
exception
  when unique_violation then
    raise exception 'A company with that name or an account membership already exists. Choose Join existing company if you are on that team.';
end;
$$;

create or replace function public.join_company(p_company_name text, p_join_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  target_company public.companies%rowtype;
  existing_company_id uuid;
  existing_role text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining a company workspace.';
  end if;
  if p_company_name is null or length(btrim(p_company_name)) not between 2 and 120
    or p_join_code is null or length(p_join_code) not between 16 and 128 then
    raise exception 'Enter the exact company name and its private join code.';
  end if;

  select * into target_company
  from public.companies
  where name = btrim(p_company_name)
    and join_code_hash = extensions.crypt(p_join_code, join_code_hash);
  if not found then
    raise exception 'Company name or join code is incorrect. Check both with your company owner.';
  end if;

  select company_id, role into existing_company_id, existing_role
  from public.company_members where user_id = auth.uid();
  if existing_company_id is not null then
    if existing_company_id = target_company.id then
      return jsonb_build_object(
        'company_id', target_company.id,
        'company_name', target_company.name,
        'role', existing_role
      );
    end if;
    raise exception 'This account already belongs to another company workspace.';
  end if;

  insert into public.company_members (company_id, user_id, role)
  values (target_company.id, auth.uid(), 'member');

  return jsonb_build_object(
    'company_id', target_company.id,
    'company_name', target_company.name,
    'role', 'member'
  );
end;
$$;

create or replace function public.get_my_company()
returns table (company_id uuid, company_name text, role text)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select c.id, c.name, m.role
  from public.company_members m
  join public.companies c on c.id = m.company_id
  where m.user_id = auth.uid();
$$;

revoke all on function public.create_company(text, text) from public, anon;
revoke all on function public.join_company(text, text) from public, anon;
revoke all on function public.get_my_company() from public, anon;
grant execute on function public.create_company(text, text) to authenticated;
grant execute on function public.join_company(text, text) to authenticated;
grant execute on function public.get_my_company() to authenticated;

alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.door_entries enable row level security;

drop policy if exists "Members can read their company" on public.companies;
create policy "Members can read their company" on public.companies
  for select to authenticated using (public.is_company_member(id));

drop policy if exists "Users can read their own membership" on public.company_members;
create policy "Users can read their own membership" on public.company_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "Company members can read daily logs" on public.door_entries;
create policy "Company members can read daily logs" on public.door_entries
  for select to authenticated using (public.is_company_member(company_id));

drop policy if exists "Company members can add daily logs" on public.door_entries;
create policy "Company members can add daily logs" on public.door_entries
  for insert to authenticated with check (public.is_company_member(company_id));

drop policy if exists "Company members can update daily logs" on public.door_entries;
create policy "Company members can update daily logs" on public.door_entries
  for update to authenticated
  using (public.is_company_member(company_id))
  with check (public.is_company_member(company_id));

drop policy if exists "Company members can delete daily logs" on public.door_entries;
create policy "Company members can delete daily logs" on public.door_entries
  for delete to authenticated using (public.is_company_member(company_id));

revoke all on public.companies from anon, authenticated;
grant select (id, name) on public.companies to authenticated;
revoke all on public.company_members from anon, authenticated;
grant select on public.company_members to authenticated;
grant select, insert, update, delete on public.door_entries to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.door_entries;
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'supabase_realtime publication is not available; enable Realtime for door_entries in the Supabase dashboard.';
end;
$$;
