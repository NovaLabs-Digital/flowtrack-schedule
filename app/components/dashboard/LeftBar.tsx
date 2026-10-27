"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Client, ViewMode, CenterMode } from "@/app/components/dashboard/types";
import { SUPPORT_MAILTO_URL } from "@/lib/support";

function NavButton({
  active,
  icon,
  children,
  onClick,
  label,
  collapsed,
}: {
  active?: boolean;
  icon: string;
  children: React.ReactNode;
  onClick: () => void;
  // Plain-text accessible name, always set as aria-label/title regardless
  // of collapsed state -- when expanded this duplicates the visible label
  // (harmless, and gives every nav item a native hover tooltip too); when
  // collapsed it's the ONLY accessible name, since the visible text is
  // hidden.
  label: string;
  collapsed?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        "w-full rounded-lg px-3 py-2.5 text-sm transition-colors flex items-center gap-2.5",
        collapsed ? "justify-center" : "text-left",
        active
          ? "bg-blue-600 text-white font-medium"
          : "text-slate-300 hover:bg-slate-800 hover:text-white",
      ].join(" ")}
    >
      <span className="text-base leading-none w-5 text-center shrink-0">{icon}</span>
      <span className={collapsed ? "sr-only" : ""}>{children}</span>
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
  collapsed,
  onToggleCollapsed,
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
  // Collapses this entire sidebar to a narrow navigation icon strip,
  // hiding the client list. Independent of clientsHidden above, which is
  // an unrelated, already-existing per-session preference that blanks
  // only the client list's own content while staying full width.
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const activeClients = clients.filter((c) => !c.archived_at);
  const archivedClients = clients.filter((c) => !!c.archived_at);
  const displayClients = showArchived ? clients : activeClients;

  return (
    <div className="flex flex-col h-full bg-[#0f172a] rounded-2xl text-white">
      {/* Logo + collapse/expand toggle */}
      <div className="px-4 pt-5 pb-4">
        <div className={["flex items-center", collapsed ? "flex-col gap-2" : "justify-between gap-3"].join(" ")}>
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 text-xs font-bold shrink-0">
              FTS
            </div>
            <div className={["text-sm font-semibold leading-tight", collapsed ? "sr-only" : ""].join(" ")}>
              FlowTrack Schedule
            </div>
          </div>
          <button
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className="flex items-center justify-center shrink-0 w-7 h-7 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" size={16} />
            ) : (
              <PanelLeftClose aria-hidden="true" size={16} />
            )}
          </button>
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
            label="Day"
            collapsed={collapsed}
          >
            Day
          </NavButton>
          <NavButton
            icon="&#128198;"
            active={viewMode === "weekdays" && centerMode === "schedule"}
            onClick={() => onChangeView("weekdays")}
            label="Weekdays"
            collapsed={collapsed}
          >
            Weekdays
          </NavButton>
          <NavButton
            icon="&#128197;"
            active={viewMode === "week" && centerMode === "schedule"}
            onClick={() => onChangeView("week")}
            label="Week"
            collapsed={collapsed}
          >
            Week
          </NavButton>
          <NavButton
            icon="&#128467;"
            active={viewMode === "month" && centerMode === "schedule"}
            onClick={() => onChangeView("month")}
            label="Month"
            collapsed={collapsed}
          >
            Month
          </NavButton>
        </div>
      </div>

      <div className="mx-3 mt-3 border-t border-slate-700" />

      {/* Clients */}
      {/* Hidden entirely while collapsed (a narrow icon strip has no room
          for a client list); a bare flex-1 spacer takes its place so the
          bottom Contact/Settings/Sign Out group stays pinned to the
          bottom, same as expanded. */}
      {collapsed ? (
        <div className="flex-1" />
      ) : (
      <>
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

      <div data-tour="clients-list" className="flex-1 overflow-hidden px-3 pt-2 pb-3">
        {clientsHidden ? (
          <div className="rounded-lg bg-slate-800 p-3 text-sm text-slate-400">
            Client list hidden
          </div>
        ) : (
          <div className="max-h-full overflow-auto rounded-lg scrollbar-dark">
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
      </>
      )}

      {/* Bottom settings shortcut */}
      <div className="mx-3 border-t border-slate-700" />
      <div className="px-3 py-3">
        <a
          href={SUPPORT_MAILTO_URL}
          title="Contact / Need Help?"
          aria-label="Contact / Need Help?"
          className={[
            "flex items-center gap-2.5 text-sm transition-colors px-3 py-2 rounded-lg w-full text-slate-400 hover:text-white hover:bg-slate-800 mb-1",
            collapsed ? "justify-center" : "text-left",
          ].join(" ")}
        >
          <span className="text-base leading-none">&#9993;</span>
          <span className={collapsed ? "sr-only" : ""}>Contact / Need Help?</span>
        </a>
        <button
          onClick={onToggleSettings}
          title="Settings"
          aria-label="Settings"
          className={[
            "flex items-center gap-2.5 text-sm transition-colors px-3 py-2 rounded-lg w-full",
            collapsed ? "justify-center" : "text-left",
            centerMode === "settings"
              ? "bg-blue-600 text-white font-medium"
              : "text-slate-400 hover:text-white hover:bg-slate-800",
          ].join(" ")}
        >
          <SettingsIcon aria-hidden="true" size={16} />
          <span className={collapsed ? "sr-only" : ""}>Settings</span>
        </button>
        <button
          onClick={async () => {
            try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
            router.push("/");
          }}
          title="Sign Out"
          aria-label="Sign Out"
          className={[
            "flex items-center gap-2.5 text-sm text-slate-500 hover:text-rose-400 hover:bg-slate-800 transition-colors px-3 py-2 rounded-lg w-full mt-1",
            collapsed ? "justify-center" : "text-left",
          ].join(" ")}
        >
          <span className="text-base leading-none">↩</span>
          <span className={collapsed ? "sr-only" : ""}>Sign Out</span>
        </button>
      </div>
    </div>
  );
}
