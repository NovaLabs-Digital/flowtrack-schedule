"use client";

import { SettingsSection } from "@/app/components/dashboard/types";

const ITEMS: { key: SettingsSection; label: string }[] = [
  { key: "company", label: "Company Info" },
  { key: "services", label: "Services" },
  { key: "staff", label: "Staff / Team" },
  { key: "booking", label: "Public Booking" },
  { key: "archived", label: "Archived Clients" },
  { key: "preferences", label: "Preferences" },
  { key: "colors", label: "Colors" },
  { key: "darkmode", label: "Dark Mode" },
  { key: "future", label: "Future Items" },
];

export default function SettingsSidebar({
  activeSection,
  onSelect,
  onBack,
}: {
  activeSection: SettingsSection;
  onSelect: (s: SettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col h-full bg-[#1e293b] rounded-2xl text-white">
      <div className="px-4 pt-4 pb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Settings
        </div>
      </div>

      <div className="px-3 grid grid-cols-1 gap-0.5">
        {ITEMS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={[
              "w-full rounded-lg px-3 py-2 text-sm text-left transition-colors",
              activeSection === key
                ? "bg-blue-600 text-white font-medium"
                : "text-slate-300 hover:bg-slate-700 hover:text-white",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="mx-3 border-t border-slate-600" />
      <div className="p-3">
        <button
          onClick={onBack}
          className="w-full rounded-lg px-3 py-2 text-sm text-left text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
        >
          &#8592; Back to Schedule
        </button>
      </div>
    </div>
  );
}
