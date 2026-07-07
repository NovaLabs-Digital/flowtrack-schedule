"use client";

import SettingsTabBar from "@/app/components/dashboard/SettingsTabBar";
import SettingsPanel from "@/app/components/dashboard/SettingsPanel";
import StaffPanel from "@/app/components/dashboard/StaffPanel";
import ServicesPanel from "@/app/components/dashboard/ServicesPanel";
import { useDemoExperienceContext } from "@/app/components/demo-experience/DemoExperienceProvider";
import { SettingsSection } from "@/app/components/dashboard/types";

type Props = {
  isTester: boolean;
  settingsSection: SettingsSection;
  onSettingsSelect: (s: SettingsSection) => void;
  onBack: () => void;
  onSignOut: () => void;
  signingOut: boolean;
};

// Owner always gets the real, unrestricted Settings sidebar/panel — untouched
// by anything below. For a tester session, Settings is normally replaced by
// the Demo Mode notice; the one exception is while the Interactive Business
// Experience is actively on the Employees or Services step, when the real
// Staff/Services panels (already scoped to demo-only data and demo-only
// writes at the API layer) become reachable so those two steps can be
// genuinely interactive. Outside that window, it's the notice again.
export default function DashboardSettingsArea({
  isTester,
  settingsSection,
  onSettingsSelect,
  onBack,
  onSignOut,
  signingOut,
}: Props) {
  const { active, currentStep, restart } = useDemoExperienceContext();

  if (!isTester) {
    return (
      <div className="flex flex-col flex-1 min-h-0 pt-2">
        <SettingsTabBar activeSection={settingsSection} onSelect={onSettingsSelect} />
        <div className="flex-1 min-h-0 overflow-auto pt-5">
          <SettingsPanel section={settingsSection} />
        </div>
      </div>
    );
  }

  const carveOutActive = active && (currentStep?.id === "employees" || currentStep?.id === "services");

  if (carveOutActive) {
    const section = settingsSection === "staff" || settingsSection === "services" ? settingsSection : "staff";
    return (
      <div className="flex gap-3 flex-1 min-h-0 pt-2">
        <aside className="shrink-0 w-[200px]">
          <div className="flex flex-col h-full bg-[#1e293b] rounded-2xl text-white">
            <div className="px-4 pt-4 pb-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Demo Settings</div>
            </div>
            <div className="px-3 grid grid-cols-1 gap-0.5">
              <button
                onClick={() => onSettingsSelect("staff")}
                className={[
                  "w-full rounded-lg px-3 py-2 text-sm text-left transition-colors",
                  section === "staff" ? "bg-blue-600 text-white font-medium" : "text-slate-300 hover:bg-slate-700 hover:text-white",
                ].join(" ")}
              >
                Staff / Team
              </button>
              <button
                onClick={() => onSettingsSelect("services")}
                className={[
                  "w-full rounded-lg px-3 py-2 text-sm text-left transition-colors",
                  section === "services" ? "bg-blue-600 text-white font-medium" : "text-slate-300 hover:bg-slate-700 hover:text-white",
                ].join(" ")}
              >
                Services
              </button>
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
        </aside>
        <main className="flex-1 min-w-0 max-w-3xl">
          {section === "staff" ? <StaffPanel isTester /> : <ServicesPanel isTester />}
        </main>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto pt-2">
      <div className="max-w-xl mx-auto space-y-4 pb-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-base font-semibold text-slate-900">Demo Mode</div>
          <div className="mt-2 text-sm text-slate-600">
            All information shown in Demo Mode is fictional and for testing only.
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Demo Company
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            Sunshine Property Services
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
            Demo Data
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-2xl font-bold text-slate-900">20</div>
              <div className="text-xs text-slate-500">Fictional Clients</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900">3</div>
              <div className="text-xs text-slate-500">Fictional Employees</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900">6</div>
              <div className="text-xs text-slate-500">Fictional Services</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-900">38</div>
              <div className="text-xs text-slate-500">Fictional Appointments</div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            restart();
            onBack();
          }}
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
        >
          Restart Experience
        </button>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm text-center text-sm text-slate-500">
          Full settings management is available in owner accounts.
        </div>

        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"
        >
          {signingOut ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    </div>
  );
}
