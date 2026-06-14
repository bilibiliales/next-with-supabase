create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    nickname text not null,
    avatar_url text,
    created_at timestamptz default now()
);

create table if not exists public.rooms (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid references public.profiles(id),
    name text,
    visibility text default 'private' check (visibility in ('public', 'private')),
    invite_code text unique,
    password_hash text,
    max_players int not null default 8 check (max_players between 5 and 12),
    ai_count int not null default 0 check (ai_count >= 0),
    ai_mode text default 'fill' check (ai_mode in ('fill', 'fixed', 'none')),
    status text not null default 'WAITING' check (status in ('WAITING', 'LOCKED', 'POST_GAME', 'CLOSED')),
    created_at timestamptz default now()
);

create table if not exists public.room_members (
    room_id uuid references public.rooms(id) on delete cascade,
    user_id uuid references public.profiles(id) on delete cascade,
    is_ready boolean default false,
    joined_at timestamptz default now(),
    left_at timestamptz,
    primary key(room_id, user_id)
);

create unique index if not exists one_room_per_user
on public.room_members(user_id)
where left_at is null;

create table if not exists public.games (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.rooms(id) on delete cascade,
    started_at timestamptz,
    ended_at timestamptz,
    winner text check (winner is null or winner in ('wolves', 'villagers', 'draw'))
);

create unique index if not exists one_active_game_per_room
on public.games(room_id)
where ended_at is null;

create table if not exists public.channels (
    id uuid primary key default gen_random_uuid(),
    room_id uuid not null references public.rooms(id) on delete cascade,
    game_id uuid references public.games(id) on delete cascade,
    name text not null check (name in ('lobby', 'public', 'wolf', 'dead', 'system')),
    is_private boolean not null default true,
    created_at timestamptz default now(),
    check (
        (game_id is null and name in ('lobby', 'system'))
        or (game_id is not null and name in ('public', 'wolf', 'dead', 'system'))
    )
);

create unique index if not exists one_room_level_channel_name
on public.channels(room_id, name)
where game_id is null;

create unique index if not exists one_game_channel_name
on public.channels(game_id, name)
where game_id is not null;

create table if not exists public.game_members (
    id uuid primary key default gen_random_uuid(),
    game_id uuid not null references public.games(id) on delete cascade,
    seat_no int not null check (seat_no > 0),
    user_id uuid references public.profiles(id) on delete set null,
    is_ai boolean not null default false,
    created_at timestamptz default now(),
    check ((is_ai = true and user_id is null) or (is_ai = false and user_id is not null))
);

comment on table public.game_members is
'Immutable runtime identity. Seat mapping and AI/human identity live here; init-only profile data and mutable state are split out to avoid lifecycle drift.';

create unique index if not exists one_member_per_game_seat
on public.game_members(game_id, seat_no);

create index if not exists game_members_game_idx
on public.game_members(game_id);

create unique index if not exists one_human_member_per_game
on public.game_members(game_id, user_id)
where user_id is not null;

create table if not exists public.game_member_profiles (
    member_id uuid primary key references public.game_members(id) on delete cascade,
    role text not null check (role in ('wolf', 'villager', 'seer', 'witch', 'hunter')),
    ai_personality text check (ai_personality is null or ai_personality in ('aggressive', 'logical', 'chaotic', 'deceptive', 'silent')),
    ai_name text check (ai_name is null or char_length(ai_name) <= 50),
    created_at timestamptz default now()
);

comment on table public.game_member_profiles is
'Initialization-only member profile: role assignment, AI name, and server-only personality.';

comment on column public.game_member_profiles.ai_personality is
'SERVER ONLY - must never be sent to client or messages table';

create table if not exists public.game_member_state (
    member_id uuid primary key references public.game_members(id) on delete cascade,
    alive boolean not null default true,
    death_reason text check (death_reason is null or death_reason in ('wolf_kill', 'vote_out', 'witch_poison', 'hunter_shot')),
    death_round int check (death_round is null or death_round > 0),
    killed_by_member_id uuid references public.game_members(id) on delete set null,
    updated_at timestamptz default now(),
    check (
        (alive = true and death_reason is null and death_round is null and killed_by_member_id is null)
        or (alive = false and death_reason is not null and death_round is not null)
    )
);

