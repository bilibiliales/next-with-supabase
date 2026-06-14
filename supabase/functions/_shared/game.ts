import { HttpError, type AuthUser } from "./http.ts";
import type { SqlExecutor } from "./db.ts";

type Phase = "waiting" | "night" | "day" | "vote" | "settlement" | "ended";
type Channel = "lobby" | "public" | "wolf" | "dead" | "system";
type AiDecision = {
  action: "speak" | "vote" | "skill" | "pass";
  target?: number | null;
  content?: string;
  channel?: Channel;
  skill?: string;
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

type PhaseTransition = {
  phase: Phase;
  roundNo: number;
  winner: string | null;
  shouldAdvance: boolean;
  reason?: string;
};

const AI_PERSONALITIES = ["aggressive", "logical", "chaotic", "deceptive", "silent"] as const;
const AI_NAMES = ["Ash", "Blake", "Chen", "Devon", "Eli", "Finley", "Gray", "Hayes"];

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
    insert into public.room_members (room_id, user_id, is_ready)
    values (${room.id}, ${user.id}, true)
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
    insert into public.room_members (room_id, user_id, is_ready, left_at)
    values (${room.id}, ${user.id}, false, null)
    on conflict (room_id, user_id)
    do update set left_at = null, joined_at = now()
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

export async function resetRoom(sql: SqlExecutor, user: AuthUser, input: Record<string, unknown>) {
  const roomId = assertUuid(input.room_id, "room_id");

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
    set is_ready = (user_id = ${room.owner_id})
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

  const rooms = await sql`select status from public.rooms where id = ${roomId}`;
  if (!rooms[0]) throw new HttpError(404, "Room not found.");
  if (rooms[0].status === "LOCKED") throw new HttpError(409, "Cannot leave while the room is locked.");

  await sql`
    update public.room_members
    set left_at = now()
    where room_id = ${roomId}
      and user_id = ${user.id}
      and left_at is null
  `;

  return { room_id: roomId, left: true };
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
    select rm.user_id, rm.is_ready, rm.joined_at, p.nickname
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
  };
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

  await recordEvent(sql, gameId, null, "game_started", { room_id: roomId, player_count: totalPlayers });
  await insertSystemMessage(sql, roomId, gameId, "Game started.");

  return await gameSnapshot(sql, gameId, user.id);
}

