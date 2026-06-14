import postgres from "npm:postgres@3.4.5";

type SqlClient = ReturnType<typeof postgres>;
type TxClient = any;

let client: SqlClient | null = null;

export type SqlExecutor = SqlClient | TxClient;

export function getSql(): SqlClient {
  if (client) return client;

  const databaseUrl =
    Deno.env.get("SUPABASE_DB_URL") ??
    Deno.env.get("DATABASE_URL") ??
    Deno.env.get("POSTGRES_URL");

  if (!databaseUrl) {
    throw new Error("Missing SUPABASE_DB_URL, DATABASE_URL, or POSTGRES_URL for Edge Function transactions.");
  }

  client = postgres(databaseUrl, {
    max: 4,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: false,
  });

  return client;
}

export async function withTransaction<T>(work: (tx: TxClient) => Promise<T>): Promise<T> {
  return await getSql().begin(work);
}

export async function withGameLock<T>(gameId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return await withTransaction(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${gameId}::text))`;
    return await work(tx);
  });
}

export async function tryWithGameLock<T>(gameId: string, work: (tx: TxClient) => Promise<T>): Promise<T | null> {
  return await withTransaction(async (tx) => {
    const rows = await tx`select pg_try_advisory_xact_lock(hashtext(${gameId}::text)) as locked`;
    if (!rows[0]?.locked) return null;
    return await work(tx);
  });
}

export async function withRoomLock<T>(roomId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return await withTransaction(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${roomId}::text))`;
    return await work(tx);
  });
}
