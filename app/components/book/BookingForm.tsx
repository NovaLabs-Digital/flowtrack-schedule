"use client";

import { useEffect, useMemo, useState } from "react";

type Service = { name: string; description: string | null; duration_minutes: number };

type FormState = {
  name: string;
  phone: string;
  email: string;
  address: string;
  service_type: string;
  date: string; // YYYY-MM-DD
  notes: string;
};

const EMPTY: FormState = { name: "", phone: "", email: "", address: "", service_type: "", date: "", notes: "" };

const inputCls =
  "w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
const labelCls = "block text-xs font-medium text-slate-600 mb-1";

// Matches lib/availability.ts's BUSINESS_TZ — kept as a plain string here
// since this is a client component and can't import a server-only lib
// constant; both represent the same single business timezone.
const BUSINESS_TZ = "America/New_York";

function formatSlotTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TZ,
  }).format(new Date(iso));
}

function todayDateInputValue(): string {
  // A client-side default only — the server independently validates the
  // real business-local date, so a few hours of client/server clock or
  // timezone skew here just means slightly conservative slot options, never
  // a security or correctness issue.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function BookingForm({ services, companyName }: { services: Service[]; companyName: string }) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [slots, setSlots] = useState<string[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<string>("");
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [done, setDone] = useState(false);

  const minDate = useMemo(() => todayDateInputValue(), []);

  useEffect(() => {
    setSelectedSlot("");
    setSlots([]);
    setSlotsError("");
    if (!form.service_type || !form.date) return;

    setSlotsLoading(true);
    const params = new URLSearchParams({ service: form.service_type, date: form.date });
    fetch(`/api/book/availability?${params.toString()}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || "Could not load available times.");
        setSlots(data.slots || []);
      })
      .catch((e) => setSlotsError(e.message || "Could not load available times."))
      .finally(() => setSlotsLoading(false));
  }, [form.service_type, form.date]);

  const canSubmit =
    form.name.trim() &&
    form.phone.trim() &&
    form.address.trim() &&
    form.service_type &&
    form.date &&
    selectedSlot &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/appointments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          address: form.address.trim(),
          service_type: form.service_type,
          scheduled_for: selectedSlot,
          notes: form.notes.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setSubmitError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <main className="max-w-lg mx-auto px-4 py-16">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-slate-900">Appointment Requested</h1>
          <p className="mt-3 text-sm text-slate-600 leading-relaxed">
            Thank you. Your appointment has been scheduled.
            <br />
            We look forward to seeing you.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-lg mx-auto px-4 py-10 space-y-5">
      <div className="text-center space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">
          {companyName ? `Book with ${companyName}` : "Request an Appointment"}
        </h1>
        <p className="text-sm text-slate-500">Tell us a bit about what you need and pick a time that works for you.</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm space-y-4">
        <div>
          <label className={labelCls}>Name</label>
          <input
            className={inputCls}
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="Your full name"
            autoComplete="name"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Phone</label>
            <input
              className={inputCls}
              type="tel"
              value={form.phone}
              onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
              placeholder="(555) 555-0100"
              autoComplete="tel"
            />
          </div>
          <div>
            <label className={labelCls}>
              Email <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              className={inputCls}
              type="email"
              value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
        </div>

        <div>
          <label className={labelCls}>Address</label>
          <input
            className={inputCls}
            value={form.address}
            onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
            placeholder="123 Main St, City"
            autoComplete="street-address"
          />
        </div>

        <div>
          <label className={labelCls}>Service</label>
          <select
            className={inputCls}
            value={form.service_type}
            onChange={(e) => setForm((p) => ({ ...p, service_type: e.target.value }))}
          >
            <option value="">Select a service...</option>
            {services.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          {services.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">No services are set up yet — please contact the business directly.</p>
          )}
        </div>

        <div>
          <label className={labelCls}>Preferred Date</label>
          <input
            className={inputCls}
            type="date"
            min={minDate}
            value={form.date}
            onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))}
          />
        </div>

        {form.service_type && form.date && (
          <div>
            <label className={labelCls}>Preferred Time</label>
            {slotsLoading && <p className="text-sm text-slate-500">Loading available times...</p>}
            {!slotsLoading && slotsError && <p className="text-sm text-rose-600">{slotsError}</p>}
            {!slotsLoading && !slotsError && slots.length === 0 && (
              <p className="text-sm text-slate-500">No times available that day. Please choose another date.</p>
            )}
            {!slotsLoading && !slotsError && slots.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => setSelectedSlot(slot)}
                    className={[
                      "rounded-xl border px-2 py-2 text-xs font-medium transition-colors",
                      selectedSlot === slot
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-slate-300 text-slate-600 hover:border-slate-400",
                    ].join(" ")}
                  >
                    {formatSlotTime(slot)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <label className={labelCls}>
            Notes <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            className={inputCls}
            rows={3}
            value={form.notes}
            onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
            placeholder="Anything we should know before we arrive?"
          />
        </div>

        {submitError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{submitError}</div>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {submitting ? "Requesting..." : "Request Appointment"}
        </button>
      </div>
    </main>
  );
}