export async function getPlayerView(sql: SqlExecutor, gameId: string, userId: string) {
  const gameRows = await sql`
    select g.*, r.status as room_status
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

  return {
    game: {
      id: game.id,
      room_id: game.room_id,
      started_at: game.started_at,
      ended_at: game.ended_at,
      winner: game.winner,
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
  };
}

export async function gameSnapshot(sql: SqlExecutor, gameId: string, userId: string) {
  return await getPlayerView(sql, gameId, userId);
}

function visibleChannels(phase: Phase, role: string, alive: boolean, roomStatus: string): Channel[] {
  const channels: Channel[] = ["system"];
  if (roomStatus === "WAITING") channels.push("lobby");
  if (phase === "day" || phase === "vote" || phase === "settlement" || phase === "ended") channels.push("public");
  if (phase === "night" && role === "wolf" && alive) channels.push("wolf");
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

  if (channel === "lobby" && room.status !== "WAITING") {
    throw new HttpError(409, "Lobby chat is closed while the game is active.");
  }
  if (channel === "public" && (!game || !["day", "vote", "settlement", "ended"].includes(game.phase))) {
    throw new HttpError(409, "Public chat is not available in this phase.");
  }
  if (channel === "wolf" && (!game || game.phase !== "night" || member?.role !== "wolf" || !member?.alive)) {
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

  const ai = options.runAi === false
    ? { actions: 0, results: [] as Record<string, unknown>[] }
    : await runPendingAiTurnsForState(sql, gameId, state);

  if (!options.force && previousPhase !== "waiting" && !isDeadlineReached(state.deadline_at)) {
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
    return { phase: "day", roundNo: currentRound, winner: null, shouldAdvance: true };
  }

  if (currentPhase === "day") {
    return { phase: "vote", roundNo: currentRound, winner: null, shouldAdvance: true };
  }

  if (currentPhase === "vote") {
    await maybeResolveVote(sql, gameId, currentRound, true);
    return { phase: "settlement", roundNo: currentRound, winner: null, shouldAdvance: true };
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

async function runPendingAiTurnsForState(sql: SqlExecutor, gameId: string, state: Record<string, unknown>) {
  if (!["night", "day", "vote"].includes(state.phase as string)) {
    return { actions: 0, results: [] as Record<string, unknown>[] };
  }

  const aiRows = await pendingAiRows(sql, gameId, state);
  const results: Record<string, unknown>[] = [];
  for (const ai of aiRows) {
    results.push(await applyAiTurn(sql, gameId, ai, state));
  }

  return { actions: results.filter((result) => result.action !== "none").length, results };
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
  const activeGame = await sql`
    select g.id
    from public.games g
    where g.room_id = ${safeRoomId}
      and g.ended_at is null
    order by g.started_at desc nulls last
    limit 1
  `;
  if (activeGame[0]) return await getPlayerView(sql, activeGame[0].id, user.id);
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

async function pendingAiRows(sql: SqlExecutor, gameId: string, state: Record<string, unknown>, single = false) {
  if (single) {
    return await sql`
      select gm.*, gmp.role, gmp.ai_personality, gmp.ai_name, gms.alive
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
            and ga.phase = ${state.phase}
            and ga.round_no = ${state.round_no}
            and ga.resolved_at is null
        )
      order by random()
      limit 1
    `;
  }

  return await sql`
    select gm.*, gmp.role, gmp.ai_personality, gmp.ai_name, gms.alive
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
          and ga.phase = ${state.phase}
          and ga.round_no = ${state.round_no}
          and ga.resolved_at is null
      )
    order by random()
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
) {
  const action = await decideAiAction(sql, gameId, ai, state);
  const actorMemberId = ai.id as string;
  const roundNo = state.round_no as number;
  const actorSeatNo = ai.seat_no as number;

  if (action.action === "speak") {
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, "speak", "day", roundNo]);
    const roomRows = await sql`select room_id from public.games where id = ${gameId}`;
    const roomId = roomRows[0].room_id;
    const channelId = await ensureChannel(sql, roomId, gameId, action.channel as Channel);
    const actionResult = await upsertMemberAction(sql, gameId, actorMemberId, "speak", "day", roundNo, action.target ?? null, {
      ai: true,
      channel: action.channel,
      content: action.content,
    }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: "speak",
      phase: "day",
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: action.target ?? null,
      channel: action.channel,
    });
    if (actionResult.status === "created") {
      await sql`
        insert into public.messages (room_id, game_id, channel_id, sender_id, sender_member_id, seat_no, content, metadata)
        values (${roomId}, ${gameId}, ${channelId}, null, ${ai.id}, ${ai.seat_no}, ${action.content}, ${sql.json({ seat: ai.seat_no })})
      `;
    }
  } else if (action.action === "vote") {
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, "vote", "vote", roundNo]);
    await upsertMemberAction(sql, gameId, actorMemberId, "vote", "vote", roundNo, action.target ?? null, { ai: true }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: "vote",
      phase: "vote",
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: action.target ?? null,
    });
  } else if (action.action === "skill") {
    const actionType = action.skill ?? "pass";
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, actionType, "night", roundNo]);
    await upsertMemberAction(sql, gameId, actorMemberId, actionType, "night", roundNo, action.target ?? null, { ai: true }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: actionType,
      phase: "night",
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: action.target ?? null,
    });
  } else {
    const phase = state.phase as string;
    const requestId = await deterministicRequestId(["ai", gameId, actorMemberId, "pass", phase, roundNo]);
    await upsertMemberAction(sql, gameId, actorMemberId, "pass", phase, roundNo, null, { ai: true }, requestId);
    await recordAiActionEvent(sql, gameId, actorMemberId, requestId, {
      action_type: "pass",
      phase,
      round_no: roundNo,
      seat_no: actorSeatNo,
      target_seat_no: null,
    });
  }

  return {
    action: action.action,
    target: action.target ?? null,
    content: action.content ?? "",
    actor_member_id: ai.id,
    seat_no: ai.seat_no,
  };
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

  const aliveRows = await sql`
    select gm.id
    from public.game_members gm
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
  `;
  const voteRows = await sql`
    select ga.target_seat_no
    from public.game_actions ga
    where ga.game_id = ${gameId}
      and ga.round_no = ${roundNo}
      and ga.action_type = 'vote'
      and ga.resolved_at is null
  `;

  if (!force && voteRows.length < aliveRows.length) return false;

  const counts = new Map<number, number>();
  for (const vote of voteRows) {
    if (typeof vote.target_seat_no === "number") {
      counts.set(vote.target_seat_no, (counts.get(vote.target_seat_no) ?? 0) + 1);
    }
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const eliminatedSeat = ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])
    ? ranked[0][0]
    : null;

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

  await recordEvent(sql, gameId, null, "vote_resolved", { round_no: roundNo, eliminated_seat: eliminatedSeat, votes: Object.fromEntries(counts) });
  return true;
}

