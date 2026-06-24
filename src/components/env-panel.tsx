export function EnvPanel() {
  return (
    <main className="center-shell">
      <section className="auth-card">
        <p className="eyebrow">Setup</p>
        <h1>Wolf AI</h1>
        <p className="muted">Missing browser Supabase environment values.</p>
        <pre>NEXT_PUBLIC_SUPABASE_URL{"\n"}NEXT_PUBLIC_SUPABASE_ANON_KEY</pre>
      </section>
    </main>
  );
}
