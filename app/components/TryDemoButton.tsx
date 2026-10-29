"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEMO_ENTRY_EMAIL, DEMO_ENTRY_PASSWORD, isValidDemoEntry } from "@/lib/demoLocal/entryGate";

// The public demo runs entirely in the browser (/demo, see lib/demoLocal/).
// "Enter the Experience" checks the published demo credentials against the
// local entry gate only -- no network request, no call to the real login route, so no
// real session or cookie is ever created from this flow.
export default function TryDemoButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  function handleEnterDemo() {
    setError("");
    if (!isValidDemoEntry(DEMO_ENTRY_EMAIL, DEMO_ENTRY_PASSWORD)) {
      setError("The demo could not be opened. Please try again.");
      return;
    }
    router.push("/demo");
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {children}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                Welcome to the ScheduleFlowTrack Experience
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="shrink-0 ml-3 text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-2 text-xs font-semibold uppercase tracking-wider text-blue-600">
              Experience. Interact. Simulate.
            </div>

            <div className="mt-3 space-y-2 text-sm text-slate-600">
              <p>This is not a tutorial.</p>
              <p>
                This is an interactive business simulation built around a fictional service
                company.
              </p>
              <p>Nothing you do affects a real business.</p>
            </div>

            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              All information shown in Demo Mode is fictional and for testing only.
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Email</span>
                <span className="font-medium text-slate-900">{DEMO_ENTRY_EMAIL}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Password</span>
                <span className="font-medium text-slate-900">{DEMO_ENTRY_PASSWORD}</span>
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-500">
              The demo runs entirely in your browser. No real account or sign-in is created.
            </p>

            {error && (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleEnterDemo}
              className="mt-4 w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              Enter the Experience
            </button>
          </div>
        </div>
      )}
    </>
  );
}
