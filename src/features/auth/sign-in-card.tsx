"use client";

import { FormEvent, useState } from "react";
import { useAuthStore } from "../../store/auth-store";

export function SignInCard() {
  const loading = useAuthStore((state) => state.loading);
  const error = useAuthStore((state) => state.error);
  const signIn = useAuthStore((state) => state.signIn);
  const signUp = useAuthStore((state) => state.signUp);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await signIn(username, password);
  }

  return (
    <section className="auth-card">
      <div>
        <p className="eyebrow">Account</p>
        <h1>Wolf AI</h1>
      </div>
      <form className="form-stack" onSubmit={submit}>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            type="text"
            autoComplete="username"
            autoCapitalize="none"
          />
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
          <button disabled={loading || !username.trim() || !password} type="submit">
            Sign in
          </button>
          <button
            className="secondary"
            disabled={loading || !username.trim() || !password}
            type="button"
            onClick={() => void signUp(username, password)}
          >
            Create account
          </button>
        </div>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
    </section>
  );
}
