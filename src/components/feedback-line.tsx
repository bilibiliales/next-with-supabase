type FeedbackLineProps = {
  busy?: string | null;
  error?: string | null;
  notice?: string | null;
};

export function FeedbackLine({ busy, error, notice }: FeedbackLineProps) {
  if (!busy && !error && !notice) return <div className="feedback-line" aria-live="polite" />;

  return (
    <div className="feedback-line" aria-live="polite">
      {busy ? <span>Working: {busy}</span> : null}
      {notice ? <span>{notice}</span> : null}
      {error ? <strong>{error}</strong> : null}
    </div>
  );
}
