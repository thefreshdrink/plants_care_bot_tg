alter table plants add column if not exists room text;
update plants set room = case
  when care->>'place_note' like 'входная%' then 'прихожая'
  when care->>'place_note' like 'комната%' then 'комната'
  when care->>'place_note' like 'патио%' then 'патио'
  when care->>'place_note' like 'кухня%' then 'кухня'
  else room end
where room is null;
create table if not exists icons (
  user_id bigint not null references users(telegram_id) on delete cascade,
  key text not null,
  custom_emoji_id text not null,
  primary key (user_id, key)
);
alter table icons enable row level security;
revoke all on table public.icons from anon, authenticated;
select room, count(*) from plants group by room;
