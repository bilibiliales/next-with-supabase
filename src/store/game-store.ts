"use client";

import { create } from "zustand";
import { getSupabase } from "../services/supabase-client";
import { errorMessage, wolfApi } from "../services/wolf-api";
import type {
  ChannelName,
  GameMessage,
  GameSnapshot,
  PrivateSkillResult,
  RoomSnapshot,
  Snapshot,
} from "../types/wolf";
import { isGameSnapshot } from "../types/wolf";

type GameState = {
  snapshot: GameSnapshot | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  privateResult: PrivateSkillResult | null;
  setSnapshot: (snapshot: GameSnapshot | null) => void;
  addMessage: (message: GameMessage) => void;
  clear: () => void;
  reconnect: (input: { room_id?: string; game_id?: string }) => Promise<Snapshot | null>;
  sendMessage: (roomId: string, channel: ChannelName, content: string) => Promise<boolean>;
  submitVote: (gameId: string, targetSeatNo: number | null) => Promise<GameSnapshot | null>;
  submitSkill: (gameId: string, skill: string, targetSeatNo: number | null) => Promise<GameSnapshot | null>;
  setPostGameReady: (roomId: string, ready?: boolean) => Promise<Snapshot | null>;
  resetRoom: (roomId: string, force: boolean) => Promise<RoomSnapshot | null>;
};

export const useGameStore = create<GameState>((set) => {
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
    snapshot: null,
    busy: null,
    error: null,
    notice: null,
    privateResult: null,

    setSnapshot: (snapshot) => set({ snapshot }),

    addMessage: (message) => {
      set((state) => {
        const snapshot = state.snapshot;
        if (!snapshot || !snapshot.channels.includes(message.channel)) return state;
        if (snapshot.messages.some((item) => item.id === message.id)) return state;
        return {
          snapshot: {
            ...snapshot,
            messages: [...snapshot.messages, message].slice(-50),
          },
        };
      });
    },

    clear: () => set({ snapshot: null, busy: null, error: null, notice: null, privateResult: null }),

    reconnect: async (input) => {
      const snapshot = await run("reconnect", () => wolfApi.reconnect(getSupabase(), input));
      if (snapshot && isGameSnapshot(snapshot)) set({ snapshot });
      if (snapshot && !isGameSnapshot(snapshot)) set({ snapshot: null });
      return snapshot;
    },

    sendMessage: async (roomId, channel, content) => {
      const result = await run("send message", () => wolfApi.postMessage(getSupabase(), roomId, channel, content));
      if (!result) return false;
      set((state) => {
        const snapshot = state.snapshot;
        if (!snapshot || snapshot.messages.some((item) => item.id === result.message.id)) return state;
        return {
          snapshot: {
            ...snapshot,
            messages: [...snapshot.messages, result.message].slice(-50),
          },
        };
      });
      return true;
    },

    submitVote: async (gameId, targetSeatNo) => {
      const result = await run("submit vote", () => wolfApi.submitVote(getSupabase(), gameId, targetSeatNo));
      if (!result) return null;
      set({ snapshot: result.snapshot, notice: "Vote submitted." });
      return result.snapshot;
    },

    submitSkill: async (gameId, skill, targetSeatNo) => {
      const result = await run("submit skill", () => wolfApi.submitSkill(getSupabase(), gameId, skill, targetSeatNo));
      if (!result) return null;
      const notice = result.private_result
        ? `Seat ${result.private_result.target_seat_no} is ${result.private_result.is_wolf ? "a wolf" : "not a wolf"}.`
        : "Action submitted.";
      set({ snapshot: result.snapshot, privateResult: result.private_result, notice });
      return result.snapshot;
    },

    setPostGameReady: async (roomId, ready = true) => {
      const snapshot = await run("post-game ready", () => wolfApi.setPostGameReady(getSupabase(), roomId, ready));
      if (snapshot && isGameSnapshot(snapshot)) set({ snapshot });
      return snapshot;
    },

    resetRoom: async (roomId, force) => {
      return await run("reset room", () => wolfApi.resetRoom(getSupabase(), roomId, force));
    },
  };
});
