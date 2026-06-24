import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, corsHeaders, json } from "../_shared/http.ts";
import { getSql, tryWithGameLock } from "../_shared/db.ts";
import { advanceGame, type AdvanceGameResult } from "../_shared/game.ts";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      and gs.state_version is not null
      and (
        (
          gs.phase = 'waiting'
          and g.started_at is not null
          and g.started_at <= now() - interval '3 seconds'
        )
        or (
          gs.phase <> 'waiting'
          and gs.deadline_at <= now()
        )
        or (
          gs.phase in ('night', 'day', 'vote')
          and gs.deadline_at is not null
          and gs.deadline_at <= now() + interval '120 seconds'
        )
        or (
          gs.phase in ('night', 'day', 'vote', 'settlement')
          and gs.deadline_at is null
        )
      )
    order by coalesce(gs.deadline_at, g.started_at) asc nulls last
    limit 100
  `;

  const results: Record<string, unknown>[] = [];

  for (const game of activeGames) {
    try {
      let result: AdvanceGameResult | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        result = await tryWithGameLock(game.id as string, async (tx) => {
          return await advanceGame(tx, game.id as string);
        });
        if (result) break;
        await sleep(50);
      }

      if (!result) {
        results.push({
          game_id: game.id,
          advanced: false,
          reason: "locked",
        });
        continue;
      }

      results.push(sanitizeTickResult(result));

      for (const aiResult of result.ai_results) {
        const messages = [aiResult.private_message, aiResult.message];
        for (const message of messages) {
          if (message && typeof message === "object" && "channel" in message) {
            await broadcastToRoom(result.room_id, String((message as Record<string, unknown>).channel), "message", message as Record<string, unknown>);
          }
        }
      }

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
