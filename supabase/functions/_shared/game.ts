import { HttpError, type AuthUser } from "./http.ts";
import type { SqlExecutor } from "./db.ts";
import { requestAiJsonObjectWithDiagnostics, type AiChatMessage } from "./ai_provider.ts";

type Phase = "waiting" | "night" | "day" | "vote" | "settlement" | "ended";
type Channel = "lobby" | "public" | "wolf" | "dead" | "system";
type ConversationBehavior = "reply" | "challenge" | "defend" | "agree" | "question" | "build_coalition" | "stay_silent";
type AiDecision = {
  action: "speak" | "vote" | "skill" | "pass" | "observe" | ConversationBehavior;
  target?: number | null;
  content?: string;
  private_content?: string;
  channel?: Channel;
  skill?: string;
  behavior?: ConversationBehavior;
  delay_ms?: number;
  priority?: number;
  reasoning_state?: string;
  suspicion_map?: Record<string, number>;
  next_think_at?: string;
  next_speak_at?: string | null;
  cooldowns?: Record<string, string | null>;
  source?: "external_ai" | "baseline_ai" | "rules_default";
  provider_error?: string;
  provider_error_detail?: string;
};
export type AdvanceGameResult = {
  game_id: string;
  room_id: string;
  previous_phase: Phase;
  phase: Phase;
  round_no: number;
  deadline_at: string | null;
  state_version: number;
  ai_actions: number;
  ai_results: Record<string, unknown>[];
  advanced: boolean;
  ended: boolean;
  winner: string | null;
  reason?: string;
};

type AdvanceGameOptions = {
  force?: boolean;
  runAi?: boolean;
};

type RunAiTurnsOptions = {
  force?: boolean;
  maxActions?: number;
  useExternal?: boolean;
  forceSpeak?: boolean;
};

type PhaseTransition = {
  phase: Phase;
  roundNo: number;
  winner: string | null;
  shouldAdvance: boolean;
  reason?: string;
};

const AI_PERSONALITIES = ["aggressive", "logical", "chaotic", "deceptive", "silent"] as const;
const AI_NAMES = ["Ash", "Blake", "Chen", "Devon", "Eli", "Finley", "Gray", "Hayes"];
const DAY_SPEECH_ACTIONS = new Set(["speak", "reply", "challenge", "defend", "agree", "question", "build_coalition"]);
const AI_RUNTIME_STATE_COLUMNS = [
  "member_id",
  "game_id",
  "phase",
  "round_no",
  "next_think_at",
  "next_speak_at",
  "think_cooldown_until",
  "speak_cooldown_until",
  "action_cooldown_until",
  "hidden_target_seat_no",
  "strategy",
  "last_observed_message_id",
] as const;

const PHASE_SECONDS: Record<Exclude<Phase, "waiting" | "ended">, number> = {
  night: 60,
  day: 90,
  vote: 45,
  settlement: 15,
};

const PHASE_ORDER: Record<Phase, Phase> = {
  waiting: "night",
  night: "day",
  day: "vote",
  vote: "settlement",
  settlement: "night",
  ended: "ended",
};

export function deadlineFor(phase: Exclude<Phase, "waiting" | "ended">): string {
  return new Date(Date.now() + PHASE_SECONDS[phase] * 1000).toISOString();
}

function isDeadlineReached(deadlineAt: string | null): boolean {
  if (!deadlineAt) return false;
  return Date.now() >= new Date(deadlineAt).getTime();
}

function nicknameFromUser(user: AuthUser): string {
  const metadataName = user.user_metadata?.nickname ?? user.user_metadata?.name ?? user.user_metadata?.full_name;
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim().slice(0, 40);
  if (user.email) return user.email.split("@")[0].slice(0, 40);
  return `Player ${user.id.slice(0, 6)}`;
}

function inviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function roleDeck(playerCount: number): string[] {
  const wolves = Math.max(1, Math.floor(playerCount / 3));
  const deck = Array.from({ length: wolves }, () => "wolf");

  if (playerCount >= 5) deck.push("seer");
  if (playerCount >= 6) deck.push("witch");
  if (playerCount >= 7) deck.push("hunter");

  while (deck.length < playerCount) deck.push("villager");
  return shuffle(deck);
}

function assertUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F-]{36}$/.test(value)) {
    throw new HttpError(400, `Invalid ${name}.`);
  }
  return value;
}

function requestIdFrom(input: Record<string, unknown>): string {
  if (typeof input.request_id === "string" && input.request_id.trim()) {
    return assertUuid(input.request_id.trim(), "request_id");
  }
  return crypto.randomUUID();
}

function sanitizeMessage(row: Record<string, unknown>) {
  return {
    id: row.id,
    game_id: row.game_id,
    channel: row.channel,
    seat_no: row.seat_no,
    content: row.content,
    created_at: row.created_at,
  };
}

export async function ensureProfile(sql: SqlExecutor, user: AuthUser) {
  await sql`
    insert into public.profiles (id, nickname, avatar_url)
    values (
      ${user.id},
      ${nicknameFromUser(user)},
      ${typeof user.user_metadata?.avatar_url === "string" ? user.user_metadata.avatar_url : null}
    )
    on conflict (id) do nothing
  `;
}

async function ensureChannel(
  sql: SqlExecutor,
  roomId: string,
  gameId: string | null,
  name: Channel,
): Promise<string> {
  const channelGameId = name === "lobby" ? null : gameId;
  const rows = channelGameId === null
    ? await sql`
        insert into public.channels (room_id, game_id, name)
        values (${roomId}, null, ${name})
        on conflict (room_id, name) where game_id is null
        do update set name = excluded.name
        returning id
      `
    : await sql`
        insert into public.channels (room_id, game_id, name)
        values (${roomId}, ${channelGameId}, ${name})
        on conflict (game_id, name) where game_id is not null
        do update set name = excluded.name
        returning id
      `;
  return rows[0].id as string;
}

async function ensureRoomChannels(sql: SqlExecutor, roomId: string, gameId: string | null) {
  const names = gameId
    ? ["public", "wolf", "dead", "system"]
    : ["lobby", "system"];
  for (const name of names as Channel[]) {
    await ensureChannel(sql, roomId, gameId, name);
  }
}

export async function createRoom(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  await ensureProfile(sql, user);

  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim().slice(0, 80)
    : `${nicknameFromUser(user)}'s Room`;
  const maxPlayers = Math.min(12, Math.max(5, Number(input.max_players ?? 8)));
  const aiCount = Math.max(0, Math.min(maxPlayers - 1, Number(input.ai_count ?? 0)));
  const aiMode = input.ai_mode === "fixed" || input.ai_mode === "none" ? input.ai_mode : "fill";
  const visibility = input.visibility === "public" ? "public" : "private";

  const rooms = await sql`
    insert into public.rooms (owner_id, name, visibility, invite_code, max_players, ai_count, ai_mode, status)
    values (${user.id}, ${name}, ${visibility}, ${inviteCode()}, ${maxPlayers}, ${aiCount}, ${aiMode}, 'WAITING')
    returning *
  `;

  const room = rooms[0];
  await ensureRoomChannels(sql, room.id, null);

  await sql`
    insert into public.room_members (room_id, user_id, is_ready, post_game_ready)
    values (${room.id}, ${user.id}, true, false)
  `;

  return await roomSnapshot(sql, room.id, user.id);
}

export async function joinRoom(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  await ensureProfile(sql, user);
  const roomId = typeof input.room_id === "string" && input.room_id.trim() ? input.room_id.trim() : null;
  const invite = typeof input.invite_code === "string" && input.invite_code.trim()
    ? input.invite_code.trim().toUpperCase()
    : null;

  if (!roomId && !invite) throw new HttpError(400, "Missing room_id or invite_code.");

  const rooms = roomId
    ? await sql`select * from public.rooms where id = ${assertUuid(roomId, "room_id")}`
    : await sql`select * from public.rooms where invite_code = ${invite}`;

  const room = rooms[0];
  if (!room) throw new HttpError(404, "Room not found.");
  if (room.status !== "WAITING") throw new HttpError(409, "Room is locked.");

  const activeMembers = await sql`
    select count(*)::int as count
    from public.room_members
    where room_id = ${room.id}
      and left_at is null
  `;

  if (activeMembers[0].count >= room.max_players) throw new HttpError(409, "Room is full.");

  await sql`
    insert into public.room_members (room_id, user_id, is_ready, post_game_ready, left_at)
    values (${room.id}, ${user.id}, false, false, null)
    on conflict (room_id, user_id)
    do update set is_ready = false,
                  post_game_ready = false,
                  left_at = null,
                  joined_at = now()
  `;

  return await roomSnapshot(sql, room.id, user.id);
}

export async function setReady(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");
  const ready = Boolean(input.is_ready);

  const updated = await sql`
    update public.room_members
    set is_ready = ${ready}
    where room_id = ${roomId}
      and user_id = ${user.id}
      and left_at is null
    returning room_id
  `;

  if (!updated[0]) throw new HttpError(404, "Active room membership not found.");
  return await roomSnapshot(sql, roomId, user.id);
}

export async function setPostGameReady(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");
  const ready = input.post_game_ready === false ? false : true;

  const roomRows = await sql`
    select status
    from public.rooms
    where id = ${roomId}
  `;
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "Room not found.");
  if (room.status !== "POST_GAME") throw new HttpError(409, "Post-game readiness is only available after a game ends.");

  const updated = await sql`
    update public.room_members
    set post_game_ready = ${ready}
    where room_id = ${roomId}
      and user_id = ${user.id}
      and left_at is null
    returning room_id
  `;

  if (!updated[0]) throw new HttpError(404, "Active room membership not found.");
  return await latestPostGameSnapshot(sql, roomId, user.id);
}

export async function resetRoom(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");
  const force = input.force === true;

  const roomRows = await sql`
    select *
    from public.rooms
    where id = ${roomId}
    for update
  `;
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "Room not found.");
  if (room.owner_id !== user.id) throw new HttpError(403, "Only the room owner can reset the room.");
  if (room.status !== "POST_GAME") throw new HttpError(409, "Only post-game rooms can be reset.");

  const ready = await postGameReadySummary(sql, roomId, user.id);
  if (!force && !ready.all_ready) {
    throw new HttpError(409, "Not all active room members have finished reviewing.");
  }

  const activeGames = await sql`
    select 1
    from public.games
    where room_id = ${roomId}
      and ended_at is null
    limit 1
  `;
  if (activeGames[0]) throw new HttpError(409, "Cannot reset while a game is still active.");

  await sql`
    update public.room_members
    set is_ready = (user_id = ${room.owner_id}),
        post_game_ready = false
    where room_id = ${roomId}
      and left_at is null
  `;

  await sql`
    update public.rooms
    set status = 'WAITING'
    where id = ${roomId}
  `;

  await ensureRoomChannels(sql, roomId, null);
  return await roomSnapshot(sql, roomId, user.id);
}

export async function leaveRoom(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");

  const rooms = await sql`
    select *
    from public.rooms
    where id = ${roomId}
    for update
  `;
  const room = rooms[0];
  if (!room) throw new HttpError(404, "Room not found.");
  if (room.status === "LOCKED") throw new HttpError(409, "Cannot leave while the room is locked.");

  const membership = await sql`
    select 1
    from public.room_members
    where room_id = ${roomId}
      and user_id = ${user.id}
      and left_at is null
  `;
  if (!membership[0]) throw new HttpError(404, "Active room membership not found.");

  if (room.owner_id === user.id) {
    await sql`
      update public.room_members
      set is_ready = false,
          post_game_ready = false,
          left_at = coalesce(left_at, now())
      where room_id = ${roomId}
        and left_at is null
    `;

    await sql`
      update public.rooms
      set status = 'CLOSED'
      where id = ${roomId}
    `;

    return { room_id: roomId, left: true, dissolved: true };
  }

  await sql`
    update public.room_members
    set is_ready = false,
        post_game_ready = false,
        left_at = now()
    where room_id = ${roomId}
      and user_id = ${user.id}
      and left_at is null
  `;

  return { room_id: roomId, left: true, dissolved: false };
}

export async function listRooms(sql: SqlExecutor) {
  const rows = await sql`
    select r.id, r.name, r.visibility, r.invite_code, r.max_players, r.ai_count, r.ai_mode, r.status, r.created_at,
      count(rm.user_id)::int as human_count
    from public.rooms r
    left join public.room_members rm on rm.room_id = r.id and rm.left_at is null
    where r.visibility = 'public'
      and r.status = 'WAITING'
    group by r.id
    order by r.created_at desc
    limit 20
  `;
  return { rooms: rows };
}

export async function roomSnapshot(sql: SqlExecutor, roomId: string, userId: string) {
  const roomRows = await sql`
    select *
    from public.rooms
    where id = ${roomId}
  `;
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "Room not found.");

  const membership = await sql`
    select 1
    from public.room_members
    where room_id = ${roomId}
      and user_id = ${userId}
      and left_at is null
  `;
  if (!membership[0] && room.owner_id !== userId) throw new HttpError(403, "You are not in this room.");

  const members = await sql`
    select rm.user_id, rm.is_ready, rm.post_game_ready, rm.joined_at, p.nickname
    from public.room_members rm
    join public.profiles p on p.id = rm.user_id
    where rm.room_id = ${roomId}
      and rm.left_at is null
    order by rm.joined_at asc
  `;

  const games = await sql`
    select g.id, gs.phase, gs.round_no, gs.deadline_at, g.winner, g.started_at, g.ended_at
    from public.games g
    left join public.game_state gs on gs.game_id = g.id
    where g.room_id = ${roomId}
    order by g.started_at desc nulls last
    limit 1
  `;

  return {
    room,
    members,
    latest_game: games[0] ?? null,
    post_game_ready: await postGameReadySummary(sql, roomId, userId),
  };
}

async function postGameReadySummary(sql: SqlExecutor, roomId: string, userId: string) {
  const rows = await sql`
    select
      count(*)::int as active_count,
      count(*) filter (where post_game_ready = true)::int as ready_count,
      coalesce(bool_or(user_id = ${userId}::uuid and post_game_ready = true), false) as self_ready
    from public.room_members
    where room_id = ${roomId}
      and left_at is null
  `;
  const row = rows[0] ?? {};
  const activeCount = Number(row.active_count ?? 0);
  const readyCount = Number(row.ready_count ?? 0);

  return {
    active_count: activeCount,
    ready_count: readyCount,
    self_ready: Boolean(row.self_ready),
    all_ready: activeCount > 0 && readyCount >= activeCount,
  };
}

async function latestPostGameSnapshot(sql: SqlExecutor, roomId: string, userId: string) {
  const games = await sql`
    select id
    from public.games
    where room_id = ${roomId}
    order by started_at desc nulls last
    limit 1
  `;

  if (games[0]) return await getPlayerView(sql, games[0].id, userId);
  return await roomSnapshot(sql, roomId, userId);
}

