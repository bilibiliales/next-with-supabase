"use client";

import type { Session } from "@supabase/supabase-js";
import { create } from "zustand";
import { validatedWolfUsername, wolfEmailFromUsername } from "../../lib/wolf/auth";
import { errorMessage } from "../services/wolf-api";
import { getSupabase, hasSupabaseEnv } from "../services/supabase-client";

type AuthState = {
  session: Session | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  signIn: (username: string, password: string) => Promise<boolean>;
  signUp: (username: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
};

let authStarted = false;
let unsubscribeAuth: (() => void) | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  ready: false,
  loading: false,
  error: null,

  init: async () => {
    if (get().ready || get().loading || authStarted) return;
    authStarted = true;

    if (!hasSupabaseEnv()) {
      set({ ready: true, loading: false });
      return;
    }

    set({ loading: true, error: null });
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      set({ session: data.session, ready: true, loading: false });

      if (!unsubscribeAuth) {
        const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
          set({ session: nextSession, ready: true, loading: false });
        });
        unsubscribeAuth = () => listener.subscription.unsubscribe();
      }
    } catch (caught) {
      set({ error: errorMessage(caught), ready: true, loading: false });
    }
  },

  signIn: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const normalizedUsername = validatedWolfUsername(username);
      const supabase = getSupabase();
      const email = wolfEmailFromUsername(normalizedUsername);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return true;
    } catch (caught) {
      set({ error: errorMessage(caught) });
      return false;
    } finally {
      set({ loading: false });
    }
  },

  signUp: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const normalizedUsername = validatedWolfUsername(username);
      const supabase = getSupabase();
      const email = wolfEmailFromUsername(normalizedUsername);
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            nickname: normalizedUsername,
            username: normalizedUsername,
          },
        },
      });
      if (error) throw error;
      return true;
    } catch (caught) {
      set({ error: errorMessage(caught) });
      return false;
    } finally {
      set({ loading: false });
    }
  },

  signOut: async () => {
    set({ loading: true, error: null });
    try {
      if (hasSupabaseEnv()) {
        await getSupabase().auth.signOut();
      }
      set({ session: null });
    } catch (caught) {
      set({ error: errorMessage(caught) });
    } finally {
      set({ loading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
