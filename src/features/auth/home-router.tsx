"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { EnvPanel } from "../../components/env-panel";
import { getSupabase, hasSupabaseEnv } from "../../services/supabase-client";
import { errorMessage, wolfApi } from "../../services/wolf-api";
import { useAuthStore } from "../../store/auth-store";
import { useGameStore } from "../../store/game-store";
import { useRoomStore } from "../../store/room-store";
import { isGameSnapshot } from "../../types/wolf";
import { SignInCard } from "./sign-in-card";

export function HomeRouter() {
  const router = useRouter();
  const session = useAuthStore((state) => state.session);
  const ready = useAuthStore((state) => state.ready);
  const init = useAuthStore((state) => state.init);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!ready || !session) return;

    let cancelled = false;

    async function routeFromReconnect() {
      setError(null);
      try {
        const snapshot = await wolfApi.reconnect(getSupabase());
        if (cancelled) return;

        if (isGameSnapshot(snapshot)) {
          useGameStore.getState().setSnapshot(snapshot);
          router.replace(`/game/${snapshot.game.id}`);
          return;
        }

        if (snapshot.room) {
          useRoomStore.getState().setSnapshot(snapshot);
          if (snapshot.room.status === "POST_GAME" && snapshot.latest_game?.id) {
            router.replace(`/game/${snapshot.latest_game.id}`);
          } else {
            router.replace(`/room/${snapshot.room.id}`);
          }
          return;
        }

        router.replace("/lobby");
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    }

    void routeFromReconnect();

    return () => {
      cancelled = true;
    };
  }, [ready, router, session]);

  if (!hasSupabaseEnv()) return <EnvPanel />;

  if (!ready) {
    return (
      <main className="center-shell">
        <div className="loader">Loading</div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="center-shell">
        <SignInCard />
      </main>
    );
  }

  return (
    <AppShell status="Reconnect">
      <section className="status-panel">
        <p className="eyebrow">Session</p>
        <h2>{error ? "Reconnect failed" : "Restoring table"}</h2>
        {error ? <p className="form-error">{error}</p> : <div className="loader">Loading</div>}
      </section>
    </AppShell>
  );
}
