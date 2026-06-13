export type AuthUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") return {};

  const text = await req.text();
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON request body.");
  }
}

export async function requireUser(req: Request): Promise<AuthUser> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new HttpError(401, "Missing Authorization header.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new HttpError(500, "Supabase Edge Function environment is not configured.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      authorization: authHeader,
    },
  });

  if (!response.ok) {
    throw new HttpError(401, "Invalid or expired user session.");
  }

  const user = await response.json();
  if (!user?.id) throw new HttpError(401, "Invalid user session.");
  return user as AuthUser;
}

export function getString(input: Record<string, unknown>, key: string): string;
export function getString(input: Record<string, unknown>, key: string, required: false): string | null;
export function getString(input: Record<string, unknown>, key: string, required = true): string | null {
  const value = input[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) throw new HttpError(400, `Missing ${key}.`);
  return null;
}

export function getNumber(input: Record<string, unknown>, key: string, fallback?: number): number {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (fallback !== undefined) return fallback;
  throw new HttpError(400, `Missing ${key}.`);
}

export async function broadcastToRoom(
  roomId: string,
  channel: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return;

  const topic = `room:${roomId}:${channel}`;
  await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          topic,
          event,
          private: true,
          payload: {
            ...payload,
            channel,
          },
        },
      ],
    }),
  }).catch(() => {
    // Broadcast is best-effort; persistence remains the source available through reconnect.
  });
}

export async function withHandler(
  req: Request,
  handler: (context: { user: AuthUser; body: Record<string, unknown> }) => Promise<unknown>,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const [user, body] = await Promise.all([requireUser(req), readBody(req)]);
    const result = await handler({ user, body });
    return json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ ok: false, error: error.message, details: error.details }, error.status);
    }

    const message = error instanceof Error ? error.message : "Unexpected Edge Function error.";
    return json({ ok: false, error: message }, 500);
  }
}
