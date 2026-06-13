"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase, hasSupabaseEnv } from "../lib/supabase/client";
import type { ChannelName, GameMessage, GameSnapshot, RoomSnapshot, Snapshot } from "../lib/wolf/types";
import { isGameSnapshot } from "../lib/wolf/types";

type FunctionEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  details?: unknown;
};

type PublicRoom = NonNullable<RoomSnapshot["room"]> & {
  human_count: number;
};

const CHANNEL_LABELS: Record<ChannelName, string> = {
  lobby: "Lobby",
  public: "Public",
  wolf: "Wolf",
  dead: "Dead",
  system: "System",
};

const ROLE_LABELS: Record<string, string> = {
  wolf: "Wolf",
  villager: "Villager",
  seer: "Seer",
  witch: "Witch",
  hunter: "Hunter",
};

async function invokeFunction<T>(
  supabase: SupabaseClient,
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<FunctionEnvelope<T>>(name, { body });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? `${name} failed.`);
  return data.data as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function phaseTone(phase?: string | null) {
  if (phase === "night") return "tone-night";
  if (phase === "vote") return "tone-vote";
  if (phase === "ended") return "tone-ended";
  return "tone-day";
}

function skillOptions(role?: string) {
  if (role === "wolf") return [{ value: "wolf_kill", label: "Wolf kill" }, { value: "pass", label: "Pass" }];
  if (role === "seer") return [{ value: "seer_check", label: "Seer check" }, { value: "pass", label: "Pass" }];
  if (role === "witch") {
    return [
      { value: "witch_heal", label: "Witch heal" },
      { value: "witch_poison", label: "Witch poison" },
      { value: "pass", label: "Pass" },
    ];
  }
  return [{ value: "pass", label: "Pass" }];
}

