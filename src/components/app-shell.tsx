"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAuthStore } from "../store/auth-store";
import { useGameStore } from "../store/game-store";
import { useRealtimeStore } from "../store/realtime-store";
import { useRoomStore } from "../store/room-store";

type AppShellProps = {
  status: string;
  children: ReactNode;
  actions?: ReactNode;
};

export function AppShell({ status, children, actions }: AppShellProps) {
  const router = useRouter();
  const session = useAuthStore((state) => state.session);
  const signOut = useAuthStore((state) => state.signOut);

  async function handleSignOut() {
    await signOut();
    useRoomStore.getState().clear();
    useGameStore.getState().clear();
    useRealtimeStore.getState().clear();
    router.replace("/");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand-button" type="button" onClick={() => router.push("/")}>
          <span className="brand-mark">W</span>
          <span>
            <strong>Wolf AI</strong>
            <small>{status}</small>
          </span>
        </button>
        <div className="topbar-actions">
          {actions}
          {session ? (
            <button className="secondary" type="button" onClick={handleSignOut}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      {children}
    </main>
  );
}
