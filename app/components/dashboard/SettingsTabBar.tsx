"use client";

import { SettingsSection } from "@/app/components/dashboard/types";

// Horizontal section tabs, replacing the old vertical dark sidebar — the
// Settings page reads as "your company's control room" rather than a
// software config panel. "Preferences"/"Notifications"/"Billing" aren't
// separate pages (nothing distinct exists to show yet): they jump back to
// Company Info and scroll to the matching card there, since that's exactly
// where that content already lives.
const TABS: { key: SettingsSection; label: string; icon: string; anchor?: string }[] = [
  { key: "company", label: "Company Info", icon: "\u{1F3E2}" },
  { key: "services", label: "Services", icon: "\u{1F9F0}" },
  { key: "staff", label: "Employees", icon: "\u{1F465}" },
  { key: "archived", label: "Archived Clients", icon: "\u{1F4C1}" },
];

const ANCHOR_TABS: { label: string; icon: string; anchor: string }[] = [
  { label: "Preferences", icon: "\u{2699}\u{FE0F}", anchor: "company-preferences-card" },
  { label: "Notifications", icon: "\u{1F514}", anchor: "communication-preferences-card" },
  { label: "Billing", icon: "\u{1F4B3}", anchor: "subscription-card" },
];

export default function SettingsTabBar({
  activeSection,
  onSelect,
}: {
  activeSection: SettingsSection;
  onSelect: (s: SettingsSection) => void;
}) {
  function goToAnchor(anchor: string) {
    onSelect("company");
    // Wait a tick for the Company Info panel to mount before scrolling.
    window.setTimeout(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  const tabCls = (isActive: boolean) =>
    [
      "flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
      isActive
        ? "border-blue-600 text-blue-600"
        : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300",
    ].join(" ");

  return (
    <div className="flex items-center gap-1 border-b border-slate-200 overflow-x-auto">
      {TABS.map(({ key, label, icon }) => (
        <button key={key} onClick={() => onSelect(key)} className={tabCls(activeSection === key)}>
          <span className="text-[15px] leading-none">{icon}</span>
          {label}
        </button>
      ))}
      {ANCHOR_TABS.map(({ label, icon, anchor }) => (
        <button key={label} onClick={() => goToAnchor(anchor)} className={tabCls(false)}>
          <span className="text-[15px] leading-none">{icon}</span>
          {label}
        </button>
      ))}
    </div>
  );
}
