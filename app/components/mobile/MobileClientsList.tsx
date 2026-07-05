"use client";

import { useState } from "react";
import { Client } from "@/app/components/dashboard/types";

type Props = {
  clients: Client[];
  onSelectClient: (clientId: string) => void;
};

// Clients tab (Screen 4) — search bar + scrollable list. Tapping a row opens
// the existing MobileClientDrawer (Milestone 6) via the caller's
// onSelectClient — no new client detail screen, no new data fetching.
export default function MobileClientsList({ clients, onSelectClient }: Props) {
  const [query, setQuery] = useState("");

  const activeClients = clients.filter((c) => !c.archived_at);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? activeClients.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.phone ?? "").toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q)
      )
    : activeClients;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Top bar + search */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3 space-y-2">
        <div className="text-base font-semibold text-slate-900">Clients</div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search clients..."
          className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-3xl text-slate-300 mb-3">👥</div>
            <div className="text-sm text-slate-500">{q ? "No matching clients" : "No clients yet"}</div>
          </div>
        ) : (
          filtered.map((c) => {
            const initials = c.name.split(" ").map((p) => p.charAt(0)).slice(0, 2).join("").toUpperCase();
            const isInactive = c.status === "inactive";
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectClient(c.id)}
                className="w-full flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm active:bg-slate-50 transition-colors"
              >
                <div className="w-11 h-11 rounded-full bg-purple-600 text-white flex items-center justify-center text-sm font-semibold shrink-0">
                  {initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 truncate">{c.name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {c.phone || c.email || "No contact info"}
                  </div>
                </div>
                {c.status && (
                  <span
                    className={[
                      "text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0",
                      isInactive ? "bg-slate-100 text-slate-500" : "bg-emerald-50 text-emerald-700",
                    ].join(" ")}
                  >
                    {isInactive ? "Inactive" : "Active"}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