comment on table public.game_member_state is
'Mutable per-member runtime state. Edge Functions update this table during settlement/resolution.';

create index if not exists game_member_state_alive_idx
on public.game_member_state(alive);

create table if not exists public.game_state (
    game_id uuid primary key references public.games(id) on delete cascade,
    phase text not null check (phase in ('waiting', 'night', 'day', 'vote', 'settlement', 'ended')),
    round_no int default 1 check (round_no > 0),
    deadline_at timestamptz,
    state_version int not null default 0 check (state_version >= 0),
    updated_at timestamptz default now()
);

create table if not exists public.game_actions (
    id bigserial primary key,
    request_id uuid not null default gen_random_uuid(),
    game_id uuid not null references public.games(id) on delete cascade,
    actor_member_id uuid not null references public.game_members(id) on delete cascade,
    action_type text not null check (action_type in ('vote', 'wolf_kill', 'seer_check', 'witch_heal', 'witch_poison', 'speak', 'pass', 'abstain')),
    phase text not null check (phase in ('night', 'day', 'vote', 'settlement')),
    round_no int not null check (round_no > 0),
    target_seat_no int,
    payload jsonb not null default '{}'::jsonb,
    locked_at timestamptz,
    resolved_at timestamptz,
    created_at timestamptz default now()
);

create unique index if not exists one_action_request
on public.game_actions(request_id);

create unique index if not exists uq_action_phase_lock
on public.game_actions(game_id, actor_member_id, action_type, phase, round_no)
where resolved_at is null;

create unique index if not exists uq_ai_action_once_per_phase
on public.game_actions(game_id, actor_member_id, phase, round_no)
where resolved_at is null and payload @> '{"ai": true}'::jsonb;

create table if not exists public.game_events (
    id bigserial primary key,
    game_id uuid references public.games(id) on delete cascade,
    actor_member_id uuid references public.game_members(id) on delete set null,
    event_type text not null check (event_type in ('game_started', 'vote_resolved', 'night_resolved', 'phase_changed', 'game_ended', 'ai_action_submitted')),
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz default now()
);

comment on table public.game_events is
'Replay and post-game analysis only. Edge Functions must not derive live state from this table.';

create table if not exists public.messages (
    id bigserial primary key,
    room_id uuid references public.rooms(id) on delete cascade,
    game_id uuid references public.games(id) on delete cascade,
    channel_id uuid not null references public.channels(id) on delete restrict,
    sender_id uuid references public.profiles(id) on delete set null,
    sender_member_id uuid references public.game_members(id) on delete set null,
    seat_no int,
    content text not null check (char_length(content) <= 2000),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz default now()
);

create index if not exists messages_room_created_at_idx
on public.messages(room_id, created_at desc);

create index if not exists messages_channel_created_at_idx
on public.messages(channel_id, created_at desc);

