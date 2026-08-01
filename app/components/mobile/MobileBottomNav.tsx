"use client";

import { SUPPORT_MAILTO_URL } from "@/lib/support";

export type MobileTabKey = "today" | "schedule" | "clients" | "settings";

const TABS: { key: MobileTabKey; label: string; icon: string }[] = [
  { key: "today", label: "Today", icon: "📅" },
  { key: "schedule", label: "Schedule", icon: "🗓️" },
  { key: "clients", label: "Clients", icon: "👥" },
];

// Screen 4 of the approved mockup — persistent bottom navigation, always
// accessible, large one-thumb-friendly touch targets. Contact/Need Help is
// placed immediately before Settings, matching the desktop sidebar
// (LeftBar.tsx) -- a mailto: link, not a tab switch, so it's a plain <a>
// rather than one of the state-driven TABS buttons.
export default function MobileBottomNav({
  active,
  onChange,
}: {
  active: MobileTabKey;
  onChange: (tab: MobileTabKey) => void;
}) {
  return (
    <nav className="shrink-0 bg-white border-t border-slate-200 safe-area-bottom">
      <div className="grid grid-cols-5 h-16">
        {TABS.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={[
              "flex flex-col items-center justify-center gap-0.5 text-xs transition-colors",
              active === key ? "text-blue-600 font-medium" : "text-slate-400",
            ].join(" ")}
          >
            <span className="text-xl leading-none">{icon}</span>
            {label}
          </button>
        ))}
        <a
          href={SUPPORT_MAILTO_URL}
          className="flex flex-col items-center justify-center gap-0.5 text-xs transition-colors text-slate-400"
        >
          <span className="text-xl leading-none">&#9993;</span>
          Contact
        </a>
        <button
          type="button"
          onClick={() => onChange("settings")}
          className={[
            "flex flex-col items-center justify-center gap-0.5 text-xs transition-colors",
            active === "settings" ? "text-blue-600 font-medium" : "text-slate-400",
          ].join(" ")}
        >
          <span className="text-xl leading-none">⚙</span>
          Settings
        </button>
      </div>
    </nav>
  );
}
