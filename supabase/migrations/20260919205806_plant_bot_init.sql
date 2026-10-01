create table if not exists users (
  telegram_id     bigint primary key,
  first_name      text,
  lat             double precision not null default 34.6841,
  lon             double precision not null default 33.0379,
  tz              text not null default 'Asia/Nicosia',
  digest_hour     int  not null default 8 check (digest_hour between 0 and 23),
  last_digest_on  date,
  created_at      timestamptz not null default now()
);
create table if not exists plants (
  id               uuid primary key default gen_random_uuid(),
  user_id          bigint not null references users(telegram_id) on delete cascade,
  nickname         text,
  species          text,
  common_name      text,
  location         text not null default 'indoor' check (location in ('indoor','covered','outdoor_pot','outdoor_ground')),
  photo_file_id    text,
  photo_path       text,
  care             jsonb not null default '{}'::jsonb,
  water_every_days numeric not null default 7,
  water_winter_days numeric,
  feed_every_days  int,
  cold_min_c       numeric,
  heat_sensitive   boolean not null default false,
  last_watered_at  timestamptz not null default now(),
  last_fed_at      timestamptz,
  snoozed_until    date,
  archived         boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists plants_user_idx on plants(user_id) where not archived;
create table if not exists events (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users(telegram_id) on delete cascade,
  plant_id    uuid references plants(id) on delete cascade,
  kind        text not null check (kind in ('water','feed','rain','diagnosis','note','photo')),
  note        text,
  photo_file_id text,
  created_at  timestamptz not null default now()
);
create index if not exists events_plant_idx on events(plant_id, created_at desc);
create index if not exists events_user_idx on events(user_id);
create table if not exists wishlist (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users(telegram_id) on delete cascade,
  name        text not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists wishlist_user_idx on wishlist(user_id);
create table if not exists sessions (
  user_id     bigint primary key references users(telegram_id) on delete cascade,
  state       text,
  data        jsonb not null default '{}'::jsonb,
  history     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);
create table if not exists processed_updates (
  update_id   bigint primary key,
  created_at  timestamptz not null default now()
);
alter table users              enable row level security;
alter table plants             enable row level security;
alter table events             enable row level security;
alter table wishlist           enable row level security;
alter table sessions           enable row level security;
alter table processed_updates  enable row level security;
insert into storage.buckets (id, name, public) values ('plants', 'plants', false) on conflict (id) do nothing;
