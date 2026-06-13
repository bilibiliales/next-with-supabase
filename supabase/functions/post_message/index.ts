import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { broadcastToRoom, withHandler } from "../_shared/http.ts";
import { withTransaction } from "../_shared/db.ts";
import { postMessage } from "../_shared/game.ts";

serve((req) =>
  withHandler(req, async ({ user, body }) => {
    const result = await withTransaction((tx) => postMessage(tx, user, body));
    await broadcastToRoom(result.room_id, result.message.channel, "message", result.message);
    return result;
  })
);
