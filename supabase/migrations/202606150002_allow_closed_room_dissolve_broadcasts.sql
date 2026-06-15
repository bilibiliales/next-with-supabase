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
          and (
              rm.left_at is null
              or (r.status = 'CLOSED' and c.name = 'system')
          )
          and (
              (
                  c.game_id is null
                  and (
                      (c.name = 'lobby' and r.status = 'WAITING')
                      or (c.name = 'system' and r.status in ('WAITING', 'POST_GAME', 'CLOSED'))
                  )
              )
              or (
                  c.game_id is not null
                  and (
                      exists (
                          select 1
                          from public.games active_game
                          where active_game.id = c.game_id
                            and active_game.ended_at is null
                      )
                      or r.status = 'POST_GAME'
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
