"use client";

import { create } from "zustand";

type RealtimeState = {
  topics: string[];
  setTopics: (topics: string[]) => void;
  clear: () => void;
};

export const useRealtimeStore = create<RealtimeState>((set) => ({
  topics: [],
  setTopics: (topics) => set({ topics }),
  clear: () => set({ topics: [] }),
}));
