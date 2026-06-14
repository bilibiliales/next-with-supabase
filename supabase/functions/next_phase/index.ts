import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, getString, withHandler } from "../_shared/http.ts";
import { withGameLock } from "../_shared/db.ts";
import { nextPhase } from "../_shared/game.ts";

serve((req) =>
  withHandler(req, async ({ user, body }) => {
    const gameId = getString(body, "game_id");
    const result = await withGameLock(gameId, (tx) => nextPhase(tx, user, body));

    await broadcastToRoom(result.game.room_id, "system", "state", {
      type: "phase_changed",
      game_id: result.game.id,
      phase: result.state.phase,
      round_no: result.state.round_no,
      deadline_at: result.state.deadline_at,
      winner: result.game.winner,
    });

    if (result.state.phase === "ended") {
      await broadcastToRoom(result.game.room_id, "system", "state", {
        type: "game_ended",
        game_id: result.game.id,
        phase: result.state.phase,
        round_no: result.state.round_no,
        winner: result.game.winner,
      });
    }

    return result;
  })
);
