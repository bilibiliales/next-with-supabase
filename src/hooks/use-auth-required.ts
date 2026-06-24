"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuthStore } from "../store/auth-store";

export function useAuthRequired() {
  const router = useRouter();
  const session = useAuthStore((state) => state.session);
  const ready = useAuthStore((state) => state.ready);
  const init = useAuthStore((state) => state.init);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (ready && !session) router.replace("/");
  }, [ready, router, session]);

  return { ready, session };
}
