-- SureX CV Management module
create table if not exists public.cv_applicants (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text,
  phone text,
  source text,
  status text not null default 'New',
  feedback text,
  dropbox_path text not null,
  call_attempts integer not null default 0 check (call_attempts between 0 and 3),
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  follow_up_stopped boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cv_status_check check (status in ('New','Interview Booked','Interested','Not Interested','Could Not Reach','No Response','Hired / Converted','Follow-up Stopped - 3 Attempts'))
);

create table if not exists public.cv_contact_attempts (
  id uuid primary key default gen_random_uuid(),
  cv_id uuid not null references public.cv_applicants(id) on delete cascade,
  attempt_number integer not null check (attempt_number between 1 and 3),
  outcome text not null,
  notes text,
  contacted_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists cv_applicants_follow_up_idx
  on public.cv_applicants(next_follow_up_at)
  where follow_up_stopped = false and next_follow_up_at is not null;

alter table public.cv_applicants enable row level security;
alter table public.cv_contact_attempts enable row level security;

drop policy if exists "cv_applicants_staff_select" on public.cv_applicants;
create policy "cv_applicants_staff_select" on public.cv_applicants
for select to authenticated using (public.get_my_role() in ('admin','assistant'));

drop policy if exists "cv_applicants_staff_insert" on public.cv_applicants;
create policy "cv_applicants_staff_insert" on public.cv_applicants
for insert to authenticated with check (public.get_my_role() in ('admin','assistant'));

drop policy if exists "cv_applicants_staff_update" on public.cv_applicants;
create policy "cv_applicants_staff_update" on public.cv_applicants
for update to authenticated using (public.get_my_role() in ('admin','assistant'))
with check (public.get_my_role() in ('admin','assistant'));

drop policy if exists "cv_applicants_staff_delete" on public.cv_applicants;
create policy "cv_applicants_staff_delete" on public.cv_applicants
for delete to authenticated using (public.get_my_role() in ('admin','assistant'));

drop policy if exists "cv_attempts_staff_select" on public.cv_contact_attempts;
create policy "cv_attempts_staff_select" on public.cv_contact_attempts
for select to authenticated using (public.get_my_role() in ('admin','assistant'));

drop policy if exists "cv_attempts_staff_insert" on public.cv_contact_attempts;
create policy "cv_attempts_staff_insert" on public.cv_contact_attempts
for insert to authenticated with check (public.get_my_role() in ('admin','assistant'));

grant select, insert, update, delete on public.cv_applicants to authenticated;
grant select, insert on public.cv_contact_attempts to authenticated;
