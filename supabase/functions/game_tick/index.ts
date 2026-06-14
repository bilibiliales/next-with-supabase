import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, corsHeaders, json } from "../_shared/http.ts";
import { getSql, withGameLock } from "../_shared/db.ts";
import { advanceGame, isDeadlineReached, runPendingAiTurns } from "../_shared/game.ts";

function serviceAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cronSecret = Deno.env.get("GAME_TICK_SECRET") ?? Deno.env.get("CRON_SECRET");

  if (serviceRoleKey && bearer === serviceRoleKey) return true;
  if (cronSecret && req.headers.get("x-cron-secret") === cronSecret) return true;
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected game_tick error.";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!serviceAuthorized(req)) return json({ ok: false, error: "Unauthorized game tick request." }, 401);

  const sql = getSql();
  const activeGames = await sql`
    select g.id, gs.phase, gs.deadline_at
    from public.games g
    join public.game_state gs on gs.game_id = g.id
    where g.ended_at is null
      and gs.phase <> 'ended'
    order by gs.deadline_at asc nulls last
  `;

  const results: Record<string, unknown>[] = [];

  for (const game of activeGames) {
    try {
      const result: Record<string, unknown> = await withGameLock(game.id as string, async (tx) => {
        const ai = await runPendingAiTurns(tx, game.id as string);
        const stateRows = await tx`
          select gs.phase, gs.round_no, gs.deadline_at, gs.state_version, g.room_id, g.winner, g.ended_at
          from public.game_state gs
          join public.games g on g.id = gs.game_id
          where gs.game_id = ${game.id}
        `;
        const state = stateRows[0];
        if (!state || state.ended_at || state.phase === "ended") {
          return {
            game_id: game.id,
            advanced: false,
            reason: "inactive",
            ai_actions: ai.actions,
          };
        }

        if (!isDeadlineReached(state.deadline_at)) {
          return {
            game_id: game.id,
            room_id: state.room_id,
            phase: state.phase,
            round_no: state.round_no,
            deadline_at: state.deadline_at,
            advanced: false,
            reason: "deadline_not_reached",
            ai_actions: ai.actions,
          };
        }

        const transition = await advanceGame(tx, game.id as string);
        return {
          ...transition,
          ai_actions: ai.actions,
        };
      });

      results.push(result);

      if (result.advanced && typeof result.room_id === "string") {
        await broadcastToRoom(result.room_id, "system", "state", {
          type: "phase_changed",
          game_id: result.game_id,
          previous_phase: result.previous_phase,
          phase: result.phase,
          round_no: result.round_no,
          deadline_at: result.deadline_at,
          state_version: result.state_version,
          winner: result.winner,
        });

        if (result.ended) {
          await broadcastToRoom(result.room_id, "system", "state", {
            type: "game_ended",
            game_id: result.game_id,
            phase: result.phase,
            round_no: result.round_no,
            winner: result.winner,
          });
        }
      }
    } catch (error) {
      results.push({
        game_id: game.id,
        advanced: false,
        error: errorMessage(error),
      });
    }
  }

  return json({
    ok: true,
    data: {
      checked: activeGames.length,
      results,
    },
  });
});