async function maybeResolveNight(sql: SqlExecutor, gameId: string, roundNo: number, force: boolean) {
  if (await hasResolutionEvent(sql, gameId, "night_resolved", roundNo)) return true;

  const eligibleRows = await sql`
    select gm.id, gmp.role
    from public.game_members gm
    join public.game_member_profiles gmp on gmp.member_id = gm.id
    join public.game_member_state gms on gms.member_id = gm.id
    where gm.game_id = ${gameId}
      and gms.alive = true
      and gmp.role in ('wolf', 'seer', 'witch')
  `;
  const actionRows = await sql`
    select ga.actor_member_id, ga.action_type, ga.target_seat_no
    from public.game_actions ga
    where ga.game_id = ${gameId}
      and ga.round_no = ${roundNo}
      and ga.phase = 'night'
      and ga.resolved_at is null
  `;

  const actorCount = new Set(actionRows.map((action) => action.actor_member_id)).size;
  if (!force && actorCount < eligibleRows.length) return false;

  const wolfTargets = actionRows
    .filter((action) => action.action_type === "wolf_kill" && typeof action.target_seat_no === "number")
    .map((action) => action.target_seat_no as number);
  const healedTargets = new Set(
    actionRows
      .filter((action) => action.action_type === "witch_heal" && typeof action.target_seat_no === "number")
      .map((action) => action.target_seat_no as number),
  );

  const killTarget = mostCommon(wolfTargets);
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

  await recordEvent(sql, gameId, null, "night_resolved", {
    round_no: roundNo,
    killed_seats: [...deathMetadata.keys()],
    death_reasons: Object.fromEntries([...deathMetadata].map(([seat, death]) => [seat, death.reason])),
    death_details: Object.fromEntries(deathMetadata),
  });
  return true;
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
  const updated = await sql`
    update public.game_state
    set phase = ${phase},
        round_no = ${roundNo},
        deadline_at = ${deadline},
        state_version = state_version + 1,
        updated_at = now()
    where game_id = ${gameId}
      and state_version = ${expectedVersion}
    returning phase, round_no, deadline_at, state_version
  `;
  if (!updated[0]) return false;

  await recordEvent(sql, gameId, null, "phase_changed", { phase, round_no: roundNo, deadline_at: deadline });
  return true;
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
  await recordEvent(sql, gameId, null, "game_ended", { winner });
  return winner;
}

async function decideAiAction(sql: SqlExecutor, gameId: string, ai: Record<string, unknown>, state: Record<string, unknown>): Promise<AiDecision> {
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

  if (phase === "day") {
    const target = targets[0]?.seat_no ?? null;
    return {
      action: "speak",
      channel: "public",
      target,
      content: aiLine(ai.ai_personality as string, target),
    };
  }

  if (phase === "vote") {
    return {
      action: "vote",
      target: targets[0]?.seat_no ?? null,
    };
  }

  if (phase === "night") {
    if (role === "wolf") {
      const nonWolf = targets.find((target) => target.role !== "wolf");
      return { action: "skill", skill: "wolf_kill", target: nonWolf?.seat_no ?? null };
    }
    if (role === "seer") {
      return { action: "skill", skill: "seer_check", target: targets[0]?.seat_no ?? null };
    }
    if (role === "witch") {
      return { action: "skill", skill: "pass", target: null };
    }
  }

  return { action: "pass", target: null };
}

function aiLine(personality: string, target: number | null): string {
  const seat = target ? `Seat ${target}` : "someone quiet";
  if (personality === "aggressive") return `${seat} is pushing too hard. I want that pressure answered.`;
  if (personality === "logical") return `The timing points toward ${seat}. I want to compare their vote with the next response.`;
  if (personality === "chaotic") return `I do not buy the clean stories yet. ${seat} feels rehearsed.`;
  if (personality === "deceptive") return `${seat} might be bait, but that is still useful pressure.`;
  return `I am watching ${seat} for now.`;
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

async function insertSystemMessage(sql: SqlExecutor, roomId: string, gameId: string, content: string) {
  const channelId = await ensureChannel(sql, roomId, gameId, "system");
  await sql`
    insert into public.messages (room_id, game_id, channel_id, content, metadata)
    values (${roomId}, ${gameId}, ${channelId}, ${content}, ${sql.json({ system: true })})
  `;
}
