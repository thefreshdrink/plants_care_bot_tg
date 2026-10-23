-- вечернее напоминание: час (null — выключено) и дата последнего, чтобы не слать дважды
alter table public.users
  add column if not exists evening_hour int default 20 check (evening_hour between 0 and 23),
  add column if not exists last_evening_on date;
