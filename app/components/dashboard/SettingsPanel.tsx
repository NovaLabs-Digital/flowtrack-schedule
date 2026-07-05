"use client";

import { SettingsSection } from "@/app/components/dashboard/types";
import CompanyInfoPanel from "@/app/components/dashboard/CompanyInfoPanel";
import ServicesPanel from "@/app/components/dashboard/ServicesPanel";
import StaffPanel from "@/app/components/dashboard/StaffPanel";
import ArchivedClientsPanel from "@/app/components/dashboard/ArchivedClientsPanel";
import PublicBookingPanel from "@/app/components/dashboard/PublicBookingPanel";

const PLACEHOLDERS: Partial<Record<SettingsSection, { title: string; body: string }>> = {
  preferences: {
    title: "Preferences",
    body: "Notification settings, default views, timezone, and scheduling rules.",
  },
  colors: {
    title: "Colors",
    body: "Customize appointment card colors by service type or status.",
  },
  darkmode: {
    title: "Dark Mode",
    body: "Toggle dark mode appearance for the dashboard.",
  },
  future: {
    title: "Future Items",
    body: "Placeholder for upcoming features and integrations.",
  },
};

export default function SettingsPanel({ section }: { section: SettingsSection }) {
  if (section === "company") return <CompanyInfoPanel />;
  if (section === "services") return <ServicesPanel />;
  if (section === "staff") return <StaffPanel />;
  if (section === "archived") return <ArchivedClientsPanel />;
  if (section === "booking") return <PublicBookingPanel />;

  const panel = PLACEHOLDERS[section];
  if (!panel) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">{panel.title}</div>
      <div className="mt-3 text-sm text-slate-600">{panel.body}</div>
      <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <div className="text-sm text-slate-400">Settings workspace</div>
        <div className="mt-1 text-xs text-slate-400">
          Configuration options for {panel.title.toLowerCase()} will appear here.
        </div>
      </div>
    </div>
  );
}
