-- CV Management intake: record recruiter and area for each CV
alter table public.cv_applicants
  add column if not exists recruiter_id uuid references public.recruiters(id),
  add column if not exists branch_id uuid references public.branches(id);

create index if not exists cv_applicants_recruiter_id_idx
  on public.cv_applicants(recruiter_id);

create index if not exists cv_applicants_branch_id_idx
  on public.cv_applicants(branch_id);
