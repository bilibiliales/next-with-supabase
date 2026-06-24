"use client";

import { useEffect, useState } from "react";

function remainingSeconds(deadlineAt: string | null | undefined) {
  if (!deadlineAt) return null;
  return Math.max(0, Math.ceil((new Date(deadlineAt).getTime() - Date.now()) / 1000));
}

export function useCountdown(deadlineAt: string | null | undefined) {
  const [seconds, setSeconds] = useState(() => remainingSeconds(deadlineAt));

  useEffect(() => {
    setSeconds(remainingSeconds(deadlineAt));
    const timer = window.setInterval(() => {
      setSeconds(remainingSeconds(deadlineAt));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [deadlineAt]);

  if (seconds === null) return "No deadline";

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