export function GameConsole() {
  const envReady = hasSupabaseEnv();
  const supabase = useMemo(() => (envReady ? getSupabase() : null), [envReady]);
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [rooms, setRooms] = useState<PublicRoom[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roomName, setRoomName] = useState("Wolf table");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [aiCount, setAiCount] = useState(0);
  const [aiMode, setAiMode] = useState<"fill" | "fixed" | "none">("fill");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [inviteCode, setInviteCode] = useState("");
  const [chatText, setChatText] = useState("");
  const [selectedChannel, setSelectedChannel] = useState<ChannelName>("lobby");
  const [voteTarget, setVoteTarget] = useState("");
  const [skill, setSkill] = useState("pass");
  const [skillTarget, setSkillTarget] = useState("");

  const game = isGameSnapshot(snapshot) ? snapshot : null;
  const roomSnapshot = snapshot && !isGameSnapshot(snapshot) ? snapshot : null;
  const activeRoomId = game?.game.room_id ?? roomSnapshot?.room?.id ?? null;
  const activeGameId = game?.game.id ?? null;
  const availableChannels = useMemo(
    () => game?.channels ?? (roomSnapshot?.room ? (["lobby"] as ChannelName[]) : []),
    [game?.channels, roomSnapshot?.room],
  );
  const writableChannels: ChannelName[] = availableChannels.filter((channel) => channel !== "system");
  const channelsKey = availableChannels.join("|");

  const run = useCallback(
    async <T,>(label: string, work: () => Promise<T>) => {
      setBusy(label);
      setError("");
      setNotice("");
      try {
        const result = await work();
        return result;
      } catch (caught) {
        setError(errorMessage(caught));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const reconnectSnapshot = useCallback(async () => {
    if (!supabase || !session) return;
    const body = activeGameId ? { game_id: activeGameId } : activeRoomId ? { room_id: activeRoomId } : {};
    const next = await invokeFunction<Snapshot>(supabase, "reconnect", body);
    setSnapshot(next);
  }, [activeGameId, activeRoomId, session, supabase]);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) setSnapshot(null);
    });

    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!supabase || !session || snapshot) return;
    run("reconnect", reconnectSnapshot);
  }, [reconnectSnapshot, run, session, snapshot, supabase]);

  useEffect(() => {
    if (!supabase || !session?.access_token || !activeRoomId || availableChannels.length === 0) return;

    supabase.realtime.setAuth(session.access_token);
    const subscriptions = availableChannels.map((channel) =>
      supabase
        .channel(`room:${activeRoomId}:${channel}`, { config: { private: true } })
        .on("broadcast", { event: "message" }, ({ payload }) => {
          const message = payload as GameMessage;
          setSnapshot((current) => {
            if (!isGameSnapshot(current)) return current;
            if (!current.channels.includes(message.channel)) return current;
            if (current.messages.some((item) => item.id === message.id)) return current;
            return { ...current, messages: [...current.messages, message].slice(-50) };
          });
        })
        .on("broadcast", { event: "state" }, () => {
          run("reconnect", reconnectSnapshot);
        })
        .on("broadcast", { event: "room" }, () => {
          run("reconnect", reconnectSnapshot);
        })
        .subscribe(),
    );

    return () => {
      subscriptions.forEach((subscription) => {
        supabase.removeChannel(subscription);
      });
    };
  }, [activeRoomId, availableChannels, channelsKey, reconnectSnapshot, run, session?.access_token, supabase]);

  useEffect(() => {
    if (writableChannels.length > 0 && !writableChannels.includes(selectedChannel)) {
      setSelectedChannel(writableChannels[0]);
    }
  }, [selectedChannel, writableChannels]);

  useEffect(() => {
    const options = skillOptions(game?.self.role);
    if (!options.some((option) => option.value === skill)) setSkill(options[0].value);
  }, [game?.self.role, skill]);

  async function signIn() {
    if (!supabase) return;
    await run("sign-in", async () => {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      setNotice("Signed in.");
    });
  }

  async function signUp() {
    if (!supabase) return;
    await run("sign-up", async () => {
      const { error: authError } = await supabase.auth.signUp({ email, password });
      if (authError) throw authError;
      setNotice("Account created. Sign in if the session did not start automatically.");
    });
  }

  async function signOut() {
    if (!supabase) return;
    await run("sign-out", async () => {
      await supabase.auth.signOut();
      setSnapshot(null);
      setRooms([]);
    });
  }

  async function createRoom() {
    if (!supabase) return;
    const next = await run("create-room", () =>
      invokeFunction<RoomSnapshot>(supabase, "room_action", {
        action: "create_room",
        name: roomName,
        max_players: maxPlayers,
        ai_count: aiCount,
        ai_mode: aiMode,
        visibility,
      }),
    );
    if (next) setSnapshot(next);
  }

  async function joinRoom(roomId?: string) {
    if (!supabase) return;
    const next = await run("join-room", () =>
      invokeFunction<RoomSnapshot>(supabase, "room_action", {
        action: "join_room",
        room_id: roomId,
        invite_code: roomId ? undefined : inviteCode,
      }),
    );
    if (next) setSnapshot(next);
  }

  async function listPublicRooms() {
    if (!supabase) return;
    const result = await run("list-rooms", () =>
      invokeFunction<{ rooms: PublicRoom[] }>(supabase, "room_action", { action: "list_rooms" }),
    );
    if (result) setRooms(result.rooms);
  }

  async function setReady(isReady: boolean) {
    if (!supabase || !activeRoomId) return;
    const next = await run("ready", () =>
      invokeFunction<RoomSnapshot>(supabase, "room_action", {
        action: "set_ready",
        room_id: activeRoomId,
        is_ready: isReady,
      }),
    );
    if (next) setSnapshot(next);
  }

  async function startGame() {
    if (!supabase || !activeRoomId) return;
    const next = await run("start-game", () =>
      invokeFunction<GameSnapshot>(supabase, "start_game", { room_id: activeRoomId }),
    );
    if (next) setSnapshot(next);
  }

  async function serverAction(functionName: string, body: Record<string, unknown>) {
    if (!supabase) return;
    const result = await run(functionName, () => invokeFunction<any>(supabase, functionName, body));
    const next = result?.snapshot ?? result;
    if (next && ("game" in next || "room" in next)) setSnapshot(next);
    if (result?.private_result) {
      setNotice(`Private result: target is ${result.private_result.is_wolf ? "wolf" : "not wolf"}.`);
    }
  }

  async function sendMessage() {
    if (!supabase || !activeRoomId || !chatText.trim()) return;
    const result = await run("post-message", () =>
      invokeFunction<{ message: GameMessage }>(supabase, "post_message", {
        room_id: activeRoomId,
        channel: selectedChannel,
        content: chatText,
      }),
    );
    if (result) {
      setChatText("");
      setSnapshot((current) => {
        if (!isGameSnapshot(current)) return current;
        if (current.messages.some((item) => item.id === result.message.id)) return current;
        return { ...current, messages: [...current.messages, result.message].slice(-50) };
      });
    }
  }

  const statusText = game
    ? `${game.state.phase.toUpperCase()} / Round ${game.state.round_no}`
    : roomSnapshot?.room
      ? `${roomSnapshot.room.status} / ${roomSnapshot.members?.length ?? 0} humans`
      : "No active room";

  if (!envReady) {
    return (
      <main className="app-shell compact">
        <section className="setup-panel">
          <p className="eyebrow">Setup</p>
          <h1>Wolf AI</h1>
          <p>Missing Supabase browser environment values.</p>
          <pre>NEXT_PUBLIC_SUPABASE_URL{"\n"}NEXT_PUBLIC_SUPABASE_ANON_KEY</pre>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <div>
            <h1>Wolf AI</h1>
            <p>{statusText}</p>
          </div>
        </div>
        <div className="status-strip">
          {game?.state.deadline_at ? <span>Deadline {new Date(game.state.deadline_at).toLocaleTimeString()}</span> : null}
          {session ? <button onClick={signOut}>Sign out</button> : null}
        </div>
      </header>

      {!session ? (
        <section className="auth-panel">
          <div>
            <p className="eyebrow">Account</p>
            <h2>Sign in</h2>
          </div>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" />
          </label>
          <label>
            Password
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          <div className="button-row">
            <button disabled={busy === "sign-in"} onClick={signIn}>Sign in</button>
            <button className="secondary" disabled={busy === "sign-up"} onClick={signUp}>Create account</button>
          </div>
        </section>
      ) : (
        <div className="console-grid">
          <aside className="side-panel">
            <section className="panel">
              <div className="section-head">
                <p className="eyebrow">Lobby</p>
                <button className="secondary small" onClick={() => run("reconnect", reconnectSnapshot)}>Reconnect</button>
              </div>
              <label>
                Room name
                <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
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
                    max={11}
                    value={aiCount}
                    onChange={(event) => setAiCount(Number(event.target.value))}
                  />
                </label>
              </div>
              <label>
                AI mode
                <select value={aiMode} onChange={(event) => setAiMode(event.target.value as typeof aiMode)}>
                  <option value="fill">Fill empty seats</option>
                  <option value="fixed">Fixed count</option>
                  <option value="none">No AI fill</option>
                </select>
              </label>
              <label>
                Visibility
                <select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}>
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <button disabled={Boolean(busy)} onClick={createRoom}>Create room</button>
            </section>

            <section className="panel">
              <p className="eyebrow">Join</p>
              <label>
                Invite code
                <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} />
              </label>
              <div className="button-row">
                <button disabled={Boolean(busy)} onClick={() => joinRoom()}>Join</button>
                <button className="secondary" disabled={Boolean(busy)} onClick={listPublicRooms}>Public rooms</button>
              </div>
              {rooms.length > 0 ? (
                <div className="room-list">
                  {rooms.map((room) => room ? (
                    <button key={room.id} className="room-row" onClick={() => joinRoom(room.id)}>
                      <span>{room.name ?? "Untitled"}</span>
                      <small>{room.human_count}/{room.max_players}</small>
                    </button>
                  ) : null)}
                </div>
              ) : null}
            </section>

            {roomSnapshot?.room ? (
              <section className="panel">
                <p className="eyebrow">Room</p>
                <div className="metric-grid">
                  <span>Invite</span>
                  <strong>{roomSnapshot.room.invite_code}</strong>
                  <span>Status</span>
                  <strong>{roomSnapshot.room.status}</strong>
                </div>
                <div className="member-list">
                  {roomSnapshot.members?.map((member) => (
                    <div key={member.user_id} className="member-row">
                      <span>{member.nickname}</span>
                      <small>{member.is_ready ? "Ready" : "Waiting"}</small>
                    </div>
                  ))}
                </div>
                <div className="button-row">
                  <button className="secondary" onClick={() => setReady(true)}>Ready</button>
                  <button disabled={roomSnapshot.room.status !== "WAITING"} onClick={startGame}>Start</button>
                </div>
              </section>
            ) : null}
          </aside>

          <section className="main-panel">
            <div className={`phase-band ${phaseTone(game?.state.phase)}`}>
              <div>
                <p className="eyebrow">State</p>
                <h2>{game ? `${game.state.phase} / round ${game.state.round_no}` : "Waiting for game"}</h2>
              </div>
              {game ? (
                <div className="self-state">
                  <span>Seat {game.self.seat_no}</span>
                  <strong>{ROLE_LABELS[game.self.role]}</strong>
                  <span>{game.self.alive ? "Alive" : "Dead"}</span>
                </div>
              ) : null}
            </div>

            <div className="table-surface">
              {game ? (
                <div className="seat-board" aria-label="Seat board">
                  {game.seats.map((seat) => (
                    <div
                      key={seat.seat_no}
                      className={`seat ${seat.alive ? "alive" : "dead"} ${seat.seat_no === game.self.seat_no ? "current" : ""}`}
                    >
                      <span>Seat {seat.seat_no}</span>
                      <small>{seat.alive ? "Alive" : "Out"}</small>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">Create or join a room to open the table.</div>
              )}
            </div>

            {game ? (
              <section className="action-panel">
                <div className="button-row">
                  <button className="secondary" onClick={() => serverAction("next_phase", { game_id: game.game.id })}>Next phase</button>
                  <button className="secondary" onClick={() => serverAction("ai_turn", { game_id: game.game.id })}>AI turn</button>
                  <button className="secondary" onClick={() => serverAction("timeout_handler", { game_id: game.game.id })}>Timeout</button>
                </div>

                <div className="form-grid action-grid">
                  <label>
                    Vote target
                    <select value={voteTarget} onChange={(event) => setVoteTarget(event.target.value)}>
                      <option value="">Abstain</option>
                      {game.seats.filter((seat) => seat.alive).map((seat) => (
                        <option key={seat.seat_no} value={seat.seat_no}>Seat {seat.seat_no}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={game.state.phase !== "vote"}
                    onClick={() =>
                      serverAction("process_vote", {
                        game_id: game.game.id,
                        request_id: crypto.randomUUID(),
                        target_seat_no: voteTarget ? Number(voteTarget) : null,
                      })
                    }
                  >
                    Submit vote
                  </button>
                  <label>
                    Night skill
                    <select value={skill} onChange={(event) => setSkill(event.target.value)}>
                      {skillOptions(game.self.role).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Target
                    <select value={skillTarget} onChange={(event) => setSkillTarget(event.target.value)}>
                      <option value="">No target</option>
                      {game.seats.filter((seat) => seat.alive).map((seat) => (
                        <option key={seat.seat_no} value={seat.seat_no}>Seat {seat.seat_no}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={game.state.phase !== "night"}
                    onClick={() =>
                      serverAction("process_skill", {
                        game_id: game.game.id,
                        request_id: crypto.randomUUID(),
                        skill,
                        target_seat_no: skillTarget ? Number(skillTarget) : null,
                      })
                    }
                  >
                    Submit skill
                  </button>
                </div>
              </section>
            ) : null}

            <section className="chat-panel">
              <div className="section-head">
                <p className="eyebrow">Messages</p>
                <div className="channel-pills">
                  {availableChannels.map((channel) => (
                    <span key={channel}>{CHANNEL_LABELS[channel]}</span>
                  ))}
                </div>
              </div>
              <div className="message-list">
                {game?.messages.length ? game.messages.map((message) => (
                  <article key={message.id} className="message-row">
                    <span>{message.seat_no ? `Seat ${message.seat_no}` : CHANNEL_LABELS[message.channel]}</span>
                    <p>{message.content}</p>
                  </article>
                )) : <div className="empty-state compact-empty">No messages yet.</div>}
              </div>
              <div className="composer">
                <select value={selectedChannel} onChange={(event) => setSelectedChannel(event.target.value as ChannelName)}>
                  {writableChannels.map((channel) => (
                    <option key={channel} value={channel}>{CHANNEL_LABELS[channel]}</option>
                  ))}
                </select>
                <input
                  value={chatText}
                  onChange={(event) => setChatText(event.target.value)}
                  placeholder="Message"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") sendMessage();
                  }}
                />
                <button disabled={!writableChannels.length || !chatText.trim()} onClick={sendMessage}>Send</button>
              </div>
            </section>

            {game?.post_game ? (
              <section className="postgame-panel">
                <p className="eyebrow">Post game</p>
                <div className="reveal-grid">
                  {game.post_game.map((member) => (
                    <div key={member.seat_no} className="reveal-row">
                      <span>Seat {member.seat_no}</span>
                      <strong>{ROLE_LABELS[member.role] ?? member.role}</strong>
                      <small>{member.is_ai ? "AI" : member.nickname ?? "Human"}</small>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </section>
        </div>
      )}

      <footer className="feedback-line" aria-live="polite">
        {busy ? <span>Working: {busy}</span> : null}
        {notice ? <span>{notice}</span> : null}
        {error ? <strong>{error}</strong> : null}
      </footer>
    </main>
  );
}
