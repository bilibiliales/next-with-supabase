import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { HttpError, broadcastToRoom, getString, withHandler } from "../_shared/http.ts";
import { withTransaction } from "../_shared/db.ts";
import { createRoom, joinRoom, leaveRoom, listRooms, resetRoom, roomSnapshot, setReady } from "../_shared/game.ts";

serve((req) =>
  withHandler(req, async ({ user, body }) => {
    const action = getString(body, "action");

    const result = await withTransaction(async (tx) => {
      if (action === "create_room") return await createRoom(tx, user, body);
      if (action === "join_room") return await joinRoom(tx, user, body);
      if (action === "leave_room") return await leaveRoom(tx, user, body);
      if (action === "set_ready") return await setReady(tx, user, body);
      if (action === "reset_room") return await resetRoom(tx, user, body);
      if (action === "list_rooms") return await listRooms(tx);
      if (action === "room_snapshot") return await roomSnapshot(tx, getString(body, "room_id"), user.id);
      throw new HttpError(400, `Unsupported room action: ${action}`);
    });

    const resultRecord = result as { room?: { id?: string } };
    const roomId = typeof body.room_id === "string" ? body.room_id : resultRecord.room?.id;
    if (roomId) {
      await broadcastToRoom(roomId, "lobby", "room", {
        type: action,
        room_id: roomId,
      });
    }

    return result;
  })
);
