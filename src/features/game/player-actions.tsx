"use client";

import { useMemo, useState } from "react";
import { useGameStore } from "../../store/game-store";
import type { GameSnapshot } from "../../types/wolf";

type SkillOption = {
  value: string;
  label: string;
  needsTarget: boolean;
};

function skillOptions(role: string): SkillOption[] {
  if (role === "wolf") {
    return [
      { value: "wolf_kill", label: "Wolf kill", needsTarget: true },
      { value: "pass", label: "Pass", needsTarget: false },
    ];
  }
  if (role === "seer") {
    return [
      { value: "seer_check", label: "Check", needsTarget: true },
      { value: "pass", label: "Pass", needsTarget: false },
    ];
  }
  if (role === "witch") {
    return [
      { value: "witch_heal", label: "Heal", needsTarget: true },
      { value: "witch_poison", label: "Poison", needsTarget: true },
      { value: "pass", label: "Pass", needsTarget: false },
    ];
  }
  return [{ value: "pass", label: "Pass", needsTarget: false }];
}

export function ActionPanel({ snapshot }: { snapshot: GameSnapshot }) {
  const submitVote = useGameStore((state) => state.submitVote);
  const submitSkill = useGameStore((state) => state.submitSkill);
  const busy = useGameStore((state) => state.busy);
  const privateResult = useGameStore((state) => state.privateResult);
  const [voteTarget, setVoteTarget] = useState("");
  const [skill, setSkill] = useState(() => skillOptions(snapshot.self.role)[0].value);
  const [skillTarget, setSkillTarget] = useState("");

  const aliveSeats = useMemo(() => snapshot.seats.filter((seat) => seat.alive), [snapshot.seats]);
  const options = skillOptions(snapshot.self.role);
  const selectedSkill = options.find((option) => option.value === skill) ?? options[0];
  const canVote = snapshot.state.phase === "vote" && snapshot.self.alive;
  const canUseSkill = snapshot.state.phase === "night" && snapshot.self.alive;

  return (
    <section className="panel action-panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">Actions</p>
          <h2>{snapshot.state.phase === "vote" ? "Vote" : "Night action"}</h2>
        </div>
        {privateResult ? (
          <span className="state-pill good">
            Seat {privateResult.target_seat_no}: {privateResult.is_wolf ? "Wolf" : "Not wolf"}
          </span>
        ) : null}
      </div>

      <div className="action-grid">
        <label>
          Vote target
          <select value={voteTarget} onChange={(event) => setVoteTarget(event.target.value)} disabled={!canVote}>
            <option value="">Abstain</option>
            {aliveSeats.map((seat) => (
              <option key={seat.seat_no} value={seat.seat_no}>
                Seat {seat.seat_no}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={Boolean(busy) || !canVote}
          type="button"
          onClick={() => void submitVote(snapshot.game.id, voteTarget ? Number(voteTarget) : null)}
        >
          Submit vote
        </button>

        <label>
          Skill
          <select value={skill} onChange={(event) => setSkill(event.target.value)} disabled={!canUseSkill}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target
          <select
            value={skillTarget}
            onChange={(event) => setSkillTarget(event.target.value)}
            disabled={!canUseSkill || !selectedSkill.needsTarget}
          >
            <option value="">No target</option>
            {aliveSeats.map((seat) => (
              <option key={seat.seat_no} value={seat.seat_no}>
                Seat {seat.seat_no}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={Boolean(busy) || !canUseSkill || (selectedSkill.needsTarget && !skillTarget)}
          type="button"
          onClick={() =>
            void submitSkill(snapshot.game.id, selectedSkill.value, skillTarget ? Number(skillTarget) : null)
          }
        >
          Submit skill
        </button>
      </div>
    </section>
  );
}
