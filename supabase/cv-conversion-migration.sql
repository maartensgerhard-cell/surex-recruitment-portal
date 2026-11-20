-- CV-to-onboarding conversion link
alter table public.cv_applicants
  add column if not exists candidate_id uuid references public.candidates(id) on delete set null;
create index if not exists cv_applicants_candidate_id_idx on public.cv_applicants(candidate_id);