export async function startGame(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");
  await ensureProfile(sql, user);

  const roomRows = await sql`
    select *
    from public.rooms
    where id = ${roomId}
    for update
  `;
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "Room not found.");
  if (room.owner_id !== user.id) throw new HttpError(403, "Only the room owner can start the game.");
  if (room.status !== "WAITING") throw new HttpError(409, "Room is not waiting.");

  const humans = await sql`
    select rm.user_id, rm.is_ready, p.nickname
    from public.room_members rm
    join public.profiles p on p.id = rm.user_id
    where rm.room_id = ${roomId}
      and rm.left_at is null
    order by rm.joined_at asc
  `;
  if (humans.some((human: Record<string, unknown>) => human.is_ready !== true)) {
    throw new HttpError(409, "All human players must be ready before the game can start.");
  }

  const vacantSeats = Math.max(0, room.max_players - humans.length);
  const aiCount = room.ai_mode === "none"
    ? 0
    : room.ai_mode === "fixed"
      ? Math.min(vacantSeats, room.ai_count)
      : vacantSeats;
  const totalPlayers = humans.length + aiCount;

  if (totalPlayers < 5) {
    throw new HttpError(409, "A game needs at least 5 total players after AI fill.");
  }

  const gameId = typeof input.game_id === "string"
    ? assertUuid(input.game_id, "game_id")
    : crypto.randomUUID();
  const seatEntries = shuffle([
    ...humans.map((human: Record<string, unknown>) => ({
      user_id: human.user_id as string,
      is_ai: false,
      ai_personality: null,
      ai_name: null,
    })),
    ...Array.from({ length: aiCount }, (_, index) => ({
      user_id: null,
      is_ai: true,
      ai_personality: AI_PERSONALITIES[index % AI_PERSONALITIES.length],
      ai_name: AI_NAMES[index % AI_NAMES.length],
    })),
  ]);
  const roles = roleDeck(totalPlayers);

  await sql`
    insert into public.games (id, room_id, started_at)
    values (${gameId}, ${roomId}, now())
  `;

  await sql`
    update public.rooms
    set status = 'LOCKED'
    where id = ${roomId}
  `;

  await sql`
    update public.room_members
    set post_game_ready = false
    where room_id = ${roomId}
      and left_at is null
  `;

  await sql`
    insert into public.game_state (game_id, phase, round_no, deadline_at, updated_at)
    values (${gameId}, 'night', 1, ${deadlineFor("night")}, now())
  `;

  await ensureRoomChannels(sql, roomId, gameId);

  for (let index = 0; index < seatEntries.length; index += 1) {
    const seatNo = index + 1;
    const entry = seatEntries[index];
    const members = await sql`
      insert into public.game_members (game_id, seat_no, user_id, is_ai)
      values (${gameId}, ${seatNo}, ${entry.user_id}, ${entry.is_ai})
      returning id
    `;
    const memberId = members[0].id;
    await sql`
      insert into public.game_member_profiles (member_id, role, ai_personality, ai_name)
      values (${memberId}, ${roles[index]}, ${entry.ai_personality}, ${entry.ai_name})
    `;
    await sql`
      insert into public.game_member_state (member_id, alive)
      values (${memberId}, true)
    `;
  }

  if (await hasAiRuntimeStateTable(sql)) {
    const stateRows = await sql`select * from public.game_state where game_id = ${gameId}`;
    if (stateRows[0]) await ensureAiRuntimeState(sql, gameId, stateRows[0]);
  }

  await recordEvent(sql, gameId, null, "game_started", { room_id: roomId, player_count: totalPlayers });
  await insertSystemMessage(sql, roomId, gameId, "Game started.");
  await insertSystemMessage(sql, roomId, gameId, "Phase changed: night / round 1.");

  return await gameSnapshot(sql, gameId, user.id);
}

export async function getPlayerView(sql: SqlExecutor, gameId: string, userId: string) {
  const gameRows = await sql`
    select g.*, r.status as room_status, r.owner_id as room_owner_id
    from public.games g
    join public.rooms r on r.id = g.room_id
    where g.id = ${gameId}
  `;
  const game = gameRows[0];
  if (!game) throw new HttpError(404, "Game not found.");

  const stateRows = await sql`select * from public.game_state where game_id = ${gameId}`;
  const state = stateRows[0];
  if (!state) throw new HttpError(404, "Game state not found.");

  const selfRows = await sql`
    select gm.*, gmp.role, gms.alive
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gm.user_id = ${userId}
  `;
  const self = selfRows[0];
  if (!self) throw new HttpError(403, "You are not a member of this game.");

  const seats = await sql`
    select gm.seat_no, gms.alive
    from public.game_members gm
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
    order by gm.seat_no asc
  `;

  const channels = visibleChannels(state.phase as Phase, self.role, Boolean(self.alive), game.room_status);

  const messages = await sql`
    select m.id, m.game_id, c.name as channel, m.seat_no, m.content, m.created_at
    from public.messages m
    join public.channels c on c.id = m.channel_id
    where m.room_id = ${game.room_id}
      and c.name = any(${channels})
      and (
        c.game_id = ${gameId}
        or (c.game_id is null and m.game_id is null)
      )
    order by m.created_at desc
    limit 50
  `;

  const postGame = state.phase === "ended" || game.room_status === "POST_GAME";
  const reveal = postGame
    ? await sql`
        select gm.seat_no, gm.user_id, gm.is_ai, gmp.role, gms.alive, gms.death_reason, gms.death_round, gms.killed_by_member_id, p.nickname
        from public.game_members gm
        join public.game_member_profiles gmp on gmp.member_id = gm.id
        join public.game_member_state gms on gms.member_id = gm.id
        left join public.profiles p on p.id = gm.user_id
        where gm.game_id = ${gameId}
        order by gm.seat_no asc
      `
    : null;
  const replayEvents = postGame
    ? await sql`
        select id, actor_member_id, event_type, payload, created_at
        from public.game_events
        where game_id = ${gameId}
        order by id asc
      `
    : null;

  return {
    game: {
      id: game.id,
      room_id: game.room_id,
      started_at: game.started_at,
      ended_at: game.ended_at,
      winner: game.winner,
    },
    room: {
      id: game.room_id,
      owner_id: game.room_owner_id,
      status: game.room_status,
    },
    state: {
      phase: state.phase,
      round_no: state.round_no,
      deadline_at: state.deadline_at,
      state_version: state.state_version,
      updated_at: state.updated_at,
    },
    self: {
      seat_no: self.seat_no,
      role: self.role,
      alive: self.alive,
    },
    seats,
    channels,
    messages: messages.reverse().map(sanitizeMessage),
    post_game: reveal,
    post_game_events: replayEvents,
    post_game_ready: postGame ? await postGameReadySummary(sql, game.room_id, userId) : null,
  };
}

export async function gameSnapshot(sql: SqlExecutor, gameId: string, userId: string) {
  return await getPlayerView(sql, gameId, userId);
}

function visibleChannels(phase: Phase, role: string, alive: boolean, roomStatus: string): Channel[] {
  const channels: Channel[] = ["system"];
  if (roomStatus === "WAITING") channels.push("lobby");
  if (phase === "day" || phase === "vote" || phase === "settlement" || phase === "ended") channels.push("public");
  if ((phase === "night" || phase === "day" || phase === "vote") && role === "wolf" && alive) channels.push("wolf");
  if (!alive) channels.push("dead");
  return channels;
}

export async function postMessage(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");
  const content = typeof input.content === "string" ? input.content.trim().slice(0, 2000) : "";
  const channel = typeof input.channel === "string" ? input.channel : "public";
  if (!content) throw new HttpError(400, "Message content is required.");
  if (!["lobby", "public", "wolf", "dead"].includes(channel)) throw new HttpError(400, "Invalid channel.");

  const roomRows = await sql`select * from public.rooms where id = ${roomId}`;
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "Room not found.");

  const membership = await sql`
    select 1
    from public.room_members
    where room_id = ${roomId}
      and user_id = ${user.id}
      and left_at is null
  `;
  if (!membership[0]) throw new HttpError(403, "You are not in this room.");

  const gameRows = await sql`
    select g.id, gs.phase
    from public.games g
    left join public.game_state gs on gs.game_id = g.id
    where g.room_id = ${roomId}
      and g.ended_at is null
    order by g.started_at desc nulls last
    limit 1
  `;
  const game = gameRows[0] ?? null;

  let member = null;
  if (game) {
    const members = await sql`
      select gm.*, gmp.role, gms.alive
      from public.game_members gm
      join public.game_member_profiles gmp on gmp.member_id = gm.id
      join public.game_member_state gms on gms.member_id = gm.id
      where gm.game_id = ${game.id}
        and gm.user_id = ${user.id}
    `;
    member = members[0] ?? null;
  }

  if (game && member?.alive === false) {
    throw new HttpError(403, "player_dead");
  }
  if (channel === "lobby" && room.status !== "WAITING") {
    throw new HttpError(409, "Lobby chat is closed while the game is active.");
  }
  if (channel === "public" && (!game || !["day", "vote", "settlement", "ended"].includes(game.phase))) {
    throw new HttpError(409, "Public chat is not available in this phase.");
  }
  if (channel === "wolf" && (!game || !["night", "day", "vote"].includes(game.phase) || member?.role !== "wolf" || !member?.alive)) {
    throw new HttpError(403, "Wolf channel is not available.");
  }
  if (channel === "dead" && (!game || member?.alive)) {
    throw new HttpError(403, "Dead channel is not available.");
  }

  const channelId = await ensureChannel(sql, roomId, game?.id ?? null, channel as Channel);
  const rows = await sql`
    insert into public.messages (room_id, game_id, channel_id, sender_id, sender_member_id, seat_no, content, metadata)
    values (${roomId}, ${game?.id ?? null}, ${channelId}, ${user.id}, ${member?.id ?? null}, ${member?.seat_no ?? null}, ${content}, ${sql.json({})})
    returning id, game_id, seat_no, content, created_at
  `;

  return { room_id: roomId, topic: `room:${roomId}:${channel}`, message: sanitizeMessage({ ...rows[0], channel }) };
}

export async function processVote(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const gameId = assertUuid(input.game_id, "game_id");
  const targetSeatNo = input.target_seat_no === null || input.target_seat_no === undefined
    ? null
    : Number(input.target_seat_no);

  const context = await actingContext(sql, gameId, user.id);
  if (context.state.phase !== "vote") throw new HttpError(409, "Votes are only accepted during the vote phase.");
  ensureBeforeGrace(context.state.deadline_at);
  if (!context.member.alive) throw new HttpError(403, "Dead players cannot vote.");

  if (targetSeatNo !== null) {
    const targets = await sql`
      select 1
      from public.game_members gm
      join public.game_member_state gms on gms.member_id = gm.id
      where gm.game_id = ${gameId}
        and gm.seat_no = ${targetSeatNo}
        and gms.alive = true
    `;
    if (!targets[0]) throw new HttpError(400, "Vote target is not alive.");
  }

  await upsertMemberAction(sql, gameId, context.member.id, "vote", "vote", context.state.round_no, targetSeatNo, {
    abstain: targetSeatNo === null,
  }, requestIdFrom(input));

  return {
    action: "vote",
    target: targetSeatNo,
    resolved: false,
    snapshot: await gameSnapshot(sql, gameId, user.id),
  };
}

export async function processSkill(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const gameId = assertUuid(input.game_id, "game_id");
  const skill = typeof input.skill === "string" ? input.skill : "";
  const targetSeatNo = input.target_seat_no === null || input.target_seat_no === undefined
    ? null
    : Number(input.target_seat_no);
  const context = await actingContext(sql, gameId, user.id);

  if (context.state.phase !== "night") throw new HttpError(409, "Skills are only accepted during the night phase.");
  ensureBeforeGrace(context.state.deadline_at);
  if (!context.member.alive) throw new HttpError(403, "Dead players cannot use skills.");

  const allowed = allowedSkill(context.member.role, skill);
  if (!allowed) throw new HttpError(403, "This role cannot use that skill.");

  if (targetSeatNo !== null) {
    const targets = await sql`
      select gmp.role, gms.alive
      from public.game_members gm
      join public.game_member_profiles gmp on gmp.member_id = gm.id
      join public.game_member_state gms on gms.member_id = gm.id
      where gm.game_id = ${gameId}
        and gm.seat_no = ${targetSeatNo}
    `;
    if (!targets[0] || !targets[0].alive) throw new HttpError(400, "Skill target is not alive.");
  }

  await upsertMemberAction(sql, gameId, context.member.id, skill, "night", context.state.round_no, targetSeatNo, {}, requestIdFrom(input));

  let privateResult = null;
  if (skill === "seer_check" && targetSeatNo !== null) {
    const targets = await sql`
      select gmp.role
      from public.game_members gm
      join public.game_member_profiles gmp on gmp.member_id = gm.id
      where gm.game_id = ${gameId}
        and gm.seat_no = ${targetSeatNo}
    `;
    privateResult = { target_seat_no: targetSeatNo, is_wolf: targets[0]?.role === "wolf" };
  }

  return {
    action: skill,
    target: targetSeatNo,
    private_result: privateResult,
    resolved: false,
    snapshot: await gameSnapshot(sql, gameId, user.id),
  };
}

export async function advanceGame(
  sql: SqlExecutor,
  gameId: string,
  options: AdvanceGameOptions = {},
): Promise<AdvanceGameResult> {
  const stateRows = await sql`
    select gs.*, g.room_id, g.winner, g.ended_at
    from public.game_state gs
    join public.games g on g.id = gs.game_id
    where gs.game_id = ${gameId}
    for update of gs, g
  `;
  const state = stateRows[0];
  if (!state) throw new HttpError(404, "Game state not found.");

  const previousPhase = state.phase as Phase;
  if (state.ended_at || previousPhase === "ended") {
    return {
      game_id: gameId,
      room_id: state.room_id,
      previous_phase: previousPhase,
      phase: previousPhase,
      round_no: state.round_no,
      deadline_at: state.deadline_at,
      state_version: state.state_version,
      ai_actions: 0,
      ai_results: [],
      advanced: false,
      ended: previousPhase === "ended",
      winner: state.winner ?? null,
      reason: "inactive",
    };
  }

  const waitingForDeadline = !options.force
    && previousPhase !== "waiting"
    && state.deadline_at !== null
    && !isDeadlineReached(state.deadline_at);
  let ai = { actions: 0, results: [] as Record<string, unknown>[] };

  if (options.runAi !== false && waitingForDeadline) {
    ai = await runPendingAiTurnsForState(sql, gameId, state);
  }

  if (waitingForDeadline) {
    return {
      game_id: gameId,
      room_id: state.room_id,
      previous_phase: previousPhase,
      phase: previousPhase,
      round_no: state.round_no,
      deadline_at: state.deadline_at,
      state_version: state.state_version,
      ai_actions: ai.actions,
      ai_results: ai.results,
      advanced: false,
      ended: false,
      winner: state.winner ?? null,
      reason: "deadline_not_reached",
    };
  }

  if (options.runAi !== false && (previousPhase === "night" || previousPhase === "vote")) {
    const requiredAi = await runPendingAiTurnsForState(sql, gameId, state, {
      force: true,
      maxActions: 1000,
    });
    ai = {
      actions: ai.actions + requiredAi.actions,
      results: [...ai.results, ...requiredAi.results],
    };
  }

  if (options.runAi !== false) {
    const defaultAi = await ensureDefaultAiRequiredActions(sql, gameId, state);
    ai = {
      actions: ai.actions + defaultAi.actions,
      results: [...ai.results, ...defaultAi.results],
    };
  }

  const transition = await resolvePhaseAndComputeTransition(sql, gameId, state);
  if (!transition.shouldAdvance) {
    return {
      game_id: gameId,
      room_id: state.room_id,
      previous_phase: previousPhase,
      phase: previousPhase,
      round_no: state.round_no,
      deadline_at: state.deadline_at,
      state_version: state.state_version,
      ai_actions: ai.actions,
      ai_results: ai.results,
      advanced: false,
      ended: false,
      winner: state.winner ?? null,
      reason: transition.reason ?? "not_ready",
    };
  }

  const updated = await setPhase(sql, gameId, transition.phase, transition.roundNo, state.state_version);
  if (!updated) {
    return {
      game_id: gameId,
      room_id: state.room_id,
      previous_phase: previousPhase,
      phase: previousPhase,
      round_no: state.round_no,
      deadline_at: state.deadline_at,
      state_version: state.state_version,
      ai_actions: ai.actions,
      ai_results: ai.results,
      advanced: false,
      ended: false,
      winner: state.winner ?? null,
      reason: "state_version_changed",
    };
  }
  if (options.runAi !== false) {
    const phaseStartAi = await runPendingAiTurnsForState(
      sql,
      gameId,
      updated,
      updated.phase === "day" ? { force: true, forceSpeak: true, maxActions: 2 } : {},
    );
    ai = {
      actions: ai.actions + phaseStartAi.actions,
      results: [...ai.results, ...phaseStartAi.results],
    };
  }

  return {
    game_id: gameId,
    room_id: state.room_id,
    previous_phase: previousPhase,
    phase: updated.phase as Phase,
    round_no: updated.round_no as number,
    deadline_at: updated.deadline_at as string | null,
    state_version: updated.state_version as number,
    ai_actions: ai.actions,
    ai_results: ai.results,
    advanced: true,
    ended: updated.phase === "ended",
    winner: transition.winner,
  };
}

