"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { EnvPanel } from "../../components/env-panel";
import { FeedbackLine } from "../../components/feedback-line";
import { useAuthRequired } from "../../hooks/use-auth-required";
import { hasSupabaseEnv } from "../../services/supabase-client";
import { useRoomStore } from "../../store/room-store";

export function LobbyPage() {
  const router = useRouter();
  const { ready, session } = useAuthRequired();
  const rooms = useRoomStore((state) => state.rooms);
  const busy = useRoomStore((state) => state.busy);
  const error = useRoomStore((state) => state.error);
  const notice = useRoomStore((state) => state.notice);
  const listRooms = useRoomStore((state) => state.listRooms);
  const createRoom = useRoomStore((state) => state.createRoom);
  const joinRoom = useRoomStore((state) => state.joinRoom);

  const [name, setName] = useState("Wolf table");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [aiMode, setAiMode] = useState<"fill" | "fixed" | "none">("fill");
  const [aiCount, setAiCount] = useState(0);
  const [inviteCode, setInviteCode] = useState("");

  useEffect(() => {
    if (ready && session) void listRooms();
  }, [listRooms, ready, session]);

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const snapshot = await createRoom({
      name,
      max_players: maxPlayers,
      visibility,
      ai_mode: aiMode,
      ai_count: aiCount,
    });
    if (snapshot?.room) router.push(`/room/${snapshot.room.id}`);
  }

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const snapshot = await joinRoom({ invite_code: inviteCode.trim().toUpperCase() });
    if (snapshot?.room) router.push(`/room/${snapshot.room.id}`);
  }

  if (!hasSupabaseEnv()) return <EnvPanel />;
  if (!ready || !session) {
    return (
      <main className="center-shell">
        <div className="loader">Loading</div>
      </main>
    );
  }

  return (
    <AppShell
      status="Lobby"
      actions={
        <button className="secondary" type="button" onClick={() => void listRooms()}>
          Refresh
        </button>
      }
    >
      <div className="lobby-grid">
        <section className="panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Create</p>
              <h2>New room</h2>
            </div>
          </div>
          <form className="form-stack" onSubmit={submitCreate}>
            <label>
              Room name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
            </label>
            <div className="form-grid">
              <label>
                Seats
                <input
                  type="number"
                  min={5}
                  max={12}
                  value={maxPlayers}
                  onChange={(event) => setMaxPlayers(Number(event.target.value))}
                />
              </label>
              <label>
                AI count
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, maxPlayers - 1)}
                  value={aiCount}
                  onChange={(event) => setAiCount(Number(event.target.value))}
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Visibility
                <select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}>
                  <option value="public">Public</option>
                  <option value="private">Private</option>
                </select>
              </label>
              <label>
                AI mode
                <select value={aiMode} onChange={(event) => setAiMode(event.target.value as typeof aiMode)}>
                  <option value="fill">Fill seats</option>
                  <option value="fixed">Fixed count</option>
                  <option value="none">No AI</option>
                </select>
              </label>
            </div>
            <button disabled={Boolean(busy) || !name.trim()} type="submit">
              Create room
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Join</p>
              <h2>Invite code</h2>
            </div>
          </div>
          <form className="form-stack" onSubmit={submitInvite}>
            <label>
              Code
              <input
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                maxLength={12}
              />
            </label>
            <button disabled={Boolean(busy) || !inviteCode.trim()} type="submit">
              Join room
            </button>
          </form>
        </section>

        <section className="panel public-rooms">
          <div className="section-head">
            <div>
              <p className="eyebrow">Public rooms</p>
              <h2>Open tables</h2>
            </div>
            <span className="count-badge">{rooms.length}</span>
          </div>
          <div className="room-list">
            {rooms.length ? (
              rooms.map((room) => (
                <button
                  className="room-row"
                  key={room.id}
                  type="button"
                  onClick={async () => {
                    const snapshot = await joinRoom({ room_id: room.id });
                    if (snapshot?.room) router.push(`/room/${snapshot.room.id}`);
                  }}
                >
                  <span>
                    <strong>{room.name ?? "Untitled room"}</strong>
                    <small>{room.ai_mode} AI</small>
                  </span>
                  <span className="room-meta">
                    {room.human_count}/{room.max_players}
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">No public rooms.</div>
            )}
          </div>
        </section>
      </div>
      <FeedbackLine busy={busy} error={error} notice={notice} />
    </AppShell>
  );
}
