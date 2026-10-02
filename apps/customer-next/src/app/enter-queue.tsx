"use client";

import { useState } from "react";
import { enterQueue } from "@/lib/api";

export function EnterQueue() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="stack">
      <h1>Join the queue</h1>
      <p>Enter your name if you want the agent to see it. You wait until an agent claims the session.</p>
      <label className="name-field">
        <span>Your name</span>
        <input
          value={name}
          maxLength={120}
          spellCheck={false}
          placeholder="Optional"
          data-queue="name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary"
        data-action="enter-queue"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void enterQueue(name)
            .then((session) => {
              window.location.assign(`/join/${encodeURIComponent(session.joinToken)}`);
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : "Could not enter the queue.");
              setBusy(false);
            });
        }}
      >
        {busy ? "Joining…" : "Enter the queue"}
      </button>
      {error ? <p className="problem">{error}</p> : null}
      <p>Or open the join link the desk copied. It looks like this:</p>
      <p className="mono">/join/…</p>
    </div>
  );
}