async function resolvePhaseAndComputeTransition(
  sql: SqlExecutor,
  gameId: string,
  state: Record<string, unknown>,
): Promise<PhaseTransition> {
  const currentPhase = state.phase as Phase;
  const currentRound = state.round_no as number;

  if (currentPhase === "night") {
    await maybeResolveNight(sql, gameId, currentRound, true);
    const winner = await evaluateWinner(sql, gameId);
    return { phase: winner ? "ended" : "day", roundNo: currentRound, winner, shouldAdvance: true };
  }

  if (currentPhase === "day") {
    return { phase: "vote", roundNo: currentRound, winner: null, shouldAdvance: true };
  }

  if (currentPhase === "vote") {
    await maybeResolveVote(sql, gameId, currentRound, true);
    const winner = await evaluateWinner(sql, gameId);
    return { phase: winner ? "ended" : "settlement", roundNo: currentRound, winner, shouldAdvance: true };
  }

  if (currentPhase === "settlement") {
    const winner = await evaluateWinner(sql, gameId);
    return {
      phase: winner ? "ended" : "night",
      roundNo: winner ? currentRound : currentRound + 1,
      winner,
      shouldAdvance: true,
    };
  }

  if (currentPhase === "waiting") {
    const ready = await canAdvanceWaitingGame(sql, gameId);
    if (!ready.ok) {
      return {
        phase: "waiting",
        roundNo: currentRound,
        winner: null,
        shouldAdvance: false,
        reason: ready.reason,
      };
    }
    return { phase: "night", roundNo: currentRound, winner: null, shouldAdvance: true };
  }

  return { phase: PHASE_ORDER[currentPhase], roundNo: currentRound, winner: null, shouldAdvance: true };
}

async function canAdvanceWaitingGame(sql: SqlExecutor, gameId: string): Promise<{ ok: boolean; reason?: string }> {
  const rows = await sql`
    select
      g.started_at,
      r.status as room_status,
      count(gm.id)::int as member_count,
      count(gmp.member_id)::int as profile_count,
      count(gms.member_id)::int as state_count,
      count(rm.user_id) filter (
        where gm.user_id is not null
          and rm.left_at is null
          and rm.is_ready = false
      )::int as unready_humans
    from public.games g
    join public.rooms r on r.id = g.room_id
    left join public.game_members gm on gm.game_id = g.id
    left join public.game_member_profiles gmp on gmp.member_id = gm.id
    left join public.game_member_state gms on gms.member_id = gm.id
    left join public.room_members rm on rm.room_id = g.room_id and rm.user_id = gm.user_id
    where g.id = ${gameId}
    group by g.id, g.started_at, r.status
  `;
  const row = rows[0];
  if (!row) return { ok: false, reason: "game_not_found" };
  if (!row.started_at) return { ok: false, reason: "game_not_started" };
  if (row.room_status !== "LOCKED") return { ok: false, reason: "room_not_locked" };
  if (row.member_count < 5) return { ok: false, reason: "not_enough_players" };
  if (row.profile_count !== row.member_count || row.state_count !== row.member_count) {
    return { ok: false, reason: "partial_initialization" };
  }
  if (row.unready_humans > 0) return { ok: false, reason: "players_not_ready" };
  return { ok: true };
}

