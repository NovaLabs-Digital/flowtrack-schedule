"use client";

import { SettingsSection } from "@/app/components/dashboard/types";

// Horizontal section tabs, replacing the old vertical dark sidebar — the
// Settings page reads as "your company's control room" rather than a
// software config panel. "Preferences"/"Notifications"/"Billing" aren't
// separate pages (nothing distinct exists to show yet): they jump back to
// Company Info and scroll to the matching card there, since that's exactly
// where that content already lives. Styled visibly lighter than the primary
// tabs, with a divider ahead of them, so the two navigation levels (switch
// section vs. scroll within a section) don't read as the same action.
const TABS: { key: SettingsSection; label: string }[] = [
  { key: "company", label: "Company Info" },
  { key: "services", label: "Services" },
  { key: "staff", label: "Employees" },
  { key: "archived", label: "Archived Clients" },
];

const ANCHOR_TABS: { label: string; anchor: string }[] = [
  { label: "Automation", anchor: "automation-card" },
  { label: "Preferences", anchor: "company-preferences-card" },
  { label: "Notifications", anchor: "communication-preferences-card" },
  { label: "Billing", anchor: "subscription-card" },
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
    // Company Info fetches its own data on mount, so switching from another
    // tab means the target card doesn't exist yet for a beat (an initial
    // "Loading..." render, then the real cards). Poll briefly instead of a
    // fixed delay, since a single short timeout raced this fetch and
    // silently no-op'd when jumping here from a different tab.
    let attempts = 0;
    const poll = window.setInterval(() => {
      attempts += 1;
      const el = document.getElementById(anchor);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        window.clearInterval(poll);
      } else if (attempts > 40) {
        window.clearInterval(poll); // ~2s — give up quietly rather than poll forever
      }
    }, 50);
  }

  const primaryTabCls = (isActive: boolean) =>
    [
      "px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
      isActive
        ? "border-blue-600 text-blue-600"
        : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300",
    ].join(" ");

  const anchorTabCls =
    "px-3 py-2.5 text-[13px] font-normal text-slate-400 border-b-2 border-transparent hover:text-slate-600 transition-colors whitespace-nowrap -mb-px";

  return (
    <div className="flex items-center gap-1 border-b border-slate-200 overflow-x-auto">
      {TABS.map(({ key, label }) => (
        <button key={key} onClick={() => onSelect(key)} className={primaryTabCls(activeSection === key)}>
          {label}
        </button>
      ))}
      <div className="w-px h-4 bg-slate-200 mx-2 shrink-0" />
      {ANCHOR_TABS.map(({ label, anchor }) => (
        <button key={label} onClick={() => goToAnchor(anchor)} className={anchorTabCls}>
          {label}
        </button>
      ))}
    </div>
  );
}
