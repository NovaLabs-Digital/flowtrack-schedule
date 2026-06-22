"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function TopBar({
  onGoToday,
  onAdd,
  weekOffset,
  onWeekChange,
}: {
  onGoToday: () => void;
  onAdd: () => void;
  weekOffset: number;
  onWeekChange: (offset: number) => void;
}) {
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    router.push("/");
  }

  return (
    <div className="shrink-0 bg-gradient-to-b from-slate-50 to-slate-100/80 border-b border-slate-200 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        {/* Left: navigation controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onGoToday}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            <span className="text-base leading-none">📅</span>
            Today
          </button>
          <button
            onClick={() => onWeekChange(weekOffset - 1)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            ← Prev
          </button>
          <button
            onClick={() => onWeekChange(weekOffset + 1)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            Next →
          </button>

          <div className="w-px h-6 bg-slate-300 mx-1" />

          <button
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors"
            title="Date picker (coming soon)"
          >
            <span className="text-sm leading-none">📆</span>
          </button>
          <button
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors"
            title="View options (coming soon)"
          >
            <span className="text-sm leading-none">☰</span>
          </button>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={onAdd}
            className="flex items-center gap-1.5 rounded-lg bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            <span className="text-base leading-none">+</span>
            Add Appointment
          </button>

          <div className="relative">
            <input
              type="text"
              placeholder="Search clients..."
              className="rounded-lg border border-slate-300 bg-white pl-3 pr-8 py-2 text-sm text-slate-700 shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-[160px] transition-colors"
              readOnly
              title="Search (coming soon)"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
          </div>

          <button
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors relative"
            title="Notifications (coming soon)"
          >
            <span className="text-sm leading-none">🔔</span>
          </button>

          {/* User avatar + menu */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-[#0f172a] text-white text-xs font-semibold shadow-sm hover:bg-slate-800 transition-colors"
              title="Account"
            >
              AW
            </button>

            {showUserMenu && (
              <div className="absolute top-full mt-1 right-0 w-44 rounded-xl border border-slate-200 bg-white shadow-lg p-1 z-50">
                <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100">
                  Signed in
                </div>
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs text-rose-700 hover:bg-rose-50 transition-colors mt-1"
                >
                  {loggingOut ? "Signing out..." : "Sign Out"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
