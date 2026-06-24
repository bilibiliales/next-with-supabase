"use client";

import { useEffect } from "react";
import { getSupabase, hasSupabaseEnv } from "../services/supabase-client";
import { useAuthStore } from "../store/auth-store";
import { useRealtimeStore } from "../store/realtime-store";
import type { ChannelName, GameMessage } from "../types/wolf";

type RealtimeOptions = {
  roomId: string | null | undefined;
  channels: ChannelName[];
  onRefresh: () => void | Promise<void>;
  onMessage?: (message: GameMessage) => void;
  onRoomClosed?: () => void;
};

export function useRealtimeSubscriptions({
  roomId,
  channels,
  onRefresh,
  onMessage,
  onRoomClosed,
}: RealtimeOptions) {
  const accessToken = useAuthStore((state) => state.session?.access_token);
  const setTopics = useRealtimeStore((state) => state.setTopics);
  const clearTopics = useRealtimeStore((state) => state.clear);
  const channelsKey = channels.join("|");

  useEffect(() => {
    if (!hasSupabaseEnv() || !accessToken || !roomId || channels.length === 0) {
      clearTopics();
      return;
    }

    const supabase = getSupabase();
    supabase.realtime.setAuth(accessToken);

    const subscriptions = channels.map((channel) =>
      supabase
        .channel(`room:${roomId}:${channel}`, { config: { private: true } })
        .on("broadcast", { event: "message" }, ({ payload }) => {
          onMessage?.(payload as GameMessage);
        })
        .on("broadcast", { event: "state" }, () => {
          void onRefresh();
        })
        .on("broadcast", { event: "room" }, ({ payload }) => {
          const event = payload as { dissolved?: boolean };
          if (event.dissolved) {
            onRoomClosed?.();
            return;
          }
          void onRefresh();
        })
        .subscribe(),
    );

    setTopics(channels.map((channel) => `room:${roomId}:${channel}`));

    return () => {
      subscriptions.forEach((subscription) => {
        void supabase.removeChannel(subscription);
      });
      clearTopics();
    };
  }, [accessToken, channels, channelsKey, clearTopics, onMessage, onRefresh, onRoomClosed, roomId, setTopics]);
}
