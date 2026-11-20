-- SureX CV Management: 30-day recoverable deletion
alter table public.cv_applicants
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id),
  add column if not exists restored_at timestamptz,
  add column if not exists restored_by uuid references auth.users(id);

create index if not exists cv_applicants_deleted_at_idx
  on public.cv_applicants(deleted_at)
  where deleted_at is not null;
