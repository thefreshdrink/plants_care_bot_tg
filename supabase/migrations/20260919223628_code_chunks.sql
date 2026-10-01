create table if not exists code_chunks (part int primary key, body text not null);
alter table code_chunks enable row level security;
revoke all on table public.code_chunks from anon, authenticated;
