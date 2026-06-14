import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, corsHeaders, json } from "../_shared/http.ts";
import { getSql, tryWithGameLock } from "../_shared/db.ts";
import { advanceGame } from "../_shared/game.ts";

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

function sanitizeTickResult(result: Record<string, unknown>): Record<string, unknown> {
  const publicResult = { ...result };
  delete publicResult.ai_results;
  return publicResult;
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
      and (
        gs.phase = 'waiting'
        or gs.deadline_at <= now()
      )
    order by gs.deadline_at asc nulls last
    limit 100
  `;

  const results: Record<string, unknown>[] = [];

  for (const game of activeGames) {
    try {
      const result = await tryWithGameLock(game.id as string, async (tx) => {
        return await advanceGame(tx, game.id as string);
      });
      if (!result) {
        results.push({
          game_id: game.id,
          advanced: false,
          reason: "locked",
        });
        continue;
      }

      results.push(sanitizeTickResult(result));

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
