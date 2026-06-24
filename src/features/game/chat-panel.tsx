"use client";

import { KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useGameStore } from "../../store/game-store";
import type { ChannelName, GameSnapshot } from "../../types/wolf";

const CHANNEL_LABELS: Record<ChannelName, string> = {
  lobby: "Lobby",
  public: "Public",
  wolf: "Wolf",
  dead: "Dead",
  system: "System",
};

export function ChatPanel({ snapshot }: { snapshot: GameSnapshot }) {
  const sendMessage = useGameStore((state) => state.sendMessage);
  const busy = useGameStore((state) => state.busy);
  const writableChannels = useMemo<ChannelName[]>(
    () => snapshot.channels.filter((channel) => channel !== "system" && channel !== "lobby"),
    [snapshot.channels],
  );
  const [channel, setChannel] = useState<ChannelName>(writableChannels[0] ?? "public");
  const [content, setContent] = useState("");

  useEffect(() => {
    if (writableChannels.length > 0 && !writableChannels.includes(channel)) {
      setChannel(writableChannels[0]);
    }
  }, [channel, writableChannels]);

  async function submit() {
    if (!content.trim() || !writableChannels.includes(channel)) return;
    const sent = await sendMessage(snapshot.game.room_id, channel, content.trim());
    if (sent) setContent("");
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") void submit();
  }

  return (
    <section className="panel chat-panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">Chat</p>
          <h2>Messages</h2>
        </div>
        <div className="channel-pills">
          {snapshot.channels.map((item) => (
            <span key={item}>{CHANNEL_LABELS[item]}</span>
          ))}
        </div>
      </div>
      <div className="message-list">
        {snapshot.messages.length ? (
          snapshot.messages.map((message) => (
            <article className="message-row" key={message.id}>
              <span>{message.seat_no ? `Seat ${message.seat_no}` : CHANNEL_LABELS[message.channel]}</span>
              <p>{message.content}</p>
            </article>
          ))
        ) : (
          <div className="empty-state">No messages.</div>
        )}
      </div>
      <div className="composer">
        <select
          value={channel}
          onChange={(event) => setChannel(event.target.value as ChannelName)}
          disabled={!writableChannels.length}
        >
          {writableChannels.map((item) => (
            <option key={item} value={item}>
              {CHANNEL_LABELS[item]}
            </option>
          ))}
        </select>
        <input value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={keyDown} />
        <button disabled={Boolean(busy) || !content.trim() || !writableChannels.length} type="button" onClick={submit}>
          Send
        </button>
      </div>
    </section>
  );
}
