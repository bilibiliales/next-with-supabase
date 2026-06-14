alter table public.game_events
drop constraint if exists game_events_event_type_check;

alter table public.game_events
add constraint game_events_event_type_check
check (
    event_type in (
        'game_started',
        'vote_resolved',
        'night_resolved',
        'phase_changed',
        'game_ended',
        'ai_action_submitted'
    )
);