create table if not exists public.game_results (
    id bigserial primary key,
    game_id uuid references public.games(id) on delete cascade,
    member_id uuid references public.game_members(id) on delete set null,
    seat_no int not null,
    is_ai boolean not null default false,
    role text check (role is null or role in ('wolf', 'villager', 'seer', 'witch', 'hunter')),
    winner text check (winner in ('wolves', 'villagers', 'draw')),
    snapshot jsonb not null check (
        jsonb_typeof(snapshot) = 'object'
        and snapshot ? 'seat'
        and snapshot ? 'display_name'
        and snapshot ? 'user_id'
        and snapshot ? 'is_ai'
        and snapshot ? 'role'
        and snapshot ? 'death_reason'
        and snapshot ? 'death_round'
    ),
    duration_seconds int,
    created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.games enable row level security;
alter table public.channels enable row level security;
alter table public.game_members enable row level security;
alter table public.game_member_profiles enable row level security;
alter table public.game_member_state enable row level security;
alter table public.game_state enable row level security;
alter table public.game_actions enable row level security;
alter table public.game_events enable row level security;
alter table public.messages enable row level security;
alter table public.game_results enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "rooms deny direct access" on public.rooms;
create policy "rooms deny direct access"
on public.rooms
for all
to authenticated
using (false)
with check (false);

drop policy if exists "room members deny direct access" on public.room_members;
create policy "room members deny direct access"
on public.room_members
for all
to authenticated
using (false)
with check (false);

drop policy if exists "games deny direct access" on public.games;
create policy "games deny direct access"
on public.games
for all
to authenticated
using (false)
with check (false);

drop policy if exists "channels deny direct access" on public.channels;
create policy "channels deny direct access"
on public.channels
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game members deny direct access" on public.game_members;
create policy "game members deny direct access"
on public.game_members
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game member profiles deny direct access" on public.game_member_profiles;
create policy "game member profiles deny direct access"
on public.game_member_profiles
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game member state deny direct access" on public.game_member_state;
create policy "game member state deny direct access"
on public.game_member_state
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game state deny direct access" on public.game_state;
create policy "game state deny direct access"
on public.game_state
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game actions deny direct access" on public.game_actions;
create policy "game actions deny direct access"
on public.game_actions
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game events deny direct access" on public.game_events;
create policy "game events deny direct access"
on public.game_events
for all
to authenticated
using (false)
with check (false);

drop policy if exists "messages deny direct access" on public.messages;
create policy "messages deny direct access"
on public.messages
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game results deny direct access" on public.game_results;
create policy "game results deny direct access"
on public.game_results
for all
to authenticated
using (false)
with check (false);

do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'profiles',
        'rooms',
        'room_members',
        'games',
        'channels',
        'game_members',
        'game_member_profiles',
        'game_member_state',
        'game_state',
        'game_actions',
        'game_events',
        'messages',
        'game_results'
    ]
    loop
        execute format('drop policy if exists "%s service role access" on public.%I', table_name, table_name);
        execute format(
            'create policy "%s service role access" on public.%I for all to service_role using (true) with check (true)',
            table_name,
            table_name
        );
    end loop;
end $$;

create or replace function public.can_access_realtime_topic(topic text)
returns boolean
language sql
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.channels c
        join public.rooms r on r.id = c.room_id
        join public.room_members rm on rm.room_id = c.room_id
        where topic = ('room:' || c.room_id::text || ':' || c.name)
          and rm.user_id = auth.uid()
          and rm.left_at is null
          and (
              (
                  c.game_id is null
                  and c.name in ('lobby', 'system')
                  and r.status = 'WAITING'
              )
              or (
                  c.game_id is not null
                  and exists (
                      select 1
                      from public.games active_game
                      where active_game.id = c.game_id
                        and active_game.ended_at is null
                  )
                  and (
                      c.name in ('public', 'system')
                      or (
                          c.name = 'wolf'
                          and exists (
                              select 1
                              from public.game_members gm
                              join public.game_member_profiles gmp on gmp.member_id = gm.id
                              join public.game_member_state gms on gms.member_id = gm.id
                              where gm.game_id = c.game_id
                                and gm.user_id = auth.uid()
                                and gmp.role = 'wolf'
                                and gms.alive = true
                          )
                      )
                      or (
                          c.name = 'dead'
                          and exists (
                              select 1
                              from public.game_members gm
                              join public.game_member_state gms on gms.member_id = gm.id
                              where gm.game_id = c.game_id
                                and gm.user_id = auth.uid()
                                and gms.alive = false
                          )
                      )
                  )
              )
          )
    );
$$;

revoke all on function public.can_access_realtime_topic(text) from public;
grant execute on function public.can_access_realtime_topic(text) to authenticated;

do $$
begin
    if exists (
        select 1
        from information_schema.tables
        where table_schema = 'realtime'
          and table_name = 'messages'
    ) then
        execute 'alter table realtime.messages enable row level security';
        execute 'drop policy if exists "room members can receive private broadcasts" on realtime.messages';
        execute $policy$
            create policy "room members can receive private broadcasts"
            on realtime.messages
            for select
            to authenticated
            using (public.can_access_realtime_topic(realtime.topic()))
        $policy$;
    end if;
end $$;
