"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function SettingsCard({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-lg shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className="text-xs text-slate-500">{subtitle}</div>
      </div>
    </div>
  );
}

// Settings tab (Screen 4) — minimal placeholder sections for v1, deliberately
// not a mobile rebuild of the full desktop Settings panel (CompanyInfoPanel,
// StaffPanel, ServicesPanel, etc.). Sign Out reuses the exact same
// /api/auth/logout mechanism already used by desktop TopBar.tsx and
// EmployeeSchedule.tsx — this app's auth is a custom session cookie, not the
// Supabase Auth SDK, so there's no separate "Supabase signOut()" to call;
// this is the actual existing sign-out logic, just reused here.
export default function MobileSettings({ isTester = false }: { isTester?: boolean }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleSignOut() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    router.push("/login");
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="text-base font-semibold text-slate-900">Settings</div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {isTester && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <div className="text-sm font-semibold text-amber-900">Demo Mode</div>
            <div className="mt-1 text-xs text-amber-800">
              All information shown in Demo Mode is fictional and for testing only. Settings
              are not available in demo sessions.
            </div>
          </div>
        )}

        {!isTester && (
          <>
            <SettingsCard icon="🏢" title="Company" subtitle="Business info, address, contact" />
            <SettingsCard icon="🧹" title="Services" subtitle="Service types, durations, colors" />
            <SettingsCard icon="👥" title="Staff" subtitle="Employees, positions, colors" />
            <SettingsCard icon="⚙️" title="Preferences" subtitle="App preferences" />
          </>
        )}

        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-lg shrink-0">
              👤
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Account</div>
              <div className="text-xs text-slate-500">Signed in</div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={loggingOut}
            className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 active:bg-rose-100 disabled:opacity-50 transition-colors"
          >
            {loggingOut ? "Signing out..." : "Sign Out"}
          </button>
        </div>

        {!isTester && (
          <div className="text-center text-xs text-slate-400 pt-2">
            Full settings management is available on desktop.
          </div>
        )}
      </div>
    </div>
  );
}
