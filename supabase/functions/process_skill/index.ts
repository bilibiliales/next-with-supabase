import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, getString, withHandler } from "../_shared/http.ts";
import { withGameLock } from "../_shared/db.ts";
import { processSkill } from "../_shared/game.ts";

serve((req) =>
  withHandler(req, async ({ user, body }) => {
    const gameId = getString(body, "game_id");
    const result = await withGameLock(gameId, (tx) => processSkill(tx, user, body));

    await broadcastToRoom(result.snapshot.game.room_id, "system", "state", {
      type: "skill_submitted",
      game_id: result.snapshot.game.id,
      phase: result.snapshot.state.phase,
      round_no: result.snapshot.state.round_no,
      resolved: result.resolved,
    });

    return result;
  })
);
