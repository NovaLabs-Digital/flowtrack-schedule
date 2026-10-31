"use client";

import { useState } from "react";

export default function JoinClient({ token }: { token: string }) {
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setJoining(true);
    setError(null);
    try {
      const res = await fetch("/api/demo-session/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, displayName: name.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || typeof data?.sessionId !== "string") {
        setError(data?.error || "This invitation is no longer available. Ask the host for a new link.");
        return;
      }
      // Full page load: the session page installs its own demo handling.
      window.location.assign(`/demo/session/${data.sessionId}?as=visitor`);
    } catch {
      setError("Couldn't join. Please check your connection and try again.");
    } finally {
      setJoining(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <form onSubmit={join} className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">Guided Demo Session</div>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Join the ScheduleFlowTrack demo</h1>
        <p className="mt-2 text-sm text-slate-600">
          You&apos;ll see a fictional business alongside your host. You start by watching; the host can hand you control.
        </p>
        <label htmlFor="visitor-name" className="mt-5 block text-xs font-medium text-slate-600">
          Your name (optional)
        </label>
        <input
          id="visitor-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          autoComplete="given-name"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800"
        />
        <button
          type="submit"
          disabled={joining}
          className="mt-5 w-full rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {joining ? "Joining…" : "Join session"}
        </button>
        {error && <p role="alert" className="mt-4 text-sm text-rose-700">{error}</p>}
      </form>
    </main>
  );
}
