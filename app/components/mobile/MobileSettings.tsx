"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Wrench, Users, Archive, Repeat, Receipt, Settings as SettingsIcon, User, ChevronLeft, type LucideIcon } from "lucide-react";
import SettingsPanel from "@/app/components/dashboard/SettingsPanel";
import type { SettingsSection } from "@/app/components/dashboard/types";

function SettingsCard({
  icon: Icon,
  title,
  subtitle,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={[
        "w-full rounded-xl border border-slate-200 bg-white p-4 flex items-center gap-3 text-left",
        onClick ? "active:bg-slate-50 transition-colors" : "",
      ].join(" ")}
    >
      <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0 text-slate-600">
        <Icon aria-hidden="true" size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className="text-xs text-slate-500">{subtitle}</div>
      </div>
    </Tag>
  );
}

// Same 6 real sections desktop's SettingsTabBar.tsx offers as primary tabs
// (Company Info, Services, Employees, Archived Clients, Recurring Series,
// Billing) -- same labels, same SettingsSection values, so tapping one here
// renders the exact same SettingsPanel/real-panel component desktop uses,
// never a mobile reimplementation.
const DEMO_SECTIONS: { section: SettingsSection; icon: LucideIcon; title: string; subtitle: string }[] = [
  { section: "company", icon: Building2, title: "Company Info", subtitle: "Business info, address, contact" },
  { section: "services", icon: Wrench, title: "Services", subtitle: "Service types, durations, colors" },
  { section: "staff", icon: Users, title: "Employees", subtitle: "Staff, positions, colors" },
  { section: "archived", icon: Archive, title: "Archived Clients", subtitle: "Restore a previously archived client" },
  { section: "recurring", icon: Repeat, title: "Recurring Series", subtitle: "Review and activate recurring series" },
  { section: "billing", icon: Receipt, title: "Billing", subtitle: "Completed jobs, invoices, payments" },
];

// Settings tab (Screen 4). For a REAL owner, this stays the minimal,
// non-interactive placeholder it has always been for v1 (deliberately not a
// mobile rebuild of the full desktop Settings panel) -- completely
// unchanged by anything below. Sign Out reuses the exact same
// /api/auth/logout mechanism already used by desktop TopBar.tsx and
// EmployeeSchedule.tsx -- this app's auth is a custom session cookie, not
// the Supabase Auth SDK, so there's no separate "Supabase signOut()" to
// call; this is the actual existing sign-out logic, just reused here.
//
// Browser-local public demo (app/demo/page.tsx) only: isLocalDemo reaches a
// DIFFERENT, genuinely interactive branch -- a simple section picker that,
// on tap, renders the real SettingsPanel (the exact same component desktop
// uses for every one of its 6 primary tabs), not the static placeholder
// cards. This was a real gap: an earlier pass only unlocked the existing
// placeholder cards (which have never been interactive, even for a real
// owner), which did not satisfy "access to working settings panels." The
// old `isTester` dead-end ("Settings are not available in demo sessions")
// stays, unchanged, for the real shared-backend tester path (isTester &&
// !isLocalDemo). Omitted (false) everywhere else, leaving every existing
// caller byte-for-byte unchanged.
export default function MobileSettings({
  isTester = false,
  isLocalDemo = false,
  onSignOut: onSignOutOverride,
  canMutateOperationalData = false,
  isTrialing = false,
  timezone,
  workspaceId,
  userId,
}: {
  isTester?: boolean;
  isLocalDemo?: boolean;
  // Override for the real handleSignOut below, used ONLY by app/demo/
  // DemoPageClient.tsx (via MobileDashboard) so Sign Out can end the local
  // demo session and force a full reload instead of a real /api/auth/logout
  // + client-side nav -- same pattern as DashboardShell.tsx's own onSignOut
  // override. Omitted everywhere else, so the real app's Sign Out is
  // unchanged.
  onSignOut?: () => void;
  // The following 5 are only ever read inside the isLocalDemo branch below,
  // forwarded straight through to the real SettingsPanel exactly like
  // DashboardSettingsArea.tsx does on desktop -- defaulted so the real
  // owner's render path (which never passes them) is unaffected either way.
  canMutateOperationalData?: boolean;
  isTrialing?: boolean;
  timezone?: string;
  workspaceId?: string;
  userId?: string;
}) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [mobileSection, setMobileSection] = useState<SettingsSection | null>(null);

  async function handleSignOut() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    router.push("/login");
  }

  if (isLocalDemo && mobileSection) {
    const activeLabel = DEMO_SECTIONS.find((s) => s.section === mobileSection)?.title ?? "Settings";
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="shrink-0 bg-white border-b border-slate-200 px-2 py-3 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMobileSection(null)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-sm font-medium text-slate-600 active:bg-slate-100 transition-colors"
          >
            <ChevronLeft aria-hidden="true" size={18} />
            Settings
          </button>
          <div className="text-sm font-semibold text-slate-900 pl-1">{activeLabel}</div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">
          <SettingsPanel
            section={mobileSection}
            canMutateOperationalData={canMutateOperationalData}
            isTrialing={isTrialing}
            timezone={timezone ?? ""}
            workspaceId={workspaceId ?? ""}
            userId={userId ?? ""}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="text-base font-semibold text-slate-900">Settings</div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {isTester && !isLocalDemo && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
            <div className="text-sm font-semibold text-amber-900">Demo Mode</div>
            <div className="mt-1 text-xs text-amber-800">
              All information shown in Demo Mode is fictional and for testing only. Settings
              are not available in demo sessions.
            </div>
          </div>
        )}

        {!isTester && !isLocalDemo && (
          <>
            <SettingsCard icon={Building2} title="Company" subtitle="Business info, address, contact" />
            <SettingsCard icon={Wrench} title="Services" subtitle="Service types, durations, colors" />
            <SettingsCard icon={Users} title="Staff" subtitle="Employees, positions, colors" />
            <SettingsCard icon={SettingsIcon} title="Preferences" subtitle="App preferences" />
          </>
        )}

        {isLocalDemo &&
          DEMO_SECTIONS.map((s) => (
            <SettingsCard
              key={s.section}
              icon={s.icon}
              title={s.title}
              subtitle={s.subtitle}
              onClick={() => setMobileSection(s.section)}
            />
          ))}

        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center shrink-0 text-slate-600">
              <User aria-hidden="true" size={20} />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Account</div>
              <div className="text-xs text-slate-500">Signed in</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOutOverride ?? handleSignOut}
            disabled={loggingOut}
            className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 active:bg-rose-100 disabled:opacity-50 transition-colors"
          >
            {loggingOut ? "Signing out..." : "Sign Out"}
          </button>
        </div>

        {!isTester && !isLocalDemo && (
          <div className="text-center text-xs text-slate-400 pt-2">
            Full settings management is available on desktop.
          </div>
        )}
      </div>
    </div>
  );
}
