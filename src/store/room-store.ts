"use client";

import { create } from "zustand";
import { getSupabase } from "../services/supabase-client";
import { errorMessage, wolfApi } from "../services/wolf-api";
import type {
  CreateRoomInput,
  JoinRoomInput,
  LeaveRoomResult,
  PublicRoom,
  RoomSnapshot,
  Snapshot,
} from "../types/wolf";
import { isGameSnapshot } from "../types/wolf";

type RoomState = {
  rooms: PublicRoom[];
  snapshot: RoomSnapshot | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  setSnapshot: (snapshot: RoomSnapshot | null) => void;
  clear: () => void;
  reconnect: (input?: { room_id?: string; game_id?: string }) => Promise<Snapshot | null>;
  listRooms: () => Promise<PublicRoom[] | null>;
  createRoom: (input: CreateRoomInput) => Promise<RoomSnapshot | null>;
  joinRoom: (input: JoinRoomInput) => Promise<RoomSnapshot | null>;
  fetchRoom: (roomId: string) => Promise<RoomSnapshot | null>;
  setReady: (roomId: string, ready: boolean) => Promise<RoomSnapshot | null>;
  leaveRoom: (roomId: string) => Promise<LeaveRoomResult | null>;
  startGame: (roomId: string) => Promise<Snapshot | null>;
  setPostGameReady: (roomId: string, ready?: boolean) => Promise<Snapshot | null>;
  resetRoom: (roomId: string, force: boolean) => Promise<RoomSnapshot | null>;
};

export const useRoomStore = create<RoomState>((set) => {
  async function run<T>(label: string, work: () => Promise<T>) {
    set({ busy: label, error: null, notice: null });
    try {
      return await work();
    } catch (caught) {
      set({ error: errorMessage(caught) });
      return null;
    } finally {
      set({ busy: null });
    }
  }

  return {
    rooms: [],
    snapshot: null,
    busy: null,
    error: null,
    notice: null,

    setSnapshot: (snapshot) => set({ snapshot }),

    clear: () => set({ rooms: [], snapshot: null, busy: null, error: null, notice: null }),

    reconnect: async (input = {}) => {
      const next = await run("reconnect", () => wolfApi.reconnect(getSupabase(), input));
      if (next && !isGameSnapshot(next)) set({ snapshot: next });
      return next;
    },

    listRooms: async () => {
      const result = await run("list rooms", () => wolfApi.listRooms(getSupabase()));
      if (!result) return null;
      set({ rooms: result.rooms });
      return result.rooms;
    },

    createRoom: async (input) => {
      const snapshot = await run("create room", () => wolfApi.createRoom(getSupabase(), input));
      if (snapshot) set({ snapshot, notice: "Room created." });
      return snapshot;
    },

    joinRoom: async (input) => {
      const snapshot = await run("join room", () => wolfApi.joinRoom(getSupabase(), input));
      if (snapshot) set({ snapshot, notice: "Joined room." });
      return snapshot;
    },

    fetchRoom: async (roomId) => {
      const snapshot = await run("room snapshot", () => wolfApi.roomSnapshot(getSupabase(), roomId));
      if (snapshot) set({ snapshot });
      return snapshot;
    },

    setReady: async (roomId, ready) => {
      const snapshot = await run("ready", () => wolfApi.setReady(getSupabase(), roomId, ready));
      if (snapshot) set({ snapshot });
      return snapshot;
    },

    leaveRoom: async (roomId) => {
      const result = await run("leave room", () => wolfApi.leaveRoom(getSupabase(), roomId));
      if (result?.left) {
        set({
          snapshot: null,
          notice: result.dissolved ? "Room closed." : "Left room.",
        });
      }
      return result;
    },

    startGame: async (roomId) => {
      return await run("start game", () => wolfApi.startGame(getSupabase(), roomId));
    },

    setPostGameReady: async (roomId, ready = true) => {
      const snapshot = await run("post-game ready", () => wolfApi.setPostGameReady(getSupabase(), roomId, ready));
      if (snapshot && !isGameSnapshot(snapshot)) set({ snapshot });
      return snapshot;
    },

    resetRoom: async (roomId, force) => {
      const snapshot = await run("reset room", () => wolfApi.resetRoom(getSupabase(), roomId, force));
      if (snapshot) set({ snapshot });
      return snapshot;
    },
  };
});
