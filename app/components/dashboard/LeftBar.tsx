"use client";

import { useState } from "react";
import { Client, ViewMode, CenterMode } from "@/app/components/dashboard/types";

function NavButton({
  active,
  icon,
  children,
  onClick,
}: {
  active?: boolean;
  icon: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "w-full rounded-lg px-3 py-2.5 text-sm text-left transition-colors flex items-center gap-2.5",
        active
          ? "bg-blue-600 text-white font-medium"
          : "text-slate-300 hover:bg-slate-800 hover:text-white",
      ].join(" ")}
    >
      <span className="text-base leading-none w-5 text-center shrink-0">{icon}</span>
      {children}
    </button>
  );
}

export default function LeftBar({
  viewMode,
  onChangeView,
  centerMode,
  onToggleSettings,
  clients,
  clientsHidden,
  onToggleClientsHidden,
  selectedClientId,
  onSelectClient,
}: {
  viewMode: ViewMode;
  onChangeView: (m: ViewMode) => void;
  centerMode: CenterMode;
  onToggleSettings: () => void;
  clients: Client[];
  clientsHidden: boolean;
  onToggleClientsHidden: () => void;
  selectedClientId: string | null;
  onSelectClient: (id: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const activeClients = clients.filter((c) => !c.archived_at);
  const archivedClients = clients.filter((c) => !!c.archived_at);
  const displayClients = showArchived ? clients : activeClients;

  return (
    <div className="flex flex-col h-full bg-[#0f172a] rounded-2xl text-white">
      {/* Logo */}
      <div className="px-4 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 text-xs font-bold shrink-0">
            FTS
          </div>
          <div className="text-sm font-semibold leading-tight">FlowTrack Schedule</div>
        </div>
      </div>

      <div className="mx-3 border-t border-slate-700" />

      {/* View */}
      <div className="px-3 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-1 mb-2">
          View
        </div>
        <div className="grid grid-cols-1 gap-0.5">
          <NavButton
            icon="&#128197;"
            active={viewMode === "day" && centerMode === "schedule"}
            onClick={() => onChangeView("day")}
          >
            Day
          </NavButton>
          <NavButton
            icon="&#128198;"
            active={viewMode === "weekdays" && centerMode === "schedule"}
            onClick={() => onChangeView("weekdays")}
          >
            Weekdays
          </NavButton>
          <NavButton
            icon="&#128197;"
            active={viewMode === "week" && centerMode === "schedule"}
            onClick={() => onChangeView("week")}
          >
            Week
          </NavButton>
        </div>
      </div>

      <div className="mx-3 mt-3 border-t border-slate-700" />

      {/* Clients */}
      <div className="flex items-center justify-between px-4 pt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Clients
        </div>
        <div className="flex items-center gap-1">
          {archivedClients.length > 0 && (
            <button
              onClick={() => setShowArchived((v) => !v)}
              className={["rounded px-2 py-0.5 text-[11px] transition-colors",
                showArchived ? "text-amber-400 hover:text-amber-300" : "text-slate-500 hover:text-slate-300",
              ].join(" ")}
              title={showArchived ? "Hide archived" : "Show archived"}
            >
              {showArchived ? "Active" : `+${archivedClients.length}`}
            </button>
          )}
          <button
            onClick={onToggleClientsHidden}
            className="rounded px-2 py-0.5 text-[11px] text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            {clientsHidden ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden px-3 pt-2 pb-3">
        {clientsHidden ? (
          <div className="rounded-lg bg-slate-800 p-3 text-sm text-slate-400">
            Client list hidden
          </div>
        ) : (
          <div className="max-h-full overflow-auto rounded-lg">
            {displayClients.map((c) => {
              const active = c.id === selectedClientId;
              const archived = !!c.archived_at;
              return (
                <button
                  key={c.id}
                  onClick={() => onSelectClient(c.id)}
                  className={[
                    "w-full px-3 py-2.5 text-left text-sm transition-colors",
                    active
                      ? "bg-blue-600 text-white font-medium rounded-lg"
                      : archived
                        ? "text-slate-500 hover:bg-slate-800 hover:text-slate-300"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white",
                  ].join(" ")}
                >
                  <div className="truncate flex items-center gap-1.5">
                    {c.name}
                    {archived && <span className="text-[9px] text-amber-500">archived</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom settings shortcut */}
      <div className="mx-3 border-t border-slate-700" />
      <div className="px-3 py-3">
        <button
          onClick={onToggleSettings}
          className={[
            "flex items-center gap-2.5 text-sm transition-colors px-3 py-2 rounded-lg w-full text-left",
            centerMode === "settings"
              ? "bg-blue-600 text-white font-medium"
              : "text-slate-400 hover:text-white hover:bg-slate-800",
          ].join(" ")}
        >
          <span className="text-base leading-none">&#9881;</span>
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
