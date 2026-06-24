import type { SupabaseClient } from "@supabase/supabase-js";
import { edgeFunctionErrorMessage } from "../../lib/supabase/function-error";
import type {
  ChannelName,
  CreateRoomInput,
  FunctionEnvelope,
  GameSnapshot,
  JoinRoomInput,
  LeaveRoomResult,
  MessageResult,
  PublicRoom,
  RoomSnapshot,
  SkillResult,
  Snapshot,
  VoteResult,
} from "../types/wolf";

async function invokeFunction<T>(
  supabase: SupabaseClient,
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<FunctionEnvelope<T>>(name, { body });
  if (error) {
    const message =
      (await edgeFunctionErrorMessage(error)) ?? (error instanceof Error ? error.message : `${name} failed.`);
    throw new Error(message);
  }
  if (!data?.ok) throw new Error(data?.error ?? `${name} failed.`);
  return data.data as T;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function requestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const wolfApi = {
  reconnect(supabase: SupabaseClient, input: { room_id?: string; game_id?: string } = {}) {
    return invokeFunction<Snapshot>(supabase, "reconnect", input);
  },

  listRooms(supabase: SupabaseClient) {
    return invokeFunction<{ rooms: PublicRoom[] }>(supabase, "room_action", {
      action: "list_rooms",
    });
  },

  createRoom(supabase: SupabaseClient, input: CreateRoomInput) {
    return invokeFunction<RoomSnapshot>(supabase, "room_action", {
      action: "create_room",
      ...input,
    });
  },

  joinRoom(supabase: SupabaseClient, input: JoinRoomInput) {
    return invokeFunction<RoomSnapshot>(supabase, "room_action", {
      action: "join_room",
      ...input,
    });
  },

  roomSnapshot(supabase: SupabaseClient, roomId: string) {
    return invokeFunction<RoomSnapshot>(supabase, "room_action", {
      action: "room_snapshot",
      room_id: roomId,
    });
  },

  setReady(supabase: SupabaseClient, roomId: string, isReady: boolean) {
    return invokeFunction<RoomSnapshot>(supabase, "room_action", {
      action: "set_ready",
      room_id: roomId,
      is_ready: isReady,
    });
  },

  leaveRoom(supabase: SupabaseClient, roomId: string) {
    return invokeFunction<LeaveRoomResult>(supabase, "room_action", {
      action: "leave_room",
      room_id: roomId,
    });
  },

  startGame(supabase: SupabaseClient, roomId: string) {
    return invokeFunction<GameSnapshot>(supabase, "start_game", {
      room_id: roomId,
    });
  },

  setPostGameReady(supabase: SupabaseClient, roomId: string, ready = true) {
    return invokeFunction<Snapshot>(supabase, "room_action", {
      action: "set_post_game_ready",
      room_id: roomId,
      post_game_ready: ready,
    });
  },

  resetRoom(supabase: SupabaseClient, roomId: string, force: boolean) {
    return invokeFunction<RoomSnapshot>(supabase, "room_action", {
      action: "reset_room",
      room_id: roomId,
      force,
    });
  },

  postMessage(supabase: SupabaseClient, roomId: string, channel: ChannelName, content: string) {
    return invokeFunction<MessageResult>(supabase, "post_message", {
      room_id: roomId,
      channel,
      content,
    });
  },

  submitVote(supabase: SupabaseClient, gameId: string, targetSeatNo: number | null) {
    return invokeFunction<VoteResult>(supabase, "process_vote", {
      game_id: gameId,
      request_id: requestId(),
      target_seat_no: targetSeatNo,
    });
  },

  submitSkill(supabase: SupabaseClient, gameId: string, skill: string, targetSeatNo: number | null) {
    return invokeFunction<SkillResult>(supabase, "process_skill", {
      game_id: gameId,
      request_id: requestId(),
      skill,
      target_seat_no: targetSeatNo,
    });
  },
};
