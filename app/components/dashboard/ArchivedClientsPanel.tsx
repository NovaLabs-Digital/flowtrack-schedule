"use client";

import { useEffect, useState } from "react";

type ArchivedClient = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  archived_at: string | null;
  status: string | null;
};

export default function ArchivedClientsPanel() {
  const [clients, setClients] = useState<ArchivedClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  function loadClients() {
    fetch("/api/clients/archived")
      .then((r) => r.json())
      .then((data) => {
        if (data.clients) setClients(data.clients);
        else if (data.error) setMessage({ type: "error", text: data.error });
      })
      .catch(() => setMessage({ type: "error", text: "Failed to load archived clients." }))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadClients(); }, []);

  async function restore(id: string) {
    setRestoring(id);
    setMessage(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "restore" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ type: "error", text: data?.error || "Restore failed." }); return; }
      setMessage({ type: "success", text: "Client restored." });
      loadClients();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally { setRestoring(null); }
  }

  function fmtDate(iso: string | null) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading archived clients...</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">Archived Clients</div>
      <div className="mt-1 text-xs text-slate-500">Clients who have been archived. Restore them to make them active again.</div>

      {message && (
        <div className={["mt-4 rounded-xl border px-3 py-2 text-xs",
          message.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
        ].join(" ")}>{message.text}</div>
      )}

      {clients.length === 0 ? (
        <div className="mt-6 text-center py-8">
          <div className="text-3xl text-slate-200 mb-2">&#128100;</div>
          <div className="text-sm text-slate-400">No archived clients</div>
          <div className="text-xs text-slate-400 mt-0.5">Archived clients will appear here.</div>
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-[1fr_1fr_1fr_100px_80px_auto] gap-4 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
            <div>Name</div>
            <div>Phone</div>
            <div>Email</div>
            <div>Archived</div>
            <div>Status</div>
            <div>Actions</div>
          </div>
          <div>
            {clients.map((c) => (
              <div key={c.id} className="grid grid-cols-[1fr_1fr_1fr_100px_80px_auto] gap-4 items-center px-4 py-3 border-b border-slate-100 text-xs">
                <div className="text-slate-900 font-medium truncate">{c.name}</div>
                <div className="text-slate-600 truncate">{c.phone ?? "—"}</div>
                <div className="text-slate-600 truncate">{c.email ?? "—"}</div>
                <div className="text-slate-500">{fmtDate(c.archived_at)}</div>
                <div>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                    {c.status === "inactive" ? "Inactive" : "Archived"}
                  </span>
                </div>
                <div>
                  <button
                    onClick={() => restore(c.id)}
                    disabled={restoring === c.id}
                    className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
                  >
                    {restoring === c.id ? "Restoring..." : "Restore"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 px-4 text-xs text-slate-500">
            {clients.length} archived client{clients.length !== 1 ? "s" : ""}
          </div>
        </>
      )}
    </div>
  );
}
