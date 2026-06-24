import type {
  ChannelName,
  GameMessage,
  GameSnapshot,
  RoomSnapshot,
  Snapshot,
} from "../../lib/wolf/types";

export type {
  ChannelName,
  GameMessage,
  GameEvent,
  GamePhase,
  GameSnapshot,
  PostGameReady,
  RoomSnapshot,
  RoomStatus,
  Snapshot,
} from "../../lib/wolf/types";
export { isGameSnapshot } from "../../lib/wolf/types";

export type FunctionEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  details?: unknown;
};

export type PublicRoom = NonNullable<RoomSnapshot["room"]> & {
  human_count: number;
};

export type CreateRoomInput = {
  name: string;
  max_players: number;
  visibility: "public" | "private";
  ai_mode: "fill" | "fixed" | "none";
  ai_count: number;
};

export type JoinRoomInput = {
  room_id?: string;
  invite_code?: string;
};

export type LeaveRoomResult = {
  room_id: string;
  left: boolean;
  dissolved: boolean;
};

export type MessageResult = {
  room_id: string;
  topic: string;
  message: GameMessage;
};

export type VoteResult = {
  action: "vote";
  target: number | null;
  resolved: boolean;
  snapshot: GameSnapshot;
};

export type PrivateSkillResult = {
  target_seat_no: number;
  is_wolf: boolean;
};

export type SkillResult = {
  action: string;
  target: number | null;
  private_result: PrivateSkillResult | null;
  resolved: boolean;
  snapshot: GameSnapshot;
};

export type SnapshotResult = Snapshot;
