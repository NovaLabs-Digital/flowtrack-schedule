"use client";

import { useEffect, useState } from "react";

export default function PublicBookingPanel() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/company")
      .then((r) => r.json())
      .then((data) => {
        if (data.settings) {
          setEnabled(Boolean(data.settings.booking_enabled));
        }
      })
      .catch(() => setMessage({ type: "error", text: "Failed to load booking settings." }))
      .finally(() => setLoading(false));
  }, []);

  async function handleToggle() {
    const next = !enabled;
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_enabled: next }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMessage({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      setEnabled(next);
      setMessage({ type: "success", text: next ? "Public booking is now ON." : "Public booking is now OFF." });
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading booking settings...</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">Public Booking</div>
      <div className="mt-1 text-xs text-slate-500">
        When enabled, clients can request appointments from /book.
      </div>

      <div className="mt-5 flex items-center justify-between max-w-xl rounded-xl border border-slate-200 px-4 py-3">
        <div>
          <div className="text-sm font-medium text-slate-900">
            Online booking is {enabled ? "ON" : "OFF"}
          </div>
          <div className="text-xs text-slate-500">
            {enabled
              ? "Anyone visiting /book can request an appointment."
              : "/book shows an unavailable message instead of the form."}
          </div>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          disabled={saving}
          aria-pressed={enabled}
          className={[
            "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
            enabled ? "bg-emerald-500" : "bg-slate-300",
          ].join(" ")}
        >
          <span
            className={[
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
              enabled ? "translate-x-6" : "translate-x-1",
            ].join(" ")}
          />
        </button>
      </div>

      {message && (
        <div
          className={[
            "mt-4 max-w-xl rounded-xl border px-3 py-2 text-xs",
            message.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-rose-200 bg-rose-50 text-rose-700",
          ].join(" ")}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
