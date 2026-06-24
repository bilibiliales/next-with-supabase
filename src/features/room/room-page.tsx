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
import type { ChannelName } from "../../types/wolf";

type RoomPageProps = {
  roomId: string;
};

const ROOM_CHANNELS: ChannelName[] = ["lobby", "system"];

export function RoomPage({ roomId }: RoomPageProps) {
  const router = useRouter();
  const { ready, session } = useAuthRequired();
  const snapshot = useRoomStore((state) => state.snapshot);
  const busy = useRoomStore((state) => state.busy);
  const error = useRoomStore((state) => state.error);
  const notice = useRoomStore((state) => state.notice);
  const fetchRoom = useRoomStore((state) => state.fetchRoom);
  const setReady = useRoomStore((state) => state.setReady);
  const leaveRoom = useRoomStore((state) => state.leaveRoom);
  const startGame = useRoomStore((state) => state.startGame);
  const clearRoom = useRoomStore((state) => state.clear);

  const room = snapshot?.room?.id === roomId ? snapshot.room : null;
  const members = room ? snapshot?.members ?? [] : [];
  const selfMember = members.find((member) => member.user_id === session?.user.id);
  const isOwner = Boolean(room && session?.user.id === room.owner_id);
  const readyCount = members.filter((member) => member.is_ready).length;

  const refresh = useCallback(async () => {
    const next = await fetchRoom(roomId);
    if (!next?.room) return;
    if ((next.room.status === "LOCKED" || next.room.status === "POST_GAME") && next.latest_game?.id) {
      router.replace(`/game/${next.latest_game.id}`);
    }
  }, [fetchRoom, roomId, router]);

  useEffect(() => {
    if (ready && session) void refresh();
  }, [ready, refresh, session]);

  useRealtimeSubscriptions({
    roomId: room?.id ?? roomId,
    channels: room ? ROOM_CHANNELS : [],
    onRefresh: refresh,
    onRoomClosed: () => {
      clearRoom();
      router.replace("/lobby");
    },
  });

  async function handleStart() {
    const next = await startGame(roomId);
    if (next && "game" in next) {
      useGameStore.getState().setSnapshot(next);
      router.push(`/game/${next.game.id}`);
    }
  }

  async function handleLeave() {
    const result = await leaveRoom(roomId);
    if (result?.left) router.push("/lobby");
  }

  if (!hasSupabaseEnv()) return <EnvPanel />;
  if (!ready || !session || !room) {
    return (
      <AppShell status="Room">
        <section className="status-panel">
          <div className="loader">Loading</div>
        </section>
        <FeedbackLine busy={busy} error={error} notice={notice} />
      </AppShell>
    );
  }

  return (
    <AppShell
      status={`Room / ${room.status}`}
      actions={
        <button className="secondary" type="button" onClick={() => void refresh()}>
          Reconnect
        </button>
      }
    >
      <div className="room-grid">
        <section className="room-hero">
          <div>
            <p className="eyebrow">Room</p>
            <h1>{room.name ?? "Untitled room"}</h1>
          </div>
          <div className="hero-metrics">
            <span>
              Invite
              <strong>{room.invite_code}</strong>
            </span>
            <span>
              Humans
              <strong>
                {members.length}/{room.max_players}
              </strong>
            </span>
            <span>
              Ready
              <strong>
                {readyCount}/{members.length}
              </strong>
            </span>
          </div>
        </section>

        <section className="panel room-info">
          <p className="eyebrow">Settings</p>
          <dl className="detail-list">
            <div>
              <dt>Visibility</dt>
              <dd>{room.visibility}</dd>
            </div>
            <div>
              <dt>AI mode</dt>
              <dd>{room.ai_mode}</dd>
            </div>
            <div>
              <dt>AI count</dt>
              <dd>{room.ai_count}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{isOwner ? "You" : "Host"}</dd>
            </div>
          </dl>
          <div className="button-row">
            {isOwner ? (
              <button disabled={Boolean(busy) || room.status !== "WAITING"} type="button" onClick={handleStart}>
                Start game
              </button>
            ) : (
              <button
                disabled={Boolean(busy) || room.status !== "WAITING"}
                type="button"
                onClick={() => void setReady(roomId, !selfMember?.is_ready)}
              >
                {selfMember?.is_ready ? "Cancel ready" : "Ready"}
              </button>
            )}
            <button className="secondary" disabled={Boolean(busy)} type="button" onClick={handleLeave}>
              {isOwner ? "Close room" : "Leave room"}
            </button>
          </div>
        </section>

        <section className="panel member-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Members</p>
              <h2>Players</h2>
            </div>
            <span className="count-badge">{members.length}</span>
          </div>
          <div className="member-list">
            {members.map((member) => (
              <div className="member-row" key={member.user_id}>
                <span>
                  <strong>{member.nickname}</strong>
                  <small>{member.user_id === room.owner_id ? "Owner" : "Player"}</small>
                </span>
                <span className={member.is_ready ? "state-pill good" : "state-pill"}>{member.is_ready ? "Ready" : "Waiting"}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <FeedbackLine busy={busy} error={error} notice={notice} />
    </AppShell>
  );
}
