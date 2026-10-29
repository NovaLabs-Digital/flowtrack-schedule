"use client";

import { useState, useSyncExternalStore } from "react";
import { useDemoExperienceContext } from "@/app/components/demo-experience/DemoExperienceProvider";
import { getSnapshot, resetStore, subscribe } from "@/lib/demoLocal/store";

// Browser-local public demo only (reached via DashboardSettingsArea's
// isLocalDemo sidebar). Shows what the demo currently holds, restarts the
// guided experience, and resets the demo data. Counts are read live from the
// local demo store -- never hardcoded -- so they always match what is on
// screen, including anything the visitor has added or removed.
type Props = {
  onBack: () => void;
  // Full reload after a reset (throws away any component-local React state
  // still referencing a now-deleted fixture id). Overridable for tests only,
  // since jsdom's window.location cannot be spied on.
  navigateTo?: (url: string) => void;
};

function defaultNavigate(url: string) {
  window.location.assign(url);
}

export default function DemoControlsPanel({ onBack, navigateTo = defaultNavigate }: Props) {
  const { restart } = useDemoExperienceContext();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const stats = [
    { value: snapshot.clients.length, label: "Fictional Clients" },
    { value: snapshot.employees.length, label: "Fictional Employees" },
    { value: snapshot.services.length, label: "Fictional Services" },
    { value: snapshot.appointments.length, label: "Fictional Appointments" },
  ];

  function handleConfirmReset() {
    resetStore();
    navigateTo("/demo");
  }

  return (
    <div className="max-w-xl space-y-4 pb-4">
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
          {stats.map((s) => (
            <div key={s.label}>
              <div className="text-2xl font-bold text-slate-900">{s.value}</div>
              <div className="text-xs text-slate-500">{s.label}</div>
            </div>
          ))}
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

      {confirmingReset ? (
        <div className="rounded-2xl border border-rose-200 bg-white p-5 shadow-sm">
          <div className="text-sm font-semibold text-slate-900">Reset Demo</div>
          <div className="mt-2 text-sm text-slate-700">
            This will erase all current demo data and start over. This can't be undone.
          </div>
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={handleConfirmReset}
              className="flex-1 rounded-xl bg-rose-600 px-4 py-2 text-sm text-white hover:bg-rose-700"
            >
              Reset Demo Data
            </button>
            <button
              type="button"
              onClick={() => setConfirmingReset(false)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmingReset(true)}
          className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-100 transition-colors"
        >
          Reset Demo
        </button>
      )}
    </div>
  );
}
