"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";
import { AppShell } from "../../components/app-shell";
import { EnvPanel } from "../../components/env-panel";
import { FeedbackLine } from "../../components/feedback-line";
import { useAuthRequired } from "../../hooks/use-auth-required";
import { useRealtimeSubscriptions } from "../../hooks/use-realtime-subscriptions";
import { hasSupabaseEnv } from "../../services/supabase-client";
import { useGameStore } from "../../store/game-store";
import { useRoomStore } from "../../store/room-store";
import { isGameSnapshot } from "../../types/wolf";
import { GameTable } from "./game-table";
import { ReplayPanel } from "../replay/replay-panel";

type GamePageProps = {
  gameId: string;
};

export function GamePage({ gameId }: GamePageProps) {
  const router = useRouter();
  const { ready, session } = useAuthRequired();
  const snapshot = useGameStore((state) => state.snapshot);
  const busy = useGameStore((state) => state.busy);
  const error = useGameStore((state) => state.error);
  const notice = useGameStore((state) => state.notice);
  const reconnect = useGameStore((state) => state.reconnect);
  const addMessage = useGameStore((state) => state.addMessage);
  const clearGame = useGameStore((state) => state.clear);

  const refresh = useCallback(async () => {
    const next = await reconnect({ game_id: gameId });
    if (!next) return;

    if (!isGameSnapshot(next)) {
      if (next.room) {
        useRoomStore.getState().setSnapshot(next);
        router.replace(`/room/${next.room.id}`);
      } else {
        router.replace("/lobby");
      }
    }
  }, [gameId, reconnect, router]);

  useEffect(() => {
    if (ready && session) void refresh();
  }, [ready, refresh, session]);

  useRealtimeSubscriptions({
    roomId: snapshot?.game.room_id,
    channels: snapshot?.channels ?? [],
    onRefresh: refresh,
    onMessage: addMessage,
    onRoomClosed: () => {
      clearGame();
      router.replace("/lobby");
    },
  });

  if (!hasSupabaseEnv()) return <EnvPanel />;
  if (!ready || !session || snapshot?.game.id !== gameId) {
    return (
      <AppShell status="Game">
        <section className="status-panel">
          <div className="loader">Loading</div>
        </section>
        <FeedbackLine busy={busy} error={error} notice={notice} />
      </AppShell>
    );
  }

  return (
    <AppShell
      status={snapshot.post_game ? "Post game" : `${snapshot.state.phase} / round ${snapshot.state.round_no}`}
      actions={
        <button className="secondary" type="button" onClick={() => void refresh()}>
          Reconnect
        </button>
      }
    >
      {snapshot.post_game ? <ReplayPanel snapshot={snapshot} /> : <GameTable snapshot={snapshot} />}
      <FeedbackLine busy={busy} error={error} notice={notice} />
    </AppShell>
  );
}
