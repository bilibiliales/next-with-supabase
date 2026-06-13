import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { withHandler } from "../_shared/http.ts";
import { withTransaction } from "../_shared/db.ts";
import { reconnect } from "../_shared/game.ts";

serve((req) =>
  withHandler(req, async ({ user, body }) => {
    return await withTransaction((tx) => reconnect(tx, user, body));
  })
);
