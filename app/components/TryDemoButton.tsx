"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEMO_EMAIL = "demo@scheduleflowtrack.com";
const DEMO_PASSWORD = "Demo2026!";

export default function TryDemoButton({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleDemoLogin() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || "Demo login failed.");
        return;
      }

      router.push(data.redirect || "/dashboard");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
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
              <h2 className="text-base font-semibold text-slate-900">Try Live Demo</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              All information shown in Demo Mode is fictional and for testing only.
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Email</span>
                <span className="font-medium text-slate-900">{DEMO_EMAIL}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Password</span>
                <span className="font-medium text-slate-900">{DEMO_PASSWORD}</span>
              </div>
            </div>

            {error && (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleDemoLogin}
              disabled={loading}
              className="mt-4 w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {loading ? "Signing in..." : "Log In to Demo"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
