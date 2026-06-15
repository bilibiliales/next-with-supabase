export type RoomStatus = "WAITING" | "LOCKED" | "POST_GAME" | "CLOSED";
export type GamePhase = "waiting" | "night" | "day" | "vote" | "settlement" | "ended";
export type ChannelName = "lobby" | "public" | "wolf" | "dead" | "system";

export type PostGameReady = {
  active_count: number;
  ready_count: number;
  self_ready: boolean;
  all_ready: boolean;
};

export type RoomSnapshot = {
  room: {
    id: string;
    owner_id: string;
    name: string | null;
    visibility: "public" | "private";
    invite_code: string;
    max_players: number;
    ai_count: number;
    ai_mode: "fill" | "fixed" | "none";
    status: RoomStatus;
    created_at: string;
  } | null;
  members?: Array<{
    user_id: string;
    nickname: string;
    is_ready: boolean;
    post_game_ready: boolean;
    joined_at: string;
  }>;
  latest_game?: {
    id: string;
    phase?: GamePhase;
    round_no?: number;
    deadline_at?: string | null;
    winner?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
  } | null;
  post_game_ready?: PostGameReady | null;
};

export type GameMessage = {
  id: number;
  game_id: string | null;
  channel: ChannelName;
  seat_no: number | null;
  content: string;
  created_at: string;
};

export type GameSnapshot = {
  game: {
    id: string;
    room_id: string;
    winner: "wolves" | "villagers" | "draw" | null;
    started_at: string;
    ended_at: string | null;
  };
  room: {
    id: string;
    owner_id: string;
    status: RoomStatus;
  };
  state: {
    phase: GamePhase;
    round_no: number;
    deadline_at: string | null;
    state_version: number;
    updated_at: string;
  };
  self: {
    seat_no: number;
    role: "wolf" | "villager" | "seer" | "witch" | "hunter";
    alive: boolean;
  };
  seats: Array<{
    seat_no: number;
    alive: boolean;
  }>;
  channels: ChannelName[];
  messages: GameMessage[];
  post_game: null | Array<{
    seat_no: number;
    user_id: string | null;
    is_ai: boolean;
    role: string;
    alive: boolean;
    nickname: string | null;
    death_reason?: string | null;
    death_round?: number | null;
    killed_by_member_id?: string | null;
  }>;
  post_game_ready: PostGameReady | null;
};

export type Snapshot = RoomSnapshot | GameSnapshot;

export function isGameSnapshot(snapshot: Snapshot | null): snapshot is GameSnapshot {
  return Boolean(snapshot && "game" in snapshot && "state" in snapshot && "self" in snapshot);
}