async function runPendingAiTurnsForState(
  sql: SqlExecutor,
  gameId: string,
  state: Record<string, unknown>,
  options: RunAiTurnsOptions = {},
) {
  if (!["night", "day", "vote"].includes(state.phase as string)) {
    return { actions: 0, results: [] as Record<string, unknown>[] };
  }

  const phase = state.phase as Phase;
  const hasRuntimeState = await hasAiRuntimeStateTable(sql);
  if (hasRuntimeState) await ensureAiRuntimeState(sql, gameId, state);
  const aiRows = await pendingAiRows(sql, gameId, state, false, hasRuntimeState);
  const readyRows = (options.force ? aiRows : aiRows.filter((ai) => isAiReadyForTurn(ai, state)))
    .sort((left, right) => new Date(String(left.next_think_at ?? 0)).getTime() - new Date(String(right.next_think_at ?? 0)).getTime());
  const maxActions = options.maxActions ?? (phase === "day" ? 8 : 12);
  const dueRows = readyRows.slice(0, maxActions);
  const results: Record<string, unknown>[] = [];
  for (const ai of dueRows) {
    try {
      const action = await decideAiAction(sql, gameId, ai, state, {
        useExternal: options.useExternal ?? false,
        forceSpeak: options.forceSpeak === true,
      });
      results.push(await applyAiTurn(sql, gameId, ai, state, action));
    } catch (error) {
      console.warn("AI turn failed; applying emergency fallback", {
        game_id: gameId,
        phase,
        round_no: state.round_no,
        seat_no: ai.seat_no,
        error: error instanceof Error ? error.message : "unknown",
      });
      try {
        const action = await emergencyAiDecision(sql, gameId, ai, state, error);
        results.push(await applyAiTurn(sql, gameId, ai, state, action));
      } catch (fallbackError) {
        console.warn("Emergency AI fallback failed", {
          game_id: gameId,
          phase,
          round_no: state.round_no,
          seat_no: ai.seat_no,
          error: fallbackError instanceof Error ? fallbackError.message : "unknown",
        });
        results.push({
          action: "none",
          target: null,
          content: "",
          actor_member_id: ai.id,
          seat_no: ai.seat_no,
          provider_error: "ai_turn_failed",
          provider_error_detail: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  }

  return { actions: results.filter((result) => result.action !== "none").length, results };
}

async function ensureDefaultAiRequiredActions(sql: SqlExecutor, gameId: string, state: Record<string, unknown>) {
  const phase = state.phase as Phase;
  if (phase !== "vote") {
    return { actions: 0, results: [] as Record<string, unknown>[] };
  }
  if (!isDeadlineReached(state.deadline_at as string | null)) {
    return { actions: 0, results: [] as Record<string, unknown>[] };
  }

  const roundNo = state.round_no as number;
  const aiRows = await sql`
    select gm.id, gm.seat_no, gmp.role
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gm.is_ai = true
      and gms.alive = true
      and not exists (
        select 1
        from public.game_actions ga
        where ga.game_id = ${gameId}
          and ga.actor_member_id = gm.id
          and ga.phase = ${phase}
          and ga.round_no = ${roundNo}
          and ga.resolved_at is null
          and ga.action_type <> 'speak'
      )
    order by gm.seat_no asc
  `;

  const results: Record<string, unknown>[] = [];
  for (const ai of aiRows) {
    const actorMemberId = ai.id as string;
    const actorSeatNo = ai.seat_no as number;
    const actionType = "vote";
    const requestId = await deterministicRequestId(["ai-default", gameId, actorMemberId, actionType, phase, roundNo]);
    const reasoningState = "Deadline reached before AI vote submission; defaulting to abstain.";
    const decision: AiDecision = {
      action: "vote",
      target: null,
      reasoning_state: reasoningState,
      cooldowns: { think: null, action: null },
    };

    await upsertMemberAction(sql, gameId, actorMemberId, actionType, phase, roundNo, null, {
      ai: true,
      defaulted: true,
      reasoning_state: reasoningState,
      suspicion_map: {},
      cooldowns: decision.cooldowns ?? {},
    }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: actionType,
      planned_action: "default",
      phase,
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: null,
      defaulted: true,
      reasoning_state: reasoningState,
      suspicion_map: {},
      cooldowns: decision.cooldowns ?? {},
    });
    await updateAiRuntimeAfterDecision(sql, gameId, actorMemberId, state, decision);

    results.push({
      action: actionType,
      target: null,
      content: "",
      actor_member_id: actorMemberId,
      seat_no: actorSeatNo,
      defaulted: true,
    });
  }

  return { actions: results.length, results };
}

async function hasAiRuntimeStateTable(sql: SqlExecutor): Promise<boolean> {
  const rows = await sql`
    select count(distinct column_name)::int as column_count
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_ai_state'
      and column_name = any(${AI_RUNTIME_STATE_COLUMNS})
  `;
  return Number(rows[0]?.column_count ?? 0) === AI_RUNTIME_STATE_COLUMNS.length;
}

function isAiReadyForTurn(ai: Record<string, unknown>, state: Record<string, unknown>): boolean {
  const phase = state.phase as string;
  const now = Date.now();
  const nextThink = typeof ai.next_think_at === "string" ? new Date(ai.next_think_at).getTime() : 0;
  const actionCooldown = typeof ai.action_cooldown_until === "string" ? new Date(ai.action_cooldown_until).getTime() : 0;
  if (Number.isFinite(actionCooldown) && actionCooldown > now) return false;
  if (phase === "day") return !Number.isFinite(nextThink) || nextThink <= now;
  if (ai.required_action_submitted === true) return false;
  if (Number.isFinite(nextThink) && nextThink <= now) return true;
  if (phase === "night" || phase === "vote") return isNearDeadline(state.deadline_at as string | null, 12000);
  return false;
}

function aiThinkDelayMs(memberId: string, phase: string, roundNo: number): number {
  const base = stableNumber(`${memberId}:${phase}:${roundNo}`, 300, phase === "day" ? 5000 : 3500);
  return base;
}

function aiSpeakDelayMs(memberId: string, roundNo: number): number {
  return stableNumber(`${memberId}:speak:${roundNo}`, 500, 5000);
}

function aiThinkCooldownMs(memberId: string, phase: string, roundNo: number): number {
  return stableNumber(`${memberId}:think-cooldown:${phase}:${roundNo}`, phase === "day" ? 2500 : 2200, phase === "day" ? 6000 : 5500);
}

function aiSpeakCooldownMs(memberId: string, roundNo: number): number {
  return stableNumber(`${memberId}:speak-cooldown:${roundNo}`, 4000, 8000);
}

function isoAfter(base: string | null | undefined, delayMs: number): string {
  const baseMs = base ? new Date(base).getTime() : Date.now();
  const safeBase = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(safeBase + delayMs).toISOString();
}

function isNearDeadline(deadlineAt: string | null, windowMs: number): boolean {
  if (!deadlineAt) return false;
  return new Date(deadlineAt).getTime() - Date.now() <= windowMs;
}

function stableNumber(input: string, min: number, max: number): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const range = Math.max(1, max - min + 1);
  return min + (Math.abs(hash) % range);
}

export async function nextPhase(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  if (Deno.env.get("ALLOW_MANUAL_PHASE_ADVANCE") !== "true") {
    throw new HttpError(403, "Manual phase advance is disabled.");
  }

  const gameId = assertUuid(input.game_id, "game_id");
  await requireRoomOwnerForGame(sql, gameId, user.id);
  await advanceGame(sql, gameId, { force: true });
  return await gameSnapshot(sql, gameId, user.id);
}

export async function timeoutHandler(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const gameId = assertUuid(input.game_id, "game_id");
  await actingContext(sql, gameId, user.id);

  return {
    applied: false,
    reason: "server_tick_authoritative",
    snapshot: await gameSnapshot(sql, gameId, user.id),
  };
}

export async function aiTurn(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  if (Deno.env.get("ALLOW_MANUAL_AI_TURN") !== "true") {
    throw new HttpError(403, "Manual AI turns are disabled.");
  }

  const gameId = assertUuid(input.game_id, "game_id");
  await actingContext(sql, gameId, user.id);

  const stateRows = await sql`select * from public.game_state where game_id = ${gameId}`;
  const state = stateRows[0];
  if (!state || state.phase === "ended") throw new HttpError(409, "No active AI turn is available.");
  if (!["night", "day", "vote"].includes(state.phase)) throw new HttpError(409, "No active AI turn is available in this phase.");
  ensureBeforeGrace(state.deadline_at);

  const aiRows = await pendingAiRows(sql, gameId, state, true);
  const result = aiRows[0]
    ? await applyAiTurn(sql, gameId, aiRows[0], state)
    : { action: "none", target: null, content: "" };

  return {
    ...result,
    snapshot: await gameSnapshot(sql, gameId, user.id),
  };
}

export async function reconnect(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  await ensureProfile(sql, user);
  const gameId = typeof input.game_id === "string" ? input.game_id : null;
  if (gameId) return await getPlayerView(sql, assertUuid(gameId, "game_id"), user.id);

  let roomId = typeof input.room_id === "string" ? input.room_id : null;
  if (!roomId) {
    const activeRoom = await sql`
      select room_id
      from public.room_members
      where user_id = ${user.id}
        and left_at is null
      order by joined_at desc
      limit 1
    `;
    roomId = activeRoom[0]?.room_id ?? null;
  }

  if (!roomId) return { room: null, latest_game: null };

  const safeRoomId = assertUuid(roomId, "room_id");
  const roomRows = await sql`
    select status
    from public.rooms
    where id = ${safeRoomId}
  `;
  const room = roomRows[0];
  if (!room) throw new HttpError(404, "Room not found.");

  const activeGame = await sql`
    select g.id
    from public.games g
    where g.room_id = ${safeRoomId}
      and g.ended_at is null
    order by g.started_at desc nulls last
    limit 1
  `;
  if (activeGame[0]) return await getPlayerView(sql, activeGame[0].id, user.id);
  if (room.status === "POST_GAME") {
    const latestGame = await sql`
      select id
      from public.games
      where room_id = ${safeRoomId}
      order by started_at desc nulls last
      limit 1
    `;
    if (latestGame[0]) return await getPlayerView(sql, latestGame[0].id, user.id);
  }

  return await roomSnapshot(sql, safeRoomId, user.id);
}

async function actingContext(sql: SqlExecutor, gameId: string, userId: string) {
  const rows = await sql`
    select gm.*, gmp.role, gms.alive, gs.phase, gs.round_no, gs.deadline_at, gs.state_version
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    join public.game_state gs on gs.game_id = gm.game_id
    where gm.game_id = ${gameId}
      and gm.user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) throw new HttpError(403, "You are not a member of this game.");
  return {
    member: row,
    state: {
      phase: row.phase as Phase,
      round_no: row.round_no as number,
      deadline_at: row.deadline_at as string | null,
      state_version: row.state_version as number,
    },
  };
}

async function requireRoomOwnerForGame(sql: SqlExecutor, gameId: string, userId: string) {
  const rows = await sql`
    select r.owner_id
    from public.games g
    join public.rooms r on r.id = g.room_id
    where g.id = ${gameId}
  `;
  if (!rows[0]) throw new HttpError(404, "Game not found.");
  if (rows[0].owner_id !== userId) throw new HttpError(403, "Only the room owner can manually advance phase.");
}

async function pendingAiRows(
  sql: SqlExecutor,
  gameId: string,
  state: Record<string, unknown>,
  single = false,
  hasRuntimeState?: boolean,
) {
  if (hasRuntimeState) return await pendingAiRowsWithRuntimeState(sql, gameId, state, single);
  return await pendingAiRowsWithoutRuntimeState(sql, gameId, state, single);
}

async function pendingAiRowsWithRuntimeState(
  sql: SqlExecutor,
  gameId: string,
  state: Record<string, unknown>,
  single: boolean,
) {
  const phase = state.phase as Phase;
  const roundNo = state.round_no as number;
  const limit = single ? 1 : 1000;
  return await sql`
    select gm.*, gmp.role, gmp.ai_personality, gmp.ai_name, gms.alive,
           gas.next_think_at,
           gas.next_speak_at,
           gas.think_cooldown_until,
           gas.speak_cooldown_until,
           gas.action_cooldown_until,
           gas.hidden_target_seat_no,
           gas.strategy,
           gas.last_observed_message_id,
           exists (
             select 1
             from public.game_actions ga
             where ga.game_id = ${gameId}
               and ga.actor_member_id = gm.id
               and ga.phase = ${phase}
               and ga.round_no = ${roundNo}
               and ga.action_type <> 'speak'
               and ga.resolved_at is null
           ) as required_action_submitted
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    join public.game_ai_state gas on gas.member_id = gm.id
    where gm.game_id = ${gameId}
      and gm.is_ai = true
      and gms.alive = true
      and gas.game_id = ${gameId}
      and gas.phase = ${phase}
      and gas.round_no = ${roundNo}
      and (
        ${phase} = 'day'
        or not exists (
          select 1
          from public.game_actions ga
          where ga.game_id = ${gameId}
            and ga.actor_member_id = gm.id
            and ga.phase = ${phase}
            and ga.round_no = ${roundNo}
            and ga.action_type <> 'speak'
            and ga.resolved_at is null
        )
      )
    order by gas.next_think_at asc nulls first, gm.seat_no asc
    limit ${limit}
  `;
}

async function pendingAiRowsWithoutRuntimeState(
  sql: SqlExecutor,
  gameId: string,
  state: Record<string, unknown>,
  single: boolean,
) {
  const phase = state.phase as Phase;
  const limit = single ? 1 : 1000;
  return await sql`
    select gm.*, gmp.role, gmp.ai_personality, gmp.ai_name, gms.alive,
           null::timestamptz as next_think_at,
           null::timestamptz as next_speak_at,
           null::timestamptz as think_cooldown_until,
           null::timestamptz as speak_cooldown_until,
           null::timestamptz as action_cooldown_until,
           null::int as hidden_target_seat_no,
           '{}'::jsonb as strategy,
           null::bigint as last_observed_message_id,
           exists (
             select 1
             from public.game_actions ga
             where ga.game_id = ${gameId}
               and ga.actor_member_id = gm.id
               and ga.phase = ${phase}
               and ga.round_no = ${state.round_no}
               and ga.action_type <> 'speak'
               and ga.resolved_at is null
           ) as required_action_submitted
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gm.is_ai = true
      and gms.alive = true
      and not exists (
        select 1
        from public.game_actions ga
        where ga.game_id = ${gameId}
          and ga.actor_member_id = gm.id
          and ga.phase = ${phase}
          and ga.round_no = ${state.round_no}
          and ga.action_type <> 'speak'
          and ga.resolved_at is null
      )
    order by random()
    limit ${limit}
  `;
}

async function ensureAiRuntimeState(sql: SqlExecutor, gameId: string, state: Record<string, unknown>) {
  const phase = state.phase as Phase;
  if (!["night", "day", "vote", "settlement"].includes(phase)) return;

  const roundNo = state.round_no as number;
  const phaseUpdatedAt = typeof state.updated_at === "string" ? state.updated_at : new Date().toISOString();
  const aiRows = await sql`
    select gm.id, gm.seat_no, gmp.role
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gm.is_ai = true
      and gms.alive = true
    order by gm.seat_no asc
  `;

  for (const ai of aiRows) {
    const memberId = ai.id as string;
    const nextThinkAt = isoAfter(phaseUpdatedAt, aiThinkDelayMs(memberId, phase, roundNo));
    const nextSpeakAt = phase === "day" ? isoAfter(phaseUpdatedAt, aiSpeakDelayMs(memberId, roundNo)) : null;
    await sql`
      insert into public.game_ai_state (
        member_id, game_id, phase, round_no, next_think_at, next_speak_at,
        think_cooldown_until, speak_cooldown_until, action_cooldown_until, hidden_target_seat_no, strategy
      )
      values (
        ${memberId}, ${gameId}, ${phase}, ${roundNo}, ${nextThinkAt}, ${nextSpeakAt},
        null, null, null, null, ${sql.json({})}
      )
      on conflict (member_id) do update
      set phase = excluded.phase,
          round_no = excluded.round_no,
          next_think_at = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then excluded.next_think_at
            else public.game_ai_state.next_think_at
          end,
          next_speak_at = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then excluded.next_speak_at
            else public.game_ai_state.next_speak_at
          end,
          think_cooldown_until = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then null
            else public.game_ai_state.think_cooldown_until
          end,
          speak_cooldown_until = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then null
            else public.game_ai_state.speak_cooldown_until
          end,
          action_cooldown_until = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then null
            else public.game_ai_state.action_cooldown_until
          end,
          hidden_target_seat_no = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then null
            else public.game_ai_state.hidden_target_seat_no
          end,
          strategy = case
            when public.game_ai_state.phase <> excluded.phase or public.game_ai_state.round_no <> excluded.round_no
              then '{}'::jsonb
            else public.game_ai_state.strategy
          end,
          updated_at = now()
    `;
  }

  await ensureWolfStrategicTarget(sql, gameId, phase, roundNo);
}

async function ensureWolfStrategicTarget(sql: SqlExecutor, gameId: string, phase: Phase, roundNo: number) {
  if (!["night", "day", "vote"].includes(phase)) return;

  const existing = await sql`
    select gas.hidden_target_seat_no
    from public.game_ai_state gas
    join public.game_member_profiles gmp on gmp.member_id = gas.member_id
    join public.game_member_state gms on gms.member_id = gas.member_id
    where gas.game_id = ${gameId}
      and gas.phase = ${phase}
      and gas.round_no = ${roundNo}
      and gmp.role = 'wolf'
      and gms.alive = true
      and gas.hidden_target_seat_no is not null
    limit 1
  `;
  const currentTarget = typeof existing[0]?.hidden_target_seat_no === "number" ? existing[0].hidden_target_seat_no as number : null;

  const candidateRows = await sql`
    select gm.seat_no
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
      and gmp.role <> 'wolf'
    order by gm.seat_no asc
  `;
  if (!candidateRows.length) return;

  const validSeats = new Set(candidateRows.map((row) => row.seat_no as number));
  const target = currentTarget && validSeats.has(currentTarget)
    ? currentTarget
    : candidateRows[stableNumber(`${gameId}:wolf-strategy:${phase}:${roundNo}`, 0, candidateRows.length - 1)].seat_no as number;
  const narrative = phase === "night"
    ? `shared kill pressure on Seat ${target}`
    : `build public doubt around Seat ${target}`;

  await sql`
    update public.game_ai_state gas
    set hidden_target_seat_no = ${target},
        strategy = ${sql.json({ wolf_target: target, narrative, phase, round_no: roundNo })},
        updated_at = now()
    from public.game_member_profiles gmp, public.game_member_state gms
    where gas.game_id = ${gameId}
      and gas.phase = ${phase}
      and gas.round_no = ${roundNo}
      and gmp.member_id = gas.member_id
      and gms.member_id = gas.member_id
      and gmp.role = 'wolf'
      and gms.alive = true
  `;
}

async function deterministicRequestId(parts: unknown[]): Promise<string> {
  const input = parts.map((part) => String(part ?? "null")).join("|");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function recordAiActionEvent(
  sql: SqlExecutor,
  gameId: string,
  actorMemberId: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  const existing = await sql`
    select 1
    from public.game_events
    where game_id = ${gameId}
      and event_type = 'ai_action_submitted'
      and payload ->> 'request_id' = ${requestId}
    limit 1
  `;
  if (existing[0]) return;
  await recordEvent(sql, gameId, actorMemberId, "ai_action_submitted", {
    request_id: requestId,
    ...payload,
  });
}

async function applyAiTurn(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  decidedAction?: AiDecision,
) {
  const action = decidedAction ?? await decideAiAction(sql, gameId, ai, state);
  const actorMemberId = ai.id as string;
  const roundNo = state.round_no as number;
  const actorSeatNo = ai.seat_no as number;

  let insertedMessage: Record<string, unknown> | null = null;
  let insertedPrivateMessage: Record<string, unknown> | null = null;
  let actionRequestId: string | null = null;

  if (DAY_SPEECH_ACTIONS.has(action.action)) {
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, "speak", "day", roundNo, ai.next_think_at ?? Date.now()]);
    actionRequestId = requestId;
    const roomRows = await sql`select room_id from public.games where id = ${gameId}`;
    const roomId = roomRows[0].room_id;
    const channelId = await ensureChannel(sql, roomId, gameId, action.channel as Channel);
    const actionResult = await upsertMemberAction(sql, gameId, actorMemberId, "speak", "day", roundNo, action.target ?? null, {
      ai: true,
      planned_action: action.action,
      behavior: action.behavior ?? action.action,
      channel: action.channel,
      content: action.content,
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    }, requestId);
    await sql`
      update public.game_actions
      set resolved_at = now()
      where id = ${actionResult.action_id}
    `;
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: "speak",
      planned_action: action.action,
      behavior: action.behavior ?? action.action,
      phase: "day",
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: action.target ?? null,
      channel: action.channel,
      content: action.content ?? "",
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    });
    if (actionResult.status === "created") {
      const rows = await sql`
        insert into public.messages (room_id, game_id, channel_id, sender_id, sender_member_id, seat_no, content, metadata)
        values (${roomId}, ${gameId}, ${channelId}, null, ${ai.id}, ${ai.seat_no}, ${action.content}, ${sql.json({
          seat: ai.seat_no,
          ai: true,
          behavior: action.behavior ?? action.action,
          target_seat_no: action.target ?? null,
        })})
        returning id, game_id, seat_no, content, created_at
      `;
      insertedMessage = sanitizeMessage({ ...rows[0], channel: action.channel ?? "public" });
    }
  } else if (action.action === "vote") {
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, "vote", "vote", roundNo]);
    actionRequestId = requestId;
    await upsertMemberAction(sql, gameId, actorMemberId, "vote", "vote", roundNo, action.target ?? null, {
      ai: true,
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      abstain: action.target === null || action.target === undefined,
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: "vote",
      phase: "vote",
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: action.target ?? null,
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    });
  } else if (action.action === "skill") {
    const actionType = action.skill ?? "pass";
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, actionType, "night", roundNo]);
    actionRequestId = requestId;
    await upsertMemberAction(sql, gameId, actorMemberId, actionType, "night", roundNo, action.target ?? null, {
      ai: true,
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: actionType,
      phase: "night",
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: action.target ?? null,
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    });
  } else {
    const phase = state.phase as Phase;
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, action.action, phase, roundNo, ai.next_think_at ?? Date.now()]);
    actionRequestId = requestId;
    if (action.action === "pass" && (phase === "night" || phase === "vote")) {
      await upsertMemberAction(sql, gameId, actorMemberId, "pass", phase, roundNo, null, {
        ai: true,
        delay_ms: action.delay_ms ?? null,
        priority: action.priority ?? null,
        ...aiActionDiagnostics(action),
        reasoning_state: action.reasoning_state ?? null,
        private_content: action.private_content ?? "",
        suspicion_map: action.suspicion_map ?? {},
        next_think_at: action.next_think_at ?? null,
        next_speak_at: action.next_speak_at ?? null,
        cooldowns: action.cooldowns ?? {},
      }, requestId);
    }
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: action.action === "pass" ? "pass" : "think",
      planned_action: action.action,
      phase,
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: null,
      delay_ms: action.delay_ms ?? null,
      priority: action.priority ?? null,
      ...aiActionDiagnostics(action),
      reasoning_state: action.reasoning_state ?? null,
      private_content: action.private_content ?? "",
      suspicion_map: action.suspicion_map ?? {},
      next_think_at: action.next_think_at ?? null,
      next_speak_at: action.next_speak_at ?? null,
      cooldowns: action.cooldowns ?? {},
    });
  }

  insertedPrivateMessage = await maybeInsertAiPrivateWolfMessage(sql, gameId, ai, state, action, actionRequestId);
  await updateAiRuntimeAfterDecision(sql, gameId, actorMemberId, state, action);

  return {
    action: action.action,
    target: action.target ?? null,
    content: action.content ?? "",
    actor_member_id: ai.id,
    seat_no: ai.seat_no,
    ai_source: action.source ?? null,
    provider_error: action.provider_error ?? null,
    provider_error_detail: action.provider_error_detail ?? null,
    message: insertedMessage,
    private_message: insertedPrivateMessage,
  };
}

async function maybeInsertAiPrivateWolfMessage(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  action: AiDecision,
  requestId: string | null,
): Promise<Record<string, unknown> | null> {
  const phase = state.phase as Phase;
  const content = stringValue(action.private_content).replace(/\s+/g, " ").trim().slice(0, 220);
  if (!requestId || !content || ai.role !== "wolf" || !["night", "day", "vote"].includes(phase)) return null;

  const existing = await sql`
    select id
    from public.messages
    where game_id = ${gameId}
      and sender_member_id = ${ai.id}
      and metadata ->> 'request_id' = ${requestId}
    limit 1
  `;
  if (existing[0]) return null;

  const roomRows = await sql`select room_id from public.games where id = ${gameId}`;
  const roomId = roomRows[0]?.room_id as string | undefined;
  if (!roomId) return null;

  const channelId = await ensureChannel(sql, roomId, gameId, "wolf");
  const rows = await sql`
    insert into public.messages (room_id, game_id, channel_id, sender_id, sender_member_id, seat_no, content, metadata)
    values (${roomId}, ${gameId}, ${channelId}, null, ${ai.id}, ${ai.seat_no}, ${content}, ${sql.json({
      seat: ai.seat_no,
      ai: true,
      private: true,
      request_id: requestId,
      target_seat_no: action.target ?? null,
    })})
    returning id, game_id, seat_no, content, created_at
  `;
  return sanitizeMessage({ ...rows[0], channel: "wolf" });
}

function aiActionDiagnostics(action: AiDecision): Record<string, unknown> {
  return {
    ai_source: action.source ?? null,
    provider_error: action.provider_error ?? null,
    provider_error_detail: action.provider_error_detail ?? null,
  };
}

async function updateAiRuntimeAfterDecision(
  sql: SqlExecutor,
  gameId: string,
  actorMemberId: string,
  state: Record<string, unknown>,
  action: AiDecision,
) {
  if (!await hasAiRuntimeStateTable(sql)) return;
  const phase = state.phase as Phase;
  if (!["night", "day", "vote", "settlement"].includes(phase)) return;

  const roundNo = state.round_no as number;
  const nowIso = new Date().toISOString();
  const nextThinkAt = action.next_think_at ?? isoAfter(nowIso, aiThinkCooldownMs(actorMemberId, phase, roundNo));
  const nextSpeakAt = phase === "day"
    ? action.next_speak_at ?? isoAfter(nowIso, aiSpeakCooldownMs(actorMemberId, roundNo))
    : null;
  const cooldowns = action.cooldowns ?? {};

  await sql`
    update public.game_ai_state
    set next_think_at = ${nextThinkAt},
        next_speak_at = ${nextSpeakAt},
        think_cooldown_until = ${cooldowns.think ?? nextThinkAt},
        speak_cooldown_until = ${phase === "day" ? cooldowns.speak ?? nextSpeakAt : null},
        action_cooldown_until = ${cooldowns.action ?? null},
        updated_at = now()
    where member_id = ${actorMemberId}
      and game_id = ${gameId}
      and phase = ${phase}
      and round_no = ${roundNo}
  `;
}

function ensureBeforeGrace(deadlineAt: string | null) {
  if (isPastGrace(deadlineAt)) {
    throw new HttpError(409, "The action window is closed.");
  }
}

function isPastGrace(deadlineAt: string | null): boolean {
  if (!deadlineAt) return false;
  return Date.now() > new Date(deadlineAt).getTime() + 3000;
}

function allowedSkill(role: string, skill: string): boolean {
  if (role === "wolf") return skill === "wolf_kill" || skill === "pass";
  if (role === "seer") return skill === "seer_check" || skill === "pass";
  if (role === "witch") return skill === "witch_heal" || skill === "witch_poison" || skill === "pass";
  return skill === "pass";
}

async function upsertMemberAction(
  sql: SqlExecutor,
  gameId: string,
  actorMemberId: string,
  actionType: string,
  phase: string,
  roundNo: number,
  targetSeatNo: number | null,
  payload: Record<string, unknown>,
  requestId: string,
) {
  const sameRequest = await sql`
    select id
    from public.game_actions
    where request_id = ${requestId}
  `;
  if (sameRequest[0]) return { status: "duplicate" as const, action_id: sameRequest[0].id };

  const existing = payload.ai === true
    ? await sql`
        select id
        from public.game_actions
        where game_id = ${gameId}
          and actor_member_id = ${actorMemberId}
          and phase = ${phase}
          and round_no = ${roundNo}
          and resolved_at is null
        for update
      `
    : await sql`
        select id
        from public.game_actions
        where game_id = ${gameId}
          and actor_member_id = ${actorMemberId}
          and action_type = ${actionType}
          and phase = ${phase}
          and round_no = ${roundNo}
          and resolved_at is null
        for update
      `;

  if (existing[0]) {
    await sql`
      update public.game_actions
      set request_id = ${requestId},
          action_type = ${actionType},
          target_seat_no = ${targetSeatNo},
          payload = ${sql.json(payload)},
          locked_at = now()
      where id = ${existing[0].id}
    `;
    return { status: "updated" as const, action_id: existing[0].id };
  }

  const inserted = await sql`
    insert into public.game_actions (request_id, game_id, actor_member_id, action_type, phase, round_no, target_seat_no, payload, locked_at)
    values (${requestId}, ${gameId}, ${actorMemberId}, ${actionType}, ${phase}, ${roundNo}, ${targetSeatNo}, ${sql.json(payload)}, now())
    returning id
  `;
  return { status: "created" as const, action_id: inserted[0].id };
}

async function maybeResolveVote(sql: SqlExecutor, gameId: string, roundNo: number, force: boolean) {
  if (await hasResolutionEvent(sql, gameId, "vote_resolved", roundNo)) return true;
  const roomId = await roomIdForGame(sql, gameId);

  const aliveRows = await sql`
    select gm.id, gm.seat_no
    from public.game_members gm
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
  `;
  const voteRows = await sql`
    select ga.actor_member_id, gm.seat_no as voter_seat, ga.target_seat_no, ga.payload
    from public.game_actions ga
    join public.game_members gm on gm.id = ga.actor_member_id
    where ga.game_id = ${gameId}
      and ga.round_no = ${roundNo}
      and ga.action_type = 'vote'
      and ga.resolved_at is null
    order by gm.seat_no asc
  `;

  if (!force && voteRows.length < aliveRows.length) return false;

  const counts = new Map<number, number>();
  const voteDetail = voteRows.map((vote) => {
    const payload = asRecord(vote.payload);
    const targetSeat = typeof vote.target_seat_no === "number" ? vote.target_seat_no as number : null;
    return {
      voter_member_id: vote.actor_member_id,
      voter_seat: vote.voter_seat,
      target_seat: targetSeat,
      abstain: targetSeat === null || payload.abstain === true,
      reasoning_state: typeof payload.reasoning_state === "string" ? payload.reasoning_state : null,
      suspicion_map: asRecord(payload.suspicion_map),
    };
  });
  for (const vote of voteRows) {
    if (typeof vote.target_seat_no === "number") {
      counts.set(vote.target_seat_no, (counts.get(vote.target_seat_no) ?? 0) + 1);
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const aliveCount = aliveRows.length;
  const abstainCount = voteDetail.filter((vote) => vote.abstain).length;
  const validVotes = voteDetail.length - abstainCount;
  const majorityThreshold = aliveCount / 2;
  const tiedTop = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  const maxVotes = ranked[0]?.[1] ?? 0;
  const hasAbsoluteMajority = maxVotes > majorityThreshold;
  const eliminatedSeat = ranked.length > 0 && !tiedTop && hasAbsoluteMajority ? ranked[0][0] : null;
  const result = eliminatedSeat !== null
    ? "executed"
    : tiedTop
      ? "no_execution_tie"
      : "no_execution_majority";

  if (eliminatedSeat !== null) {
    await sql`
      update public.game_member_state gms
      set alive = false,
          death_reason = 'vote_out',
          death_round = ${roundNo},
          killed_by_member_id = null,
          updated_at = now()
      from public.game_members gm
      where gms.member_id = gm.id
        and gm.game_id = ${gameId}
        and gm.seat_no = ${eliminatedSeat}
        and gms.alive = true
    `;
  }

  await sql`
    update public.game_actions
    set resolved_at = now()
    where game_id = ${gameId}
      and round_no = ${roundNo}
      and action_type = 'vote'
      and resolved_at is null
  `;

  await recordEvent(sql, gameId, null, "vote_resolved", {
    round_no: roundNo,
    eliminated_seat: eliminatedSeat,
    votes: Object.fromEntries(counts),
    vote_detail: voteDetail,
    abstain_count: abstainCount,
    valid_votes: validVotes,
    total_votes: voteDetail.length,
    alive_count: aliveCount,
    majority_threshold: majorityThreshold,
    execution_votes_required: Math.floor(aliveCount / 2) + 1,
    result,
    explanation: {
      summary: eliminatedSeat === null
        ? "No player was eliminated because the vote did not produce a valid execution."
        : `Seat ${eliminatedSeat} was eliminated by vote.`,
      causal_chain: [
        `Alive players: ${aliveCount}`,
        `Valid votes: ${validVotes}`,
        `Abstains: ${abstainCount}`,
        `Top vote count: ${maxVotes}`,
        `Execution requires more than half of alive players (${majorityThreshold}).`,
      ],
      visibility: ["all"],
    },
  });
  const voteSummary = voteDetail.length
    ? voteDetail.map((vote) => `Seat ${vote.voter_seat} -> ${vote.target_seat === null ? "Abstain" : `Seat ${vote.target_seat}`}`).join("; ")
    : "No votes were submitted.";
  await insertSystemMessage(
    sql,
    roomId,
    gameId,
    eliminatedSeat === null
      ? `Vote result: ${voteSummary}. No execution (${result.split("_").join(" ")}).`
      : `Vote result: ${voteSummary}. Seat ${eliminatedSeat} was executed.`,
  );
  return true;
}

async function maybeResolveNight(sql: SqlExecutor, gameId: string, roundNo: number, force: boolean) {
  if (await hasResolutionEvent(sql, gameId, "night_resolved", roundNo)) return true;
  const roomId = await roomIdForGame(sql, gameId);

  const eligibleRows = await sql`
    select gm.id, gm.seat_no, gmp.role
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
      and gmp.role in ('wolf', 'seer', 'witch', 'hunter')
  `;

  const submittedRows = await sql`
    select distinct actor_member_id
    from public.game_actions
    where game_id = ${gameId}
      and round_no = ${roundNo}
      and phase = 'night'
      and resolved_at is null
      and action_type <> 'speak'
  `;
  if (!force && submittedRows.length < eligibleRows.length) return false;
  if (force) await insertTimeoutNightPasses(sql, gameId, roundNo, eligibleRows);

  const actionRows = await sql`
    select ga.actor_member_id, gm.seat_no as actor_seat, gmp.role as actor_role, ga.action_type, ga.target_seat_no, ga.payload
    from public.game_actions ga
    join public.game_members gm on gm.id = ga.actor_member_id
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    where ga.game_id = ${gameId}
      and ga.round_no = ${roundNo}
      and ga.phase = 'night'
      and ga.resolved_at is null
    order by gm.seat_no asc
  `;

  const wolfCount = eligibleRows.filter((row) => row.role === "wolf").length;
  const healedTargets = new Set(
    actionRows
      .filter((action) => action.action_type === "witch_heal" && typeof action.target_seat_no === "number")
      .map((action) => action.target_seat_no as number),
  );

  const killTarget = unanimousWolfKillTarget(actionRows, wolfCount);
  const deathMetadata = new Map<number, { reason: "wolf_kill" | "witch_poison"; killedByMemberId: string | null }>();
  if (killTarget !== null && !healedTargets.has(killTarget)) {
    deathMetadata.set(killTarget, { reason: "wolf_kill", killedByMemberId: null });
  }
  for (const action of actionRows) {
    if (action.action_type === "witch_poison" && typeof action.target_seat_no === "number") {
      deathMetadata.set(action.target_seat_no, {
        reason: "witch_poison",
        killedByMemberId: typeof action.actor_member_id === "string" ? action.actor_member_id : null,
      });
    }
  }

  for (const [seatNo, death] of deathMetadata) {
    await sql`
      update public.game_member_state gms
      set alive = false,
          death_reason = ${death.reason},
          death_round = ${roundNo},
          killed_by_member_id = ${death.killedByMemberId},
          updated_at = now()
      from public.game_members gm
      where gms.member_id = gm.id
        and gm.game_id = ${gameId}
        and gm.seat_no = ${seatNo}
        and gms.alive = true
    `;
  }

  await sql`
    update public.game_actions
    set resolved_at = now()
    where game_id = ${gameId}
      and round_no = ${roundNo}
      and phase = 'night'
      and resolved_at is null
  `;

  const nightActions = actionRows.map((action) => {
    const payload = asRecord(action.payload);
    return {
      actor_member_id: action.actor_member_id,
      actor_seat: action.actor_seat,
      actor_role: action.actor_role,
      action_type: nightActionDisplayType(action),
      raw_action_type: action.action_type,
      target_seat: typeof action.target_seat_no === "number" ? action.target_seat_no : null,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      defaulted: payload.defaulted === true,
      reasoning_state: typeof payload.reasoning_state === "string" ? payload.reasoning_state : null,
      suspicion_map: asRecord(payload.suspicion_map),
    };
  });
  const timeoutActions = nightActions.filter((action) => action.reason === "timeout");

  await recordEvent(sql, gameId, null, "night_resolved", {
    round_no: roundNo,
    killed_seats: [...deathMetadata.keys()],
    death_reasons: Object.fromEntries([...deathMetadata].map(([seat, death]) => [seat, death.reason])),
    death_details: Object.fromEntries(deathMetadata),
    night_actions: nightActions,
    timeout_actions: timeoutActions,
    wolf_choices: actionRows
      .filter((action) => action.actor_role === "wolf")
      .map((action) => {
        const payload = asRecord(action.payload);
        return {
          actor_seat: action.actor_seat,
          action_type: nightActionDisplayType(action),
          target_seat: action.target_seat_no ?? null,
          reason: typeof payload.reason === "string" ? payload.reason : null,
        };
      }),
    seer_results: await seerResultDetails(sql, gameId, actionRows),
    witch_actions: actionRows
      .filter((action) => action.actor_role === "witch")
      .map((action) => {
        const payload = asRecord(action.payload);
        return {
          actor_seat: action.actor_seat,
          action_type: nightActionDisplayType(action),
          target_seat: action.target_seat_no ?? null,
          reason: typeof payload.reason === "string" ? payload.reason : null,
        };
      }),
    explanation: {
      summary: deathMetadata.size
        ? `Night resolved with ${deathMetadata.size} death event(s).`
        : "Night resolved with no deaths.",
      causal_chain: [
        `Wolf target: ${killTarget ?? "none"}`,
        `Healed seats: ${[...healedTargets].join(", ") || "none"}`,
        `Killed seats: ${[...deathMetadata.keys()].join(", ") || "none"}`,
      ],
      visibility: ["all"],
    },
  });
  const deathSummary = deathMetadata.size
    ? [...deathMetadata.entries()]
      .map(([seat, death]) => `Seat ${seat} died (${death.reason.replace("_", " ")})`)
      .join("; ")
    : "No one died.";
  const timeoutSummary = timeoutActions.length
    ? ` Timeout passes: ${timeoutActions.map((action) => `Seat ${action.actor_seat} timeout -> pass`).join("; ")}.`
    : "";
  await insertSystemMessage(sql, roomId, gameId, `Night ${roundNo} result: ${deathSummary}${timeoutSummary}`);
  return true;
}

async function insertTimeoutNightPasses(
  sql: SqlExecutor,
  gameId: string,
  roundNo: number,
  eligibleRows: Record<string, unknown>[],
) {
  for (const member of eligibleRows) {
    const actorMemberId = member.id as string;
    const existing = await sql`
      select 1
      from public.game_actions
      where game_id = ${gameId}
        and actor_member_id = ${actorMemberId}
        and phase = 'night'
        and round_no = ${roundNo}
        and resolved_at is null
        and action_type <> 'speak'
      limit 1
    `;
    if (existing[0]) continue;

    const requestId = await deterministicRequestId(["night-timeout", gameId, actorMemberId, "pass", roundNo]);
    await upsertMemberAction(sql, gameId, actorMemberId, "pass", "night", roundNo, null, {
      defaulted: true,
      reason: "timeout",
      timeout: true,
      planned_action: "pass",
      reasoning_state: "Night deadline reached before action submission; defaulting to pass.",
      suspicion_map: {},
    }, requestId);
  }
}

function nightActionDisplayType(action: Record<string, unknown>): string {
  return String(action.action_type ?? "acted");
}

function unanimousWolfKillTarget(actionRows: Record<string, unknown>[], wolfCount: number): number | null {
  if (wolfCount <= 0) return null;

  const wolfActions = actionRows.filter((action) => action.actor_role === "wolf");
  const wolfKills = wolfActions.filter((action) => action.action_type === "wolf_kill" && typeof action.target_seat_no === "number");
  if (wolfActions.length !== wolfCount || wolfKills.length !== wolfCount) return null;

  const targets = new Set(wolfKills.map((action) => action.target_seat_no as number));
  if (targets.size !== 1) return null;
  return [...targets][0];
}

async function seerResultDetails(sql: SqlExecutor, gameId: string, actionRows: Record<string, unknown>[]) {
  const checks = actionRows.filter((action) => action.action_type === "seer_check" && typeof action.target_seat_no === "number");
  const results = [];
  for (const check of checks) {
    const targetRows = await sql`
      select gmp.role
      from public.game_members gm
      join public.game_member_profiles gmp on gmp.member_id = gm.id
      where gm.game_id = ${gameId}
        and gm.seat_no = ${check.target_seat_no}
    `;
    results.push({
      actor_seat: check.actor_seat,
      target_seat: check.target_seat_no,
      is_wolf: targetRows[0]?.role === "wolf",
    });
  }
  return results;
}

async function hasResolutionEvent(sql: SqlExecutor, gameId: string, eventType: string, roundNo: number): Promise<boolean> {
  const rows = await sql`
    select 1
    from public.game_events
    where game_id = ${gameId}
      and event_type = ${eventType}
      and payload ->> 'round_no' = ${String(roundNo)}
    limit 1
  `;
  return Boolean(rows[0]);
}

function mostCommon(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

async function setPhase(sql: SqlExecutor, gameId: string, phase: Phase, roundNo: number, expectedVersion: number) {
  const deadline = phase === "ended" || phase === "waiting" ? null : deadlineFor(phase);
  const roomId = await roomIdForGame(sql, gameId);
  const updated = await sql`
    update public.game_state
    set phase = ${phase},
        round_no = ${roundNo},
        deadline_at = ${deadline},
        state_version = state_version + 1,
        updated_at = now()
    where game_id = ${gameId}
      and state_version = ${expectedVersion}
    returning phase, round_no, deadline_at, state_version, updated_at
  `;
  if (!updated[0]) return false;

  if (await hasAiRuntimeStateTable(sql)) await ensureAiRuntimeState(sql, gameId, updated[0]);
  await recordEvent(sql, gameId, null, "phase_changed", { phase, round_no: roundNo, deadline_at: deadline });
  await insertSystemMessage(sql, roomId, gameId, `Phase changed: ${phase} / round ${roundNo}.`);
  return updated[0];
}

async function evaluateWinner(sql: SqlExecutor, gameId: string): Promise<string | null> {
  const existing = await sql`select winner, ended_at from public.games where id = ${gameId}`;
  if (existing[0]?.winner && existing[0]?.ended_at) return existing[0].winner;

  const counts = await sql`
    select
      count(*) filter (where gms.alive and gmp.role = 'wolf')::int as wolves,
      count(*) filter (where gms.alive and gmp.role <> 'wolf')::int as villagers
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
  `;
  const wolves = counts[0].wolves as number;
  const villagers = counts[0].villagers as number;
  const winner = wolves <= 0 ? "villagers" : wolves >= villagers ? "wolves" : null;
  if (!winner) return null;
  const winCondition = winner === "villagers" ? "wolves_eliminated" : "wolves_reached_parity";

  const gameRows = await sql`select room_id, started_at from public.games where id = ${gameId}`;
  const game = gameRows[0];
  await sql`
    update public.games
    set winner = ${winner},
        ended_at = coalesce(ended_at, now())
    where id = ${gameId}
  `;
  await sql`
    update public.rooms
    set status = 'POST_GAME'
    where id = ${game.room_id}
  `;
  await sql`
    insert into public.game_results (game_id, member_id, seat_no, is_ai, role, winner, snapshot, duration_seconds)
    select ${gameId}, gm.id, gm.seat_no, gm.is_ai, gmp.role, ${winner},
      jsonb_build_object(
        'seat', gm.seat_no,
        'display_name', coalesce(p.nickname, gmp.ai_name, 'Seat ' || gm.seat_no::text),
        'is_ai', gm.is_ai,
        'role', gmp.role,
        'user_id', gm.user_id,
        'alive', gms.alive,
        'death_reason', gms.death_reason,
        'death_round', gms.death_round,
        'killed_by_member_id', gms.killed_by_member_id
      ),
      greatest(0, extract(epoch from (now() - ${game.started_at}::timestamptz)))::int
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    left join public.profiles p on p.id = gm.user_id
    where gm.game_id = ${gameId}
  `;
  await recordEvent(sql, gameId, null, "game_ended", {
    winner,
    wolves_alive: wolves,
    non_wolves_alive: villagers,
    win_condition: winCondition,
    explanation: {
      summary: winner === "villagers"
        ? "Villagers win because no wolves remain alive."
        : "Wolves win because wolves reached parity with non-wolves.",
      causal_chain: [
        `Wolves alive: ${wolves}`,
        `Non-wolves alive: ${villagers}`,
      ],
      visibility: ["all"],
    },
  });
  await insertSystemMessage(sql, game.room_id as string, gameId, `Game ended: ${winner} win (${winCondition}).`);
  return winner;
}

async function emergencyAiDecision(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  cause: unknown,
): Promise<AiDecision> {
  const phase = state.phase as Phase;
  const role = String(ai.role ?? "villager");
  const seatNo = Number(ai.seat_no);
  const roundNo = Number(state.round_no ?? 1);
  const memberId = String(ai.id ?? seatNo);
  const targets = await sql`
    select gm.seat_no, gmp.role
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
      and gm.seat_no <> ${seatNo}
    order by gm.seat_no asc
  `;
  const legalTargets = legalTargetSeats(role, phase, targets);
  const target = legalTargets.length
    ? legalTargets[stableNumber(`${gameId}:${memberId}:${phase}:${roundNo}:emergency`, 0, legalTargets.length - 1)]
    : null;
  const nextThinkAt = isoAfter(new Date().toISOString(), aiThinkCooldownMs(memberId, phase, roundNo));
  const nextSpeakAt = phase === "day" ? isoAfter(new Date().toISOString(), aiSpeakCooldownMs(memberId, roundNo)) : null;
  const detail = cause instanceof Error ? cause.message : "unknown";
  const base: Partial<AiDecision> = {
    target,
    delay_ms: 0,
    priority: 5,
    next_think_at: nextThinkAt,
    next_speak_at: nextSpeakAt,
    source: "baseline_ai",
    provider_error: "emergency_fallback",
    provider_error_detail: detail.slice(0, 240),
    reasoning_state: `Emergency fallback after AI turn failure: ${detail.slice(0, 160)}`,
    suspicion_map: {},
  };

  if (phase === "day") {
    return {
      ...base,
      action: "speak",
      behavior: "question",
      channel: "public",
      content: target
        ? `Seat ${target}, give one clear read and one backup vote. We need movement before the vote.`
        : "I want everyone to name one suspect and one person they would not vote today.",
      cooldowns: { think: nextThinkAt, speak: nextSpeakAt },
    } as AiDecision;
  }

  if (phase === "vote") {
    return {
      ...base,
      action: "vote",
      cooldowns: { think: nextThinkAt, action: nextThinkAt },
    } as AiDecision;
  }

  if (phase === "night") {
    if (role === "wolf") {
      return {
        ...base,
        action: "skill",
        skill: target === null ? "pass" : "wolf_kill",
        private_content: wolfPrivateFallbackLine(phase, target),
        cooldowns: { think: nextThinkAt, action: nextThinkAt },
      } as AiDecision;
    }
    if (role === "seer") {
      return {
        ...base,
        action: "skill",
        skill: target === null ? "pass" : "seer_check",
        cooldowns: { think: nextThinkAt, action: nextThinkAt },
      } as AiDecision;
    }
    return {
      ...base,
      action: "skill",
      skill: "pass",
      target: null,
      cooldowns: { think: nextThinkAt, action: nextThinkAt },
    } as AiDecision;
  }

  return {
    ...base,
    action: "pass",
    target: null,
    cooldowns: { think: nextThinkAt },
  } as AiDecision;
}

async function decideAiAction(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  options: { useExternal?: boolean } = {},
): Promise<AiDecision> {
  const phase = state.phase as Phase;
  const role = ai.role as string;
  const seatNo = ai.seat_no as number;
  const targets = await sql`
    select gm.seat_no, gmp.role
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
      and gm.seat_no <> ${seatNo}
    order by random()
  `;
  const memory = await buildAiSocialMemory(sql, gameId, ai, state, targets);
  const sharedWolfTarget = typeof ai.hidden_target_seat_no === "number" ? ai.hidden_target_seat_no as number : memory.wolf_shared_target;
  const target = role === "wolf" && sharedWolfTarget
    ? sharedWolfTarget
    : role === "seer" && memory.seer_known_wolves[0]
      ? memory.seer_known_wolves[0]
      : memory.suggestedTarget ?? targets[0]?.seat_no ?? null;
  const confidence = target ? memory.suspicion_map[String(target)] ?? 0 : 0;
  const delayMs = aiThinkDelayMs(ai.id as string, phase, state.round_no as number);
  const nextThinkAt = isoAfter(new Date().toISOString(), aiThinkCooldownMs(ai.id as string, phase, state.round_no as number));
  const nextSpeakAt = phase === "day" ? isoAfter(new Date().toISOString(), aiSpeakCooldownMs(ai.id as string, state.round_no as number)) : null;

  if (phase === "day") {
    const now = Date.now();
    const speakDue = typeof ai.next_speak_at !== "string" || new Date(ai.next_speak_at).getTime() <= now;
    const directMention = memory.direct_mentions.length > 0;
    const hardSeerFinding = role === "seer" && memory.seer_known_wolves.length > 0;
    const hunterAtRisk = role === "hunter" && memory.self_preservation_score >= 0.18;

    if (!speakDue && !directMention && !hardSeerFinding && !hunterAtRisk) {
      return {
        action: "observe",
        target,
        behavior: "stay_silent",
        delay_ms: delayMs,
        priority: 1,
        next_think_at: nextThinkAt,
        next_speak_at: (ai.next_speak_at as string | null) ?? nextSpeakAt,
        cooldowns: { think: nextThinkAt, speak: (ai.next_speak_at as string | null) ?? nextSpeakAt },
        reasoning_state: `Read ${memory.public_messages.length} recent public messages; waiting for the next useful entry point.`,
        suspicion_map: memory.suspicion_map,
      };
    }
  }

  const externalResult = options.useExternal === false
    ? { decision: null, error: "external_skipped_for_tick", detail: "" }
    : await externalAiDecision(sql, gameId, ai, state, targets);
  if (externalResult.decision) return externalResult.decision;

  const fallbackReason = externalResult.error
    ? `External AI unavailable (${externalResult.error}); using context fallback.`
    : "External AI unavailable or returned an invalid action; using context fallback.";
  const withFallbackDiagnostics = (decision: AiDecision): AiDecision => ({
    ...decision,
    source: "baseline_ai",
    provider_error: externalResult.error ?? "unknown",
    provider_error_detail: externalResult.detail ?? "",
  });

  if (phase === "day") {
    const now = Date.now();
    const speakDue = typeof ai.next_speak_at !== "string" || new Date(ai.next_speak_at).getTime() <= now;
    const directMention = memory.direct_mentions.length > 0;
    const hardSeerFinding = role === "seer" && memory.seer_known_wolves.length > 0;
    const hunterAtRisk = role === "hunter" && memory.self_preservation_score >= 0.18;
    const voiceChance = ai.ai_personality === "silent" ? 55 : role === "wolf" ? 92 : 84;
    const hasAlreadyTalkedALot = memory.own_speech_count >= 3;
    const shouldStayQuiet = !directMention
      && !hardSeerFinding
      && !hunterAtRisk
      && (hasAlreadyTalkedALot || stableNumber(`${ai.id}:day-voice:${state.round_no}:${memory.public_messages.length}`, 0, 100) > voiceChance);

    if (!speakDue || shouldStayQuiet) {
      return withFallbackDiagnostics({
        action: shouldStayQuiet ? "stay_silent" : "observe",
        target,
        behavior: "stay_silent",
        delay_ms: delayMs,
        priority: 1,
        next_think_at: nextThinkAt,
        next_speak_at: (ai.next_speak_at as string | null) ?? nextSpeakAt,
        cooldowns: { think: nextThinkAt, speak: (ai.next_speak_at as string | null) ?? nextSpeakAt },
        reasoning_state: `Read ${memory.public_messages.length} recent public messages; no high-value intervention yet. ${fallbackReason}`,
        suspicion_map: memory.suspicion_map,
      });
    }

    const behavior = chooseConversationBehavior(role, confidence, memory, target, hardSeerFinding, hunterAtRisk);
    return withFallbackDiagnostics({
      action: behavior,
      behavior,
      channel: "public",
      target,
      content: aiLine(ai.ai_personality as string, role, target, behavior, confidence, memory),
      delay_ms: delayMs,
      priority: directMention || hardSeerFinding ? 4 : confidence > 0.62 ? 3 : 2,
      next_think_at: nextThinkAt,
      next_speak_at: nextSpeakAt,
      cooldowns: { think: nextThinkAt, speak: nextSpeakAt },
      reasoning_state: `Chose ${behavior} after reading recent chat, votes, deaths, direct mentions, and role context. ${fallbackReason}`,
      suspicion_map: memory.suspicion_map,
    });
  }

  if (phase === "vote") {
    const voteTarget = role === "wolf" && sharedWolfTarget
      ? sharedWolfTarget
      : role === "seer" && memory.seer_known_wolves[0]
        ? memory.seer_known_wolves[0]
        : confidence >= 0.3 ? target : null;
    return withFallbackDiagnostics({
      action: "vote",
      target: voteTarget,
      delay_ms: delayMs,
      priority: 4,
      next_think_at: nextThinkAt,
      next_speak_at: null,
      cooldowns: { think: nextThinkAt, action: nextThinkAt },
      reasoning_state: voteTarget
        ? `Voting Seat ${voteTarget}; decision includes recent claims, pressure, vote history, and role strategy. ${fallbackReason}`
        : `No target reached confidence threshold after conversation review; abstaining. ${fallbackReason}`,
      suspicion_map: memory.suspicion_map,
    });
  }

  if (phase === "night") {
    if (role === "wolf") {
      const nonWolf = targets.find((candidate) => candidate.seat_no === sharedWolfTarget && candidate.role !== "wolf")
        ?? targets.find((candidate) => candidate.role !== "wolf");
      return withFallbackDiagnostics({
        action: "skill",
        skill: "wolf_kill",
        target: nonWolf?.seat_no ?? null,
        delay_ms: delayMs,
        priority: 5,
        next_think_at: nextThinkAt,
        next_speak_at: null,
        cooldowns: { think: nextThinkAt, action: nextThinkAt },
        private_content: wolfPrivateFallbackLine(phase, nonWolf?.seat_no ?? null),
        reasoning_state: `Coordinating wolf night action on shared strategic target Seat ${nonWolf?.seat_no ?? "-"}. ${fallbackReason}`,
        suspicion_map: memory.suspicion_map,
      });
    }
    if (role === "seer") {
      const unchecked = targets.find((candidate) => !memory.seer_checked_seats.includes(candidate.seat_no as number) && candidate.seat_no === target)
        ?? targets.find((candidate) => !memory.seer_checked_seats.includes(candidate.seat_no as number))
        ?? targets[0];
      return withFallbackDiagnostics({
        action: "skill",
        skill: "seer_check",
        target: unchecked?.seat_no ?? null,
        delay_ms: delayMs,
        priority: 5,
        next_think_at: nextThinkAt,
        next_speak_at: null,
        cooldowns: { think: nextThinkAt, action: nextThinkAt },
        reasoning_state: `Checking Seat ${unchecked?.seat_no ?? "-"} because public discussion needs confirmation and prior checks were avoided. ${fallbackReason}`,
        suspicion_map: memory.suspicion_map,
      });
    }
    if (role === "witch") {
      const poisonTarget = confidence >= 0.62 ? target : null;
      const healTarget = memory.current_wolf_kill_target;
      const shouldHeal = healTarget !== null && stableNumber(`${gameId}:witch-heal:${ai.id}:${state.round_no}:${healTarget}`, 0, 100) < 62;
      const shouldPoison = !shouldHeal && poisonTarget !== null && stableNumber(`${gameId}:witch-poison:${ai.id}:${state.round_no}:${poisonTarget}`, 0, 100) < 58;
      if (shouldHeal) {
        return withFallbackDiagnostics({
          action: "skill",
          skill: "witch_heal",
          target: healTarget,
          delay_ms: delayMs,
          priority: 5,
          next_think_at: nextThinkAt,
          next_speak_at: null,
          cooldowns: { think: nextThinkAt, action: nextThinkAt },
          reasoning_state: `Healing Seat ${healTarget}; current night actions suggest a likely wolf kill there. ${fallbackReason}`,
          suspicion_map: memory.suspicion_map,
        });
      }
      if (shouldPoison) {
        return withFallbackDiagnostics({
          action: "skill",
          skill: "witch_poison",
          target: poisonTarget,
          delay_ms: delayMs,
          priority: 5,
          next_think_at: nextThinkAt,
          next_speak_at: null,
          cooldowns: { think: nextThinkAt, action: nextThinkAt },
          reasoning_state: `Poisoning Seat ${poisonTarget}; accumulated pressure passed the witch threshold. ${fallbackReason}`,
          suspicion_map: memory.suspicion_map,
        });
      }
      return withFallbackDiagnostics({
        action: "skill",
        skill: "pass",
        target: null,
        delay_ms: delayMs,
        priority: 2,
        next_think_at: nextThinkAt,
        next_speak_at: null,
        cooldowns: { think: nextThinkAt, action: nextThinkAt },
        reasoning_state: `Holding witch action because neither save probability nor poison confidence cleared threshold. ${fallbackReason}`,
        suspicion_map: memory.suspicion_map,
      });
    }
  }

  return withFallbackDiagnostics({
    action: "pass",
    target: null,
    delay_ms: delayMs,
    priority: 1,
    next_think_at: nextThinkAt,
    next_speak_at: null,
    cooldowns: { think: nextThinkAt },
    reasoning_state: `No useful action available. ${fallbackReason}`,
    suspicion_map: memory.suspicion_map,
  });
}

async function externalAiDecision(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  targets: Record<string, unknown>[],
): Promise<{ decision: AiDecision | null; error?: string; detail?: string }> {
  const phase = state.phase as Phase;
  const role = String(ai.role ?? "villager");
  const roundNo = Number(state.round_no ?? 1);
  const memberId = String(ai.id ?? ai.seat_no ?? "ai");
  const delayMs = aiThinkDelayMs(memberId, phase, roundNo);
  const nextThinkAt = isoAfter(new Date().toISOString(), aiThinkCooldownMs(memberId, phase, roundNo));
  const nextSpeakAt = phase === "day" ? isoAfter(new Date().toISOString(), aiSpeakCooldownMs(memberId, roundNo)) : null;

  try {
    const prompt = await buildExternalAiPrompt(sql, gameId, ai, state, targets);
    const result = await requestAiJsonObjectWithDiagnostics(prompt);
    if (!result.ok) return { decision: null, error: result.error, detail: result.detail };

    const decision = normalizeExternalAiDecision(result.object, role, phase, targets);
    if (!decision) {
      console.warn("AI provider returned an illegal game decision", {
        provider: result.provider,
        model: result.model,
        game_id: gameId,
        phase,
        role,
        seat_no: ai.seat_no,
        payload: result.object,
      });
      return { decision: null, error: "illegal_decision", detail: JSON.stringify(result.object).slice(0, 500) };
    }

    return { decision: {
      ...decision,
      delay_ms: delayMs,
      priority: phase === "day" ? 3 : 5,
      next_think_at: nextThinkAt,
      next_speak_at: phase === "day" ? nextSpeakAt : null,
      cooldowns: phase === "day"
        ? { think: nextThinkAt, speak: nextSpeakAt }
        : { think: nextThinkAt, action: nextThinkAt },
      reasoning_state: decision.reasoning_state ?? `External AI decision via ${result.provider}.`,
      suspicion_map: {},
      source: "external_ai",
    } };
  } catch (error) {
    console.warn("External AI decision pipeline failed", {
      game_id: gameId,
      phase,
      role,
      seat_no: ai.seat_no,
      error: error instanceof Error ? error.message : "unknown",
    });
    return { decision: null, error: "pipeline_error" };
  }
}

async function buildExternalAiPrompt(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  targets: Record<string, unknown>[],
): Promise<AiChatMessage[]> {
  const phase = state.phase as Phase;
  const role = String(ai.role ?? "villager");
  const seatNo = Number(ai.seat_no);
  const roundNo = Number(state.round_no ?? 1);
  const aliveSeats = [seatNo, ...targets.map((target) => Number(target.seat_no)).filter(Number.isFinite)].sort((a, b) => a - b);
  const wolfSeats = role === "wolf" ? await visibleWolfSeats(sql, gameId) : [];
  const seerChecks = role === "seer" ? await visibleSeerChecks(sql, gameId, seatNo) : [];
  const recentPublic = await recentVisiblePublicMessages(sql, gameId);
  const recentWolf = role === "wolf" ? await recentVisibleWolfMessages(sql, gameId) : [];
  const recentEvents = await recentVisibleGameEvents(sql, gameId);
  const selfHistory = await recentSelfAiActions(sql, gameId, String(ai.id ?? ""));

  const system = [
    "You are an AI player in a Werewolf social deduction game.",
    "Act like a real human at the table: concise, strategic, imperfect, and phase-appropriate.",
    "Never reveal hidden information you do not legitimately know.",
    "Base decisions on visible chat, visible events, your own previous actions, your role, and your faction win condition.",
    "Make your own read from the context. No database suspicion score is provided or authoritative.",
    "Do not use percentages, formal proofs, or mechanical if/then chains.",
    "Separate public speech, wolf private coordination, and private reasoning. content is public chat only; private_content is wolf-channel chat only; reasoning_state is never shown as table talk.",
    "Return only one valid JSON object. No markdown. No extra text.",
    "JSON schema:",
    '{"action":"speak|vote|skill|pass|observe","skill":"wolf_kill|seer_check|witch_heal|witch_poison|pass|null","target":number|null,"content":"public chat only","private_content":"wolf private chat only or empty","reasoning_state":"short private reason"}',
    "Rules: night wolves use wolf_kill, seer uses seer_check, witch may use witch_heal/witch_poison/pass. Vote phase uses vote. Day phase uses speak; when asked for a day action, add one concrete table read.",
    "For vote and required night skills, target is required and must be one number from legal_targets. Do not put the target only in reasoning_state.",
    "For night and vote, public content should be an empty string. For day, content should sound like table chat under 140 characters.",
    "If you are a wolf, use private_content to coordinate target, pressure, or vote timing with teammates without exposing the team in public.",
    "Natural speech examples: \"Seat 4 keeps dodging the vote trail.\" \"I do not like how fast Seat 5 followed that push.\"",
  ].join("\n");

  const user = {
    phase,
    round_no: roundNo,
    self: {
      seat_no: seatNo,
      role,
      personality: ai.ai_personality ?? "balanced",
      ai_name: ai.ai_name ?? null,
    },
    alive_seats: aliveSeats,
    legal_targets: legalTargetSeats(role, phase, targets),
    role_goal: roleGoal(role),
    known_private_info: {
      wolf_teammates: wolfSeats.filter((seat) => seat !== seatNo),
      seer_checks: seerChecks,
      recent_wolf_messages: recentWolf,
    },
    own_previous_actions: selfHistory,
    recent_public_messages: recentPublic,
    recent_public_events: recentEvents,
    instruction: phase === "vote"
      ? "Choose your vote now from the table context. Return action='vote' and target as exactly one legal_targets number unless you intentionally abstain. Wolves should consider recent_wolf_messages but may disagree if the table changed."
      : "Choose your next action from the table context. During day, speak with one concrete read or question. Use only legal_targets for target unless target is null.",
  };

  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(user) },
  ];
}

function normalizeExternalAiDecision(
  raw: Record<string, unknown>,
  role: string,
  phase: Phase,
  targets: Record<string, unknown>[],
): AiDecision | null {
  const legalTargets = new Set(legalTargetSeats(role, phase, targets));
  const action = lowerString(raw.action ?? raw.action_type ?? raw.intent);
  const skill = lowerString(raw.skill ?? raw.ability);
  const target = aiTargetFromPayload(raw, legalTargets);
  const safeTarget = target !== null && legalTargets.has(target) ? target : null;
  const reasoning = stringValue(raw.reasoning_state ?? raw.private_reason ?? raw.reason).slice(0, 240) || "External AI decision.";
  const content = stringValue(raw.content ?? raw.public_message ?? raw.message).trim().slice(0, 220);
  const privateContent = role === "wolf"
    ? wolfPrivateContent(raw, phase, safeTarget)
    : undefined;
  const passIntent = isPassIntent(action) || isPassIntent(skill);

  if (phase === "night") {
    if (role === "wolf") {
      if (passIntent) return { action: "skill", skill: "pass", target: null, private_content: privateContent, reasoning_state: reasoning };
      if (safeTarget === null) return null;
      return { action: "skill", skill: "wolf_kill", target: safeTarget, private_content: privateContent, reasoning_state: reasoning };
    }
    if (role === "seer") {
      if (passIntent) return { action: "skill", skill: "pass", target: null, reasoning_state: reasoning };
      if (safeTarget === null) return null;
      return { action: "skill", skill: "seer_check", target: safeTarget, reasoning_state: reasoning };
    }
    if (role === "witch") {
      const witchSkill = skill === "witch_heal" || skill === "witch_poison" ? skill : "pass";
      return { action: "skill", skill: witchSkill, target: witchSkill === "pass" ? null : safeTarget, reasoning_state: reasoning };
    }
    return { action: "pass", target: null, reasoning_state: reasoning };
  }

  if (phase === "vote") {
    if (passIntent) return { action: "vote", target: null, private_content: privateContent, reasoning_state: reasoning };
    if (safeTarget === null) return null;
    return { action: "vote", target: safeTarget, private_content: privateContent, reasoning_state: reasoning };
  }

  if (phase === "day") {
    const speech = naturalPublicSpeech(content, safeTarget);
    return {
      action: "speak",
      behavior: "question",
      channel: "public",
      target: safeTarget,
      content: speech,
      private_content: privateContent,
      reasoning_state: reasoning,
    };
  }

  return null;
}

async function recentSelfAiActions(sql: SqlExecutor, gameId: string, actorMemberId: string) {
  if (!actorMemberId) return [];
  const rows = await sql`
    select payload
    from public.game_events
    where game_id = ${gameId}
      and actor_member_id = ${actorMemberId}
      and event_type = 'ai_action_submitted'
    order by id desc
    limit 10
  `;
  return rows.slice().reverse().map((row) => {
    const payload = asRecord(row.payload);
    return {
      phase: payload.phase,
      round_no: payload.round_no,
      action_type: payload.action_type,
      target: payload.target_seat_no,
      public_content: typeof payload.content === "string" ? payload.content.slice(0, 160) : "",
      private_content: typeof payload.private_content === "string" ? payload.private_content.slice(0, 160) : "",
      private_reason: typeof payload.reasoning_state === "string" ? payload.reasoning_state.slice(0, 160) : "",
    };
  });
}

function roleGoal(role: string): string {
  if (role === "wolf") return "Help wolves survive and remove non-wolves without exposing yourself.";
  if (role === "seer") return "Use checks to identify wolves, then push votes without revealing more than needed.";
  if (role === "witch") return "Use potion choices to preserve villagers or remove likely wolves when the table state supports it.";
  if (role === "hunter") return "Stay alive when possible and make your pressure useful if you are threatened.";
  return "Find and execute wolves using public claims, votes, deaths, and contradictions.";
}

function aiTargetFromPayload(raw: Record<string, unknown>, legalTargets: Set<number>): number | null {
  const aliases = [
    raw.target_seat_no,
    raw.target,
    raw.target_seat,
    raw.targetSeatNo,
    raw.targetSeat,
    raw.vote_target,
    raw.vote_target_seat_no,
    raw.skill_target,
    raw.kill_target,
    raw.check_target,
    raw.seat_no,
  ];
  for (const value of aliases) {
    const target = numberOrNull(value);
    if (target !== null && legalTargets.has(target)) return target;
  }

  const text = [
    raw.content,
    raw.reasoning_state,
    raw.reason,
    raw.private_reason,
    raw.private_content,
    raw.private_message,
    raw.wolf_message,
    raw.team_message,
    raw.explanation,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");

  const patterns = [
    /\b(?:vote|voting|target|targeting|execute|executing|eliminate|eliminating|kill|checking|check|investigate|investigating|test|testing|pressure|suspect|suspecting)\s+(?:seat\s*#?\s*)?(\d{1,2})(?:'s)?\b/gi,
    /\bseat\s*#?\s*(\d{1,2})(?:'s)?\b/gi,
    /\b(\d{1,2})(?:'s)?\s+(?:reliability|aggression|silence|behavior|behaviour|claim|vote|wagon|case|pressure|suspicion|read)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const target = numberOrNull(match[1]);
      if (target !== null && legalTargets.has(target)) return target;
    }
  }

  return null;
}

function lowerString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function naturalPublicSpeech(content: string, target: number | null): string {
  const cleaned = content.replace(/\s+/g, " ").trim();
  const privateLeak = /\b(\d+%|probab|confidence|if .* if |win condition|reliable witness|private reason|reasoning|target_seat_no)\b/i.test(cleaned);
  if (cleaned && !privateLeak) return cleaned.slice(0, 180);
  return target
    ? `Seat ${target}, your vote line does not add up. I want a direct answer before we move.`
    : "I need cleaner vote reasons from everyone before we lock this in.";
}

function wolfPrivateContent(raw: Record<string, unknown>, phase: Phase, target: number | null): string | undefined {
  const cleaned = stringValue(raw.private_content ?? raw.private_message ?? raw.wolf_message ?? raw.team_message)
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) return cleaned.slice(0, 220);
  return wolfPrivateFallbackLine(phase, target);
}

function wolfPrivateFallbackLine(phase: Phase, target: number | null): string | undefined {
  if (target === null || target === undefined) return undefined;
  if (phase === "night") return `I lean Seat ${target} for the kill. Push back now if that exposes us.`;
  if (phase === "vote") return `I can land my vote on Seat ${target}. Keep public reasons separate.`;
  if (phase === "day") return `I can keep pressure near Seat ${target} without hard-linking us.`;
  return undefined;
}

function isPassIntent(value: string): boolean {
  return ["pass", "abstain", "skip", "none", "no_action", "no action", "observe", "wait"].includes(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function legalTargetSeats(role: string, phase: Phase, targets: Record<string, unknown>[]): number[] {
  if (phase === "night" && role === "wolf") {
    return targets
      .filter((target) => target.role !== "wolf")
      .map((target) => Number(target.seat_no))
      .filter(Number.isFinite);
  }
  if (phase === "night" && role !== "seer" && role !== "witch") return [];
  return targets.map((target) => Number(target.seat_no)).filter(Number.isFinite);
}

async function visibleWolfSeats(sql: SqlExecutor, gameId: string): Promise<number[]> {
  const rows = await sql`
    select gm.seat_no
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gmp.role = 'wolf'
      and gms.alive = true
    order by gm.seat_no asc
  `;
  return rows.map((row) => Number(row.seat_no)).filter(Number.isFinite);
}

async function visibleSeerChecks(sql: SqlExecutor, gameId: string, seatNo: number) {
  const rows = await sql`
    select payload
    from public.game_events
    where game_id = ${gameId}
      and event_type = 'night_resolved'
    order by id desc
    limit 8
  `;
  const checks: Record<string, unknown>[] = [];
  for (const row of rows) {
    const payload = asRecord(row.payload);
    const results = Array.isArray(payload.seer_results) ? payload.seer_results : [];
    for (const item of results) {
      const result = asRecord(item);
      if (Number(result.actor_seat) !== seatNo) continue;
      checks.push({
        target_seat: result.target_seat,
        is_wolf: result.is_wolf === true,
      });
    }
  }
  return checks.slice(0, 6);
}

async function recentVisiblePublicMessages(sql: SqlExecutor, gameId: string) {
  const rows = await sql`
    select m.seat_no, m.content, c.name as channel
    from public.messages m
    join public.channels c on c.id = m.channel_id
    where m.game_id = ${gameId}
      and c.name in ('public', 'system')
    order by m.id desc
    limit 16
  `;
  return rows.slice().reverse().map((row) => ({
    seat_no: typeof row.seat_no === "number" ? row.seat_no : null,
    channel: row.channel,
    content: typeof row.content === "string" ? row.content.slice(0, 220) : "",
  }));
}

async function recentVisibleWolfMessages(sql: SqlExecutor, gameId: string) {
  const rows = await sql`
    select m.seat_no, m.content
    from public.messages m
    join public.channels c on c.id = m.channel_id
    where m.game_id = ${gameId}
      and c.name = 'wolf'
    order by m.id desc
    limit 12
  `;
  return rows.slice().reverse().map((row) => ({
    seat_no: typeof row.seat_no === "number" ? row.seat_no : null,
    content: typeof row.content === "string" ? row.content.slice(0, 220) : "",
  }));
}

async function recentVisibleGameEvents(sql: SqlExecutor, gameId: string) {
  const rows = await sql`
    select event_type, payload
    from public.game_events
    where game_id = ${gameId}
      and event_type in ('vote_resolved', 'night_resolved', 'phase_changed')
    order by id desc
    limit 8
  `;
  return rows.slice().reverse().map((row) => ({
    event_type: row.event_type,
    payload: publicEventPayload(row.event_type as string, asRecord(row.payload)),
  }));
}

function publicEventPayload(eventType: string, payload: Record<string, unknown>) {
  if (eventType === "night_resolved") {
    return {
      round_no: payload.round_no,
      killed_seats: payload.killed_seats,
      summary: asRecord(payload.explanation).summary,
    };
  }
  if (eventType === "vote_resolved") {
    return {
      round_no: payload.round_no,
      eliminated_seat: payload.eliminated_seat,
      vote_detail: payload.vote_detail,
      result: payload.result,
    };
  }
  return {
    phase: payload.phase,
    round_no: payload.round_no,
  };
}

async function buildAiSocialMemory(
  sql: SqlExecutor,
  gameId: string,
  ai: Record<string, unknown>,
  state: Record<string, unknown>,
  targets: Record<string, unknown>[],
) {
  const seatNo = ai.seat_no as number;
  const suspicionMap: Record<string, number> = {};
  for (const target of targets) {
    const targetSeat = target.seat_no as number;
    suspicionMap[String(targetSeat)] = 0.2;
  }

  const eventRows = await sql`
    select event_type, payload
    from public.game_events
    where game_id = ${gameId}
      and event_type in ('vote_resolved', 'night_resolved', 'ai_action_submitted', 'phase_changed')
    order by id desc
    limit 20
  `;
  const interactionHistory: Record<string, unknown>[] = [];
  const votingHistory: Record<string, unknown>[] = [];
  const recentDeaths: Record<string, unknown>[] = [];
  const seerKnownWolves: number[] = [];
  const seerKnownVillagers: number[] = [];
  const seerCheckedSeats: number[] = [];
  let lastSpeakingTarget: number | null = null;
  let selfPressure = 0;

  for (const event of eventRows) {
    const payload = asRecord(event.payload);
    if (event.event_type === "vote_resolved" && Array.isArray(payload.vote_detail)) {
      for (const vote of payload.vote_detail) {
        const detail = asRecord(vote);
        const voter = Number(detail.voter_seat);
        const target = detail.target_seat === null || detail.target_seat === undefined ? null : Number(detail.target_seat);
        votingHistory.push({ voter_seat: voter, target_seat: target, round_no: payload.round_no });
        if (target === seatNo) selfPressure += 0.18;
        if (target !== null && target !== seatNo && suspicionMap[String(target)] !== undefined) {
          suspicionMap[String(target)] += voter === seatNo ? 0.04 : 0.08;
        }
      }
    }
    if (event.event_type === "night_resolved") {
      const killedSeats = Array.isArray(payload.killed_seats) ? payload.killed_seats.map(Number).filter(Number.isFinite) : [];
      for (const killedSeat of killedSeats) recentDeaths.push({ seat_no: killedSeat, round_no: payload.round_no });
      const seerResults = Array.isArray(payload.seer_results) ? payload.seer_results : [];
      for (const result of seerResults) {
        const detail = asRecord(result);
        if (Number(detail.actor_seat) !== seatNo) continue;
        const checkedSeat = Number(detail.target_seat);
        if (!Number.isFinite(checkedSeat)) continue;
        seerCheckedSeats.push(checkedSeat);
        if (detail.is_wolf === true) seerKnownWolves.push(checkedSeat);
        else seerKnownVillagers.push(checkedSeat);
      }
    }
    if (event.event_type === "ai_action_submitted") {
      const target = Number(payload.target_seat_no);
      if (Number.isFinite(target)) lastSpeakingTarget = target;
      interactionHistory.push(payload);
    }
  }

  const messageRows = await sql`
    select m.id, m.seat_no, m.content, m.created_at, c.name as channel, gm.is_ai
    from public.messages
    join public.channels c on c.id = m.channel_id
    left join public.game_members gm on gm.id = m.sender_member_id
    where m.game_id = ${gameId}
      and c.name in ('public', 'system')
      and m.created_at >= now() - interval '30 minutes'
    order by m.id desc
    limit 50
  `;
  const publicMessages = messageRows.slice().reverse().map((message) => ({
    id: message.id as number,
    seat_no: typeof message.seat_no === "number" ? message.seat_no as number : null,
    content: typeof message.content === "string" ? message.content as string : "",
    channel: message.channel as string,
    created_at: message.created_at as string,
    is_ai: message.is_ai === true,
  }));
  const directMentions: Record<string, unknown>[] = [];
  const previousAccusations: Record<string, unknown>[] = [];
  let ownSpeechCount = 0;
  let latestAccuser: number | null = null;
  let targetLastMessage: Record<string, unknown> | null = null;

  for (const message of publicMessages) {
    const content = typeof message.content === "string" ? message.content : "";
    const lower = content.toLowerCase();
    if (message.seat_no === seatNo) ownSpeechCount += 1;
    for (const key of Object.keys(suspicionMap)) {
      if (!lower.includes(`seat ${key}`)) continue;
      const accusationWeight = /\b(wolf|suspicious|lying|fake|push|pressure|vote|execute|claim|rehearsed)\b/i.test(content) ? 0.08 : 0.04;
      suspicionMap[key] += accusationWeight;
      previousAccusations.push({
        from_seat: message.seat_no,
        target_seat: Number(key),
        content: content.slice(0, 180),
      });
    }
    if (message.seat_no === seatNo) continue;
    if (lower.includes(`seat ${seatNo}`)) {
      selfPressure += /\b(wolf|suspicious|lying|fake|vote|execute)\b/i.test(content) ? 0.16 : 0.08;
      latestAccuser = message.seat_no;
      directMentions.push({
        from_seat: message.seat_no,
        content: content.slice(0, 220),
        channel: message.channel,
      });
    }
    if (memorySeat(message) !== null && suspicionMap[String(memorySeat(message))] !== undefined) {
      targetLastMessage = { seat_no: message.seat_no, content: content.slice(0, 220) };
    }
  }

  const currentWolfActionRows = await sql`
    select ga.target_seat_no
    from public.game_actions ga
    join public.game_members gm on gm.id = ga.actor_member_id
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    where ga.game_id = ${gameId}
      and ga.phase = 'night'
      and ga.round_no = ${state.round_no}
      and ga.action_type = 'wolf_kill'
      and ga.resolved_at is null
      and gmp.role = 'wolf'
      and ga.target_seat_no is not null
    order by ga.locked_at desc nulls last
    limit 5
  `;
  const currentWolfKillTarget = mostCommon(currentWolfActionRows.map((row) => row.target_seat_no as number));
  const nonWolfTargets = targets.filter((target) => target.role !== "wolf");
  const fallbackWolfTarget = nonWolfTargets.length
    ? nonWolfTargets[stableNumber(`${gameId}:wolf-strategy:${state.phase}:${state.round_no}`, 0, nonWolfTargets.length - 1)].seat_no as number
    : null;

  if (Array.isArray(seerKnownWolves)) {
    for (const wolfSeat of seerKnownWolves) {
      if (suspicionMap[String(wolfSeat)] !== undefined) suspicionMap[String(wolfSeat)] = Math.max(suspicionMap[String(wolfSeat)], 0.92);
    }
  }
  for (const villagerSeat of seerKnownVillagers) {
    if (suspicionMap[String(villagerSeat)] !== undefined) suspicionMap[String(villagerSeat)] = Math.min(suspicionMap[String(villagerSeat)], 0.18);
  }

  for (const key of Object.keys(suspicionMap)) {
    suspicionMap[key] = Math.max(0, Math.min(1, Number(suspicionMap[key].toFixed(2))));
  }
  const ranked = Object.entries(suspicionMap).sort((a, b) => b[1] - a[1]);

  return {
    suspicion_map: suspicionMap,
    interaction_history: interactionHistory.slice(0, 8),
    voting_history: votingHistory.slice(0, 12),
    recent_votes: votingHistory.slice(0, 12),
    recent_deaths: recentDeaths.slice(0, 8),
    public_messages: publicMessages.slice(-12),
    previous_accusations: previousAccusations.slice(-12),
    direct_mentions: directMentions.slice(-6),
    last_speaking_target: lastSpeakingTarget,
    lastSpeakingTarget,
    latest_accuser: latestAccuser,
    target_last_message: targetLastMessage,
    suggestedTarget: ranked[0] ? Number(ranked[0][0]) : null,
    self_preservation_score: Math.max(0, Math.min(1, Number(selfPressure.toFixed(2)))),
    own_speech_count: ownSpeechCount,
    wolf_shared_target: typeof ai.hidden_target_seat_no === "number"
      ? ai.hidden_target_seat_no as number
      : currentWolfKillTarget ?? fallbackWolfTarget,
    seer_known_wolves: [...new Set(seerKnownWolves)],
    seer_known_villagers: [...new Set(seerKnownVillagers)],
    seer_checked_seats: [...new Set(seerCheckedSeats)],
    current_wolf_kill_target: currentWolfKillTarget,
    phase: state.phase,
    round_no: state.round_no,
  };
}

function memorySeat(message: { seat_no: number | null }): number | null {
  return typeof message.seat_no === "number" ? message.seat_no : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function chooseConversationBehavior(
  role: string,
  confidence: number,
  memory: Record<string, any>,
  target: number | null,
  hardSeerFinding: boolean,
  hunterAtRisk: boolean,
): ConversationBehavior {
  if (hardSeerFinding) return "challenge";
  if (hunterAtRisk) return "defend";
  if (memory.direct_mentions.length) return memory.self_preservation_score >= 0.2 ? "defend" : "reply";
  if (role === "wolf" && target !== null) return confidence >= 0.48 ? "build_coalition" : "agree";
  if (confidence >= 0.68) return "challenge";
  if (memory.previous_accusations.some((item: Record<string, unknown>) => item.target_seat === target)) return "agree";
  if (confidence >= 0.48) return "question";
  return "reply";
}

function aiLine(
  personality: string,
  role: string,
  target: number | null,
  behavior: ConversationBehavior,
  confidence: number,
  memory: Record<string, any>,
): string {
  const seat = target ? `Seat ${target}` : "someone quiet";
  const lastMention = memory.direct_mentions.at(-1);
  const accuser = typeof lastMention?.from_seat === "number" ? `Seat ${lastMention.from_seat}` : "that push";
  const voteReference = memory.recent_votes.length
    ? `The last vote pattern still matters here.`
    : `We need a vote line, not just vibes.`;
  const deathReference = memory.recent_deaths.length
    ? `After the last death, I want cleaner links.`
    : `No death data clears anyone yet.`;

  if (role === "seer" && memory.seer_known_wolves.length) {
    return `I am putting a hard claim on Seat ${memory.seer_known_wolves[0]}. Treat my vote there as locked unless someone counterclaims clearly.`;
  }
  if (role === "seer" && memory.seer_known_villagers.includes(target)) {
    return `${seat} should not be today's execution from my information. Move pressure elsewhere and explain the vote trail.`;
  }
  if (role === "hunter" && behavior === "defend") {
    return `${accuser}, do not turn this into an easy execution. If I go down, my read points back through the people forcing this wagon.`;
  }
  if (behavior === "reply") {
    return `${accuser}, I read your point. What matters is whether ${seat} can explain the gap between their message and their vote.`;
  }
  if (behavior === "defend") {
    return `${accuser}, that case skips context. My pressure has been on consistency; answer why ${seat} benefits from that confusion.`;
  }
  if (behavior === "challenge") {
    return `${seat}, give a direct answer now. ${voteReference} Your last position does not match the pressure you are asking us to follow.`;
  }
  if (behavior === "agree") {
    return `I agree with the pressure on ${seat}, but I want one more response before this becomes automatic. ${deathReference}`;
  }
  if (behavior === "question") {
    return `${seat}, who is your second suspect and why? A single target without a backup read is too easy to fake.`;
  }
  if (behavior === "build_coalition") {
    if (personality === "deceptive") return `I can vote ${seat} with others, but I want the wagon built from reasons, not panic. Who joins that line?`;
    return `I want two more seats to commit on ${seat}. The case is there, but split pressure lets wolves hide.`;
  }
  if (personality === "aggressive") return `${seat} is where I want pressure. Stop circling and make them answer.`;
  if (personality === "logical") return `The timing points toward ${seat}. Compare the message order with the votes before we move.`;
  if (personality === "chaotic") return `I do not buy the clean stories yet. ${seat} feels too prepared for this table.`;
  return `I am watching ${seat}, but I am not forcing the room there without another answer.`;
}

async function recordEvent(
  sql: SqlExecutor,
  gameId: string,
  actorMemberId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
) {
  await sql`
    insert into public.game_events (game_id, actor_member_id, event_type, payload)
    values (${gameId}, ${actorMemberId}, ${eventType}, ${sql.json(payload)})
  `;
}

async function roomIdForGame(sql: SqlExecutor, gameId: string): Promise<string> {
  const rows = await sql`select room_id from public.games where id = ${gameId}`;
  if (!rows[0]) throw new HttpError(404, "Game not found.");
  return rows[0].room_id as string;
}

async function insertSystemMessage(sql: SqlExecutor, roomId: string, gameId: string, content: string) {
  const channelId = await ensureChannel(sql, roomId, gameId, "system");
  await sql`
    insert into public.messages (room_id, game_id, channel_id, content, metadata)
    values (${roomId}, ${gameId}, ${channelId}, ${content}, ${sql.json({ system: true })})
  `;
}
