create table if not exists public.game_ai_state (
    member_id uuid primary key references public.game_members(id) on delete cascade,
    game_id uuid not null references public.games(id) on delete cascade,
    phase text not null check (phase in ('night', 'day', 'vote', 'settlement')),
    round_no int not null check (round_no > 0),
    next_think_at timestamptz not null default now(),
    next_speak_at timestamptz,
    think_cooldown_until timestamptz,
    speak_cooldown_until timestamptz,
    action_cooldown_until timestamptz,
    hidden_target_seat_no int,
    strategy jsonb not null default '{}'::jsonb,
    last_observed_message_id bigint,
    updated_at timestamptz default now()
);

create index if not exists game_ai_state_game_due_idx
on public.game_ai_state(game_id, next_think_at);

alter table public.game_ai_state enable row level security;

drop policy if exists "game ai state deny direct access" on public.game_ai_state;
create policy "game ai state deny direct access"
on public.game_ai_state
for all
to authenticated
using (false)
with check (false);

drop policy if exists "game ai state service role access" on public.game_ai_state;
create policy "game ai state service role access"
on public.game_ai_state
for all
to service_role
using (true)
with check (true);
