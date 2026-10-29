-- VELKOS media · leaderboard with player accounts (name + 4-digit PIN)
-- • one entry per player, points add up every time the player saves
-- • the same name + PIN works on any device
-- • a player can rename, reset their points or delete their own account
-- • whoever is #1 earns a 2–5 % discount; requests land privately in discount_leads
-- Run this whole script once: Supabase → SQL Editor → New query → paste → Run.

create extension if not exists pgcrypto with schema extensions;

-- 1. Players (private table – the website reads it only through the view)
create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 18),
  pin_hash   text not null,
  score      int  not null default 0 check (score between 0 and 100000000),
  discount   int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists players_name_key on players (lower(name));
alter table players enable row level security;
revoke all on players from anon, authenticated;

create or replace view leaderboard as
  select id as player, name, score, updated_at from players where score > 0;
grant select on leaderboard to anon, authenticated;

-- helper: check name + PIN
create or replace function _player_check(p_player uuid, p_pin text)
returns players language plpgsql security definer set search_path = public, extensions as $$
declare p players;
begin
  select * into p from players where id = p_player;
  if not found then raise exception 'not_found'; end if;
  if p_pin is null or p.pin_hash <> crypt(p_pin, p.pin_hash) then raise exception 'wrong_pin'; end if;
  return p;
end $$;

-- 2. Create a new player
create or replace function create_player(p_name text, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare p players;
begin
  if p_name is null or char_length(trim(p_name)) not between 1 and 18 then raise exception 'bad_name'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'bad_pin'; end if;
  if exists (select 1 from players where lower(name) = lower(trim(p_name))) then raise exception 'name_taken'; end if;
  insert into players(name, pin_hash) values (trim(p_name), crypt(p_pin, gen_salt('bf'))) returning * into p;
  return json_build_object('player', p.id, 'name', p.name, 'score', p.score);
end $$;

-- 3. Log in as an existing player
create or replace function login_player(p_name text, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare p players;
begin
  select * into p from players where lower(name) = lower(trim(p_name));
  if not found then raise exception 'not_found'; end if;
  if p_pin is null or p.pin_hash <> crypt(p_pin, p.pin_hash) then raise exception 'wrong_pin'; end if;
  return json_build_object('player', p.id, 'name', p.name, 'score', p.score);
end $$;

-- 4. Add points to my account
create or replace function submit_score(p_player uuid, p_pin text, p_score int)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare p players; v_rank int;
begin
  if p_score is null or p_score not between 1 and 100000 then raise exception 'bad_score'; end if;
  p := _player_check(p_player, p_pin);
  update players set score = score + p_score, updated_at = now() where id = p_player returning * into p;
  select 1 + count(*) into v_rank from players where score > p.score;
  if v_rank = 1 then
    -- 2–5 %: grows with points, plus a little luck, never above 5
    update players
       set discount = greatest(coalesce(discount, 0),
                               least(5, 2 + floor(p.score / 5000.0)::int + (random() < 0.35)::int))
     where id = p_player returning * into p;
  end if;
  return json_build_object('best', p.score, 'rank', v_rank, 'discount', p.discount, 'name', p.name);
end $$;

-- 5. Rename / delete my account
create or replace function rename_player(p_player uuid, p_pin text, p_name text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_name is null or char_length(trim(p_name)) not between 1 and 18 then raise exception 'bad_name'; end if;
  perform _player_check(p_player, p_pin);
  if exists (select 1 from players where lower(name) = lower(trim(p_name)) and id <> p_player) then raise exception 'name_taken'; end if;
  update players set name = trim(p_name), updated_at = now() where id = p_player;
  return true;
end $$;

create or replace function delete_player(p_player uuid, p_pin text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _player_check(p_player, p_pin);
  delete from discount_leads where player = p_player;
  delete from players where id = p_player;
  return true;
end $$;

-- 5b. Reset my points to 0 (keeps the player)
create or replace function reset_score(p_player uuid, p_pin text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _player_check(p_player, p_pin);
  update players set score = 0, discount = null, updated_at = now() where id = p_player;
  return true;
end $$;
revoke all on function reset_score(uuid, text) from public;
grant execute on function reset_score(uuid, text) to anon, authenticated;

-- 6. Discount requests (private – see them in Table Editor → discount_leads)
create table if not exists discount_leads (
  id         bigint generated always as identity primary key,
  player     uuid,
  name       text,
  email      text not null,
  discount   int  not null,
  score      int,
  code       text not null,
  newsletter boolean not null default false,
  feedback   text,
  created_at timestamptz default now()
);
alter table discount_leads enable row level security;
revoke all on discount_leads from anon, authenticated;

create or replace function claim_discount(p_player uuid, p_pin text, p_email text,
                                          p_newsletter boolean, p_feedback text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare p players; v_code text;
begin
  p := _player_check(p_player, p_pin);
  if p.discount is null then raise exception 'no_discount'; end if;
  if p_email is null or char_length(p_email) > 200
     or p_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'bad_email';
  end if;
  select code into v_code from discount_leads
   where player = p_player and email = lower(p_email) and discount = p.discount limit 1;
  if v_code is null then
    v_code := 'DEMO' || p.discount || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    insert into discount_leads(player, name, email, discount, score, code, newsletter, feedback)
    values (p_player, p.name, lower(p_email), p.discount, p.score, v_code,
            coalesce(p_newsletter, false), left(nullif(trim(p_feedback), ''), 500));
  end if;
  return json_build_object('code', v_code, 'discount', p.discount);
end $$;

-- 7. Only these functions are callable from the website
revoke all on function _player_check(uuid, text)                          from public, anon, authenticated;
revoke all on function create_player(text, text)                          from public;
revoke all on function login_player(text, text)                           from public;
revoke all on function submit_score(uuid, text, int)                      from public;
revoke all on function rename_player(uuid, text, text)                    from public;
revoke all on function delete_player(uuid, text)                          from public;
revoke all on function claim_discount(uuid, text, text, boolean, text)    from public;
grant execute on function create_player(text, text)                       to anon, authenticated;
grant execute on function login_player(text, text)                        to anon, authenticated;
grant execute on function submit_score(uuid, text, int)                   to anon, authenticated;
grant execute on function rename_player(uuid, text, text)                 to anon, authenticated;
grant execute on function delete_player(uuid, text)                       to anon, authenticated;
grant execute on function claim_discount(uuid, text, text, boolean, text) to anon, authenticated;

-- 8. The old test table from the first version (with the duplicate entries) is no longer used
drop table if exists scores;
