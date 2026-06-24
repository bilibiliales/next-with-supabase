"use client";

import type { GameSnapshot } from "../../types/wolf";
import { useCountdown } from "../../hooks/use-countdown";
import { ActionPanel } from "./player-actions";
import { ChatPanel } from "./chat-panel";

const ROLE_LABELS: Record<string, string> = {
  wolf: "Wolf",
  villager: "Villager",
  seer: "Seer",
  witch: "Witch",
  hunter: "Hunter",
};

function phaseTone(phase: string) {
  if (phase === "night") return "phase-night";
  if (phase === "vote") return "phase-vote";
  if (phase === "settlement") return "phase-settlement";
  return "phase-day";
}

export function GameTable({ snapshot }: { snapshot: GameSnapshot }) {
  const remaining = useCountdown(snapshot.state.deadline_at);

  return (
    <div className="game-grid">
      <section className={`phase-band ${phaseTone(snapshot.state.phase)}`}>
        <div>
          <p className="eyebrow">Current phase</p>
          <h1>{snapshot.state.phase}</h1>
        </div>
        <div className="phase-metrics">
          <span>
            Round
            <strong>{snapshot.state.round_no}</strong>
          </span>
          <span>
            Remaining
            <strong>{remaining}</strong>
          </span>
          <span>
            You
            <strong>{ROLE_LABELS[snapshot.self.role] ?? snapshot.self.role}</strong>
          </span>
          <span>
            State
            <strong>{snapshot.self.alive ? "Alive" : "Dead"}</strong>
          </span>
        </div>
      </section>

      <section className="table-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Seats</p>
            <h2>Table</h2>
          </div>
          <span className="count-badge">{snapshot.seats.length}</span>
        </div>
        <div className="seat-board">
          {snapshot.seats.map((seat) => (
            <div
              className={`seat-tile ${seat.alive ? "alive" : "dead"} ${
                seat.seat_no === snapshot.self.seat_no ? "self" : ""
              }`}
              key={seat.seat_no}
            >
              <strong>{seat.seat_no}</strong>
              <span>{seat.alive ? "Alive" : "Dead"}</span>
            </div>
          ))}
        </div>
      </section>

      <ActionPanel snapshot={snapshot} />
      <ChatPanel snapshot={snapshot} />
    </div>
  );
}
