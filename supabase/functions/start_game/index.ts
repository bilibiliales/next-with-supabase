import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, getString, withHandler } from "../_shared/http.ts";
import { withTransaction } from "../_shared/db.ts";
import { startGame } from "../_shared/game.ts";

serve((req) =>
  withHandler(req, async ({ user, body }) => {
    const roomId = getString(body, "room_id");
    const gameId = crypto.randomUUID();

    const result = await withTransaction(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${gameId}::text))`;
      await tx`select pg_advisory_xact_lock(hashtext(${roomId}::text))`;
      return await startGame(tx, user, { ...body, room_id: roomId, game_id: gameId });
    });

    await broadcastToRoom(result.game.room_id, "system", "state", {
      type: "game_started",
      game_id: result.game.id,
      phase: result.state.phase,
      round_no: result.state.round_no,
      deadline_at: result.state.deadline_at,
    });

    return result;
  })
);
