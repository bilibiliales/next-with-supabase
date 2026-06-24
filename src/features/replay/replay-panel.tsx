"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useAuthStore } from "../../store/auth-store";
import { useGameStore } from "../../store/game-store";
import { useRoomStore } from "../../store/room-store";
import type { GameEvent, GameSnapshot } from "../../types/wolf";

const ROLE_LABELS: Record<string, string> = {
  wolf: "Wolf",
  villager: "Villager",
  seer: "Seer",
  witch: "Witch",
  hunter: "Hunter",
};

function winnerLabel(winner: string | null) {
  if (winner === "wolves") return "Wolves";
  if (winner === "villagers") return "Villagers";
  if (winner === "draw") return "Draw";
  return "Pending";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function seatLabel(value: unknown) {
  return typeof value === "number" ? `Seat ${value}` : "Abstain";
}

function eventTitle(event: GameEvent) {
  if (event.event_type === "vote_resolved") return `Round ${event.payload.round_no} vote`;
  if (event.event_type === "night_resolved") return `Round ${event.payload.round_no} night`;
  if (event.event_type === "ai_action_submitted") return `AI Seat ${event.payload.seat_no ?? "-"} ${event.payload.action_type ?? "action"}`;
  if (event.event_type === "game_ended") return "Game ended";
  if (event.event_type === "phase_changed") return `Phase changed to ${event.payload.phase ?? "-"}`;
  return "Game started";
}

function eventSummary(event: GameEvent) {
  const explanation = asRecord(event.payload.explanation);
  if (typeof explanation.summary === "string") return explanation.summary;
  if (event.event_type === "vote_resolved") return String(event.payload.result ?? "vote resolved");
  if (event.event_type === "ai_action_submitted") return String(event.payload.reasoning_state ?? "AI action submitted");
  if (event.event_type === "night_resolved") return "Night actions resolved.";
  if (event.event_type === "game_ended") return `${winnerLabel(String(event.payload.winner ?? ""))} win`;
  return "";
}

function VoteDetail({ event }: { event: GameEvent }) {
  const details = Array.isArray(event.payload.vote_detail) ? event.payload.vote_detail : [];
  if (!details.length) return null;
  return (
    <div className="event-chip-list">
      {details.map((item, index) => {
        const detail = asRecord(item);
        return (
          <span key={`${detail.voter_seat}-${index}`}>
            Seat {String(detail.voter_seat ?? "-")} {" -> "} {seatLabel(detail.target_seat)}
          </span>
        );
      })}
    </div>
  );
}

function NightDetail({ event }: { event: GameEvent }) {
  const actions = Array.isArray(event.payload.night_actions) ? event.payload.night_actions : [];
  if (!actions.length) return null;
  return (
    <div className="event-chip-list">
      {actions.map((item, index) => {
        const action = asRecord(item);
        const reason = typeof action.reason === "string" ? action.reason : null;
        const target = reason ?? seatLabel(action.target_seat);
        return (
          <span key={`${action.actor_seat}-${index}`}>
            Seat {String(action.actor_seat ?? "-")} {String(action.action_type ?? "acted")} {" -> "} {target}
          </span>
        );
      })}
    </div>
  );
}

export function ReplayPanel({ snapshot }: { snapshot: GameSnapshot }) {
  const router = useRouter();
  const setPostGameReady = useGameStore((state) => state.setPostGameReady);
  const resetRoom = useGameStore((state) => state.resetRoom);
  const clearGame = useGameStore((state) => state.clear);
  const busy = useGameStore((state) => state.busy);
  const leaveRoom = useRoomStore((state) => state.leaveRoom);
  const roomBusy = useRoomStore((state) => state.busy);
  const session = useAuthStore((state) => state.session);
  const isOwner = snapshot.room.owner_id === session?.user.id;
  const ready = snapshot.post_game_ready;
  const replayEvents = snapshot.post_game_events ?? [];
  const deathOrder = useMemo(
    () =>
      [...(snapshot.post_game ?? [])].sort((a, b) => {
        const aRound = a.death_round ?? Number.MAX_SAFE_INTEGER;
        const bRound = b.death_round ?? Number.MAX_SAFE_INTEGER;
        return aRound - bRound || a.seat_no - b.seat_no;
      }),
    [snapshot.post_game],
  );

  async function startNext(force: boolean) {
    if (force && !window.confirm("Some players have not finished reviewing. Continue?")) return;
    const room = await resetRoom(snapshot.game.room_id, force);
    if (room?.room) {
      useRoomStore.getState().setSnapshot(room);
      router.push(`/room/${room.room.id}`);
    }
  }

  async function leavePostGameRoom() {
    const result = await leaveRoom(snapshot.game.room_id);
    if (result?.left) {
      clearGame();
      router.push("/lobby");
    }
  }

  return (
    <div className="replay-grid">
      <section className="phase-band phase-ended">
        <div>
          <p className="eyebrow">Post game</p>
          <h1>{winnerLabel(snapshot.game.winner)} win</h1>
        </div>
        <div className="phase-metrics">
          <span>
            Reviewed
            <strong>
              {ready?.ready_count ?? 0}/{ready?.active_count ?? 0}
            </strong>
          </span>
          <span>
            Round
            <strong>{snapshot.state.round_no}</strong>
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Identities</p>
            <h2>Seats</h2>
          </div>
        </div>
        <div className="reveal-grid">
          {(snapshot.post_game ?? []).map((member) => (
            <div className="reveal-row" key={member.seat_no}>
              <span>Seat {member.seat_no}</span>
              <strong>{ROLE_LABELS[member.role] ?? member.role}</strong>
              <small>{member.is_ai ? member.nickname ?? "AI player" : member.nickname ?? "Human"}</small>
              <small>{member.alive ? "Survived" : `Dead R${member.death_round ?? "-"}`}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Death order</p>
            <h2>Timeline</h2>
          </div>
        </div>
        <div className="timeline-list">
          {deathOrder.map((member) => (
            <div className="timeline-row" key={member.seat_no}>
              <span>Seat {member.seat_no}</span>
              <strong>{member.death_round ? `Round ${member.death_round}` : "Alive"}</strong>
              <small>{member.death_reason ?? "No death"}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Replay</p>
            <h2>Decision log</h2>
          </div>
          <span className="count-badge">{replayEvents.length}</span>
        </div>
        <div className="timeline-list">
          {replayEvents.length ? (
            replayEvents.map((event) => (
              <article className="event-row" key={event.id}>
                <div>
                  <span>{eventTitle(event)}</span>
                  <strong>{eventSummary(event)}</strong>
                </div>
                {event.event_type === "vote_resolved" ? <VoteDetail event={event} /> : null}
                {event.event_type === "night_resolved" ? <NightDetail event={event} /> : null}
              </article>
            ))
          ) : (
            <div className="empty-state">No replay events.</div>
          )}
        </div>
      </section>

      <section className="panel replay-actions">
        <div>
          <p className="eyebrow">Ready</p>
          <h2>
            {ready?.ready_count ?? 0} / {ready?.active_count ?? 0} reviewed
          </h2>
        </div>
        <div className="button-row">
          <button
            className="secondary"
            disabled={Boolean(busy) || Boolean(ready?.self_ready)}
            type="button"
            onClick={() => void setPostGameReady(snapshot.game.room_id, true)}
          >
            I finished reviewing
          </button>
          {isOwner ? (
            ready?.all_ready ? (
              <button disabled={Boolean(busy)} type="button" onClick={() => void startNext(false)}>
                Start next game
              </button>
            ) : (
              <button disabled={Boolean(busy)} type="button" onClick={() => void startNext(true)}>
                Force start
              </button>
            )
          ) : (
            <button
              className="secondary"
              disabled={Boolean(roomBusy)}
              type="button"
              onClick={() => void leavePostGameRoom()}
            >
              Leave room
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
