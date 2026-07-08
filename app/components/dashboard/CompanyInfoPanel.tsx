"use client";

import { useEffect, useState } from "react";
import SettingsCard, { DirtyHint, PreviewPill } from "@/app/components/dashboard/SettingsCard";
import SettingsToggle from "@/app/components/dashboard/SettingsToggle";
import CompanyStatusStrip from "@/app/components/dashboard/CompanyStatusStrip";

type CompanyForm = { company_name: string; phone: string; email: string; address: string; city: string; state: string; zip: string };
type Status = { emailConfigured: boolean; smsConfigured: boolean; activeStaff: number; totalStaff: number; timezoneLabel: string };

const EMPTY: CompanyForm = { company_name: "", phone: "", email: "", address: "", city: "", state: "", zip: "" };
const inputCls =
  "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
// Same field styling as inputCls but without w-full, for inputs that sit
// side-by-side in a row (e.g. Business Hours' time range) — kept as a
// separate class string rather than string-concatenating "w-24" onto
// inputCls, since two same-specificity Tailwind utility classes race on
// stylesheet order, not on their order in the className string.
const inputInlineCls =
  "rounded-xl border border-slate-300 px-3 py-2 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
const selectCls =
  "rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
const primaryBtnCls =
  "rounded-xl bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-40 transition-colors";

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export default function CompanyInfoPanel() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);

  // Real, persisted fields — one combined form, one Save Changes button,
  // matching the reference image (this replaces Phase A's Business
  // Identity / Contact & Location split, per direction to match a single
  // Company Information hero card).
  const [form, setForm] = useState<CompanyForm>(EMPTY);
  const [saved, setSaved] = useState<CompanyForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // Distinguishes "initial load failed" (Retry re-fetches) from a failed
  // Save (which reuses `msg` too, but retrying that should resubmit the
  // form, not reload it).
  const [loadFailed, setLoadFailed] = useState(false);

  // Shared toast for the "coming soon" affordances scattered across cards
  // (logo upload, cancellation policy, subscription management) — separate
  // from `msg`, which is specifically the Company Information save result.
  const [toast, setToast] = useState<string | null>(null);
  function showComingSoon(text: string) {
    setToast(text);
    window.setTimeout(() => setToast(null), 2500);
  }

  // Booking toggle — same real booking_enabled column as before, just
  // living inside the single hero card's Save now instead of its own card.
  const [bookingEnabled, setBookingEnabled] = useState(false);
  const [bookingSaved, setBookingSaved] = useState(false);

  // Visual-only fields with no backing column yet (no schema change made
  // for this pass) — interactive so the page doesn't look broken, but not
  // included in the Save payload. See final report for what's deferred.
  const [website, setWebsite] = useState("");
  const [hoursDay, setHoursDay] = useState("Monday - Friday");
  const [hoursStart, setHoursStart] = useState("7:00 AM");
  const [hoursEnd, setHoursEnd] = useState("5:00 PM");

  // Company Preferences — preview only, nothing persisted.
  const [defaultSlot, setDefaultSlot] = useState("30 minutes");
  const [buffer, setBuffer] = useState("15 minutes");
  const [defaultStatus, setDefaultStatus] = useState("Scheduled");
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [showTravelTime, setShowTravelTime] = useState(true);
  const [defaultView, setDefaultView] = useState("Weekdays");

  // Communication Preferences — preview only, nothing persisted.
  const [autoEmail, setAutoEmail] = useState(true);
  const [autoSms, setAutoSms] = useState(true);
  const [reminder, setReminder] = useState("1 day before, 8:00 PM");
  const [followUp, setFollowUp] = useState("1 day after");

  function loadCompanySettings() {
    setLoadFailed(false);
    fetch("/api/settings/company")
      .then((r) => r.json())
      .then((data) => {
        const s = data.settings;
        if (s) {
          const next: CompanyForm = {
            company_name: s.company_name ?? "",
            phone: s.phone ?? "",
            email: s.email ?? "",
            address: s.address ?? "",
            city: s.city ?? "",
            state: s.state ?? "",
            zip: s.zip ?? "",
          };
          setForm(next);
          setSaved(next);
          setBookingEnabled(Boolean(s.booking_enabled));
          setBookingSaved(Boolean(s.booking_enabled));
        }
        if (data.status) setStatus(data.status);
      })
      .catch(() => { setMsg({ type: "error", text: "Failed to load company settings." }); setLoadFailed(true); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadCompanySettings(); }, []);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || bookingEnabled !== bookingSaved;

  async function handleSave() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, booking_enabled: bookingEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      setSaved(form);
      setBookingSaved(bookingEnabled);
      setMsg({ type: "success", text: "Saved." });
    } catch {
      setMsg({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading company settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-4xl relative">
      {toast && (
        <div className="fixed top-4 right-4 z-50 rounded-xl border border-slate-200 bg-slate-900 text-white px-4 py-2.5 text-xs font-medium shadow-lg">
          {toast}
        </div>
      )}
      {status && (
        <CompanyStatusStrip
          emailConfigured={status.emailConfigured}
          smsConfigured={status.smsConfigured}
          bookingEnabled={bookingEnabled}
          activeStaff={status.activeStaff}
          totalStaff={status.totalStaff}
        />
      )}

      <SettingsCard
        title="Company Information"
        helper="This information is used in your communications and scheduling."
        headerRight={
          <button type="button" disabled={saving || !dirty} onClick={handleSave} className={primaryBtnCls}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        }
      >
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="shrink-0 flex flex-col items-center gap-2 w-28">
            <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 text-white flex items-center justify-center text-2xl font-bold shadow-sm">
              {initials(form.company_name || "Your Company")}
            </div>
            <button
              type="button"
              onClick={() => showComingSoon("Logo upload is coming soon.")}
              className="text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              Change Logo
            </button>
            <div className="text-[11px] text-slate-400 text-center leading-tight">Recommended: 300&times;300px</div>
          </div>

          <div className="flex-1 grid sm:grid-cols-2 gap-x-6 gap-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Company Name</label>
              <input
                type="text"
                value={form.company_name}
                onChange={(e) => setForm((p) => ({ ...p, company_name: e.target.value }))}
                className={inputCls}
                placeholder="e.g. Alberto's Cleaning Services"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Address</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                className={inputCls}
                placeholder="123 Main St"
              />
              <div className="grid grid-cols-3 gap-2 mt-2">
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm((p) => ({ ...p, city: e.target.value }))}
                  className={inputCls}
                  placeholder="City"
                />
                <input
                  type="text"
                  value={form.state}
                  onChange={(e) => setForm((p) => ({ ...p, state: e.target.value }))}
                  className={inputCls}
                  placeholder="State"
                />
                <input
                  type="text"
                  value={form.zip}
                  onChange={(e) => setForm((p) => ({ ...p, zip: e.target.value }))}
                  className={inputCls}
                  placeholder="ZIP"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Phone</label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                className={inputCls}
                placeholder="+13861234567"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Business Hours <span className="font-normal text-slate-400">(preview)</span>
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                <select value={hoursDay} onChange={(e) => setHoursDay(e.target.value)} className={selectCls}>
                  <option>Monday - Friday</option>
                  <option>Every day</option>
                  <option>Monday - Saturday</option>
                </select>
                <input
                  type="text"
                  value={hoursStart}
                  onChange={(e) => setHoursStart(e.target.value)}
                  className={inputInlineCls}
                />
                <span className="text-slate-400 text-sm">&ndash;</span>
                <input
                  type="text"
                  value={hoursEnd}
                  onChange={(e) => setHoursEnd(e.target.value)}
                  className={inputInlineCls}
                />
              </div>
              <button type="button" className="mt-1.5 text-xs font-medium text-blue-600 hover:text-blue-700">
                + Add hours
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                className={inputCls}
                placeholder="info@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Time Zone</label>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                {status?.timezoneLabel ?? "Eastern Time (US & Canada)"}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Matches your appointment scheduling — not yet editable here.</div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Website <span className="font-normal text-slate-400">(preview)</span>
              </label>
              <input
                type="text"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className={inputCls}
                placeholder="www.yourcompany.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Allow clients to book online</label>
              <div className="pt-1">
                <SettingsToggle
                  checked={bookingEnabled}
                  onChange={setBookingEnabled}
                  label="Public booking page"
                  helper="Included in Save Changes above"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <DirtyHint dirty={dirty} />
        </div>

        {msg && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs flex items-center justify-between gap-3",
              msg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            <span>{msg.text}</span>
            {loadFailed && (
              <button
                type="button"
                onClick={() => { setLoading(true); setMsg(null); loadCompanySettings(); }}
                className="shrink-0 font-medium underline hover:no-underline"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </SettingsCard>

      <div className="grid sm:grid-cols-2 gap-5">
        <SettingsCard
          id="company-preferences-card"
          title="Company Preferences"
          badge={<PreviewPill />}
          helper="Set your default communication and scheduling preferences."
        >
          <div className="space-y-0 divide-y divide-slate-100">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Default Time Slot</span>
              <select value={defaultSlot} onChange={(e) => setDefaultSlot(e.target.value)} className={selectCls}>
                <option>15 minutes</option>
                <option>30 minutes</option>
                <option>45 minutes</option>
                <option>60 minutes</option>
              </select>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Buffer Time Between Appointments</span>
              <select value={buffer} onChange={(e) => setBuffer(e.target.value)} className={selectCls}>
                <option>None</option>
                <option>5 minutes</option>
                <option>15 minutes</option>
                <option>30 minutes</option>
              </select>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Default Appointment Status</span>
              <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)} className={selectCls}>
                <option>Scheduled</option>
                <option>Confirmed</option>
              </select>
            </div>
            <div className="py-2.5">
              <SettingsToggle checked={allowOverlap} onChange={setAllowOverlap} label="Allow Overlapping Appointments" />
            </div>
            <div className="py-2.5">
              <SettingsToggle checked={showTravelTime} onChange={setShowTravelTime} label="Show Travel Time" />
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Default View</span>
              <select value={defaultView} onChange={(e) => setDefaultView(e.target.value)} className={selectCls}>
                <option>Day</option>
                <option>Weekdays</option>
                <option>Week</option>
              </select>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          id="communication-preferences-card"
          title="Communication Preferences"
          badge={<PreviewPill />}
          helper="Default settings for client communications."
        >
          <div className="space-y-0 divide-y divide-slate-100">
            <div className="py-2.5">
              <SettingsToggle checked={autoEmail} onChange={setAutoEmail} label="Auto Email Confirmations" />
            </div>
            <div className="py-2.5">
              <SettingsToggle checked={autoSms} onChange={setAutoSms} label="Auto SMS Confirmations" />
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Reminder (Day Before)</span>
              <select value={reminder} onChange={(e) => setReminder(e.target.value)} className={selectCls}>
                <option>1 day before, 8:00 PM</option>
                <option>1 day before, 6:00 PM</option>
                <option>2 hours before</option>
              </select>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Follow Up After Job</span>
              <select value={followUp} onChange={(e) => setFollowUp(e.target.value)} className={selectCls}>
                <option>Off</option>
                <option>1 day after</option>
                <option>3 days after</option>
              </select>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-slate-700">Cancellation Policy</span>
              <button
                type="button"
                onClick={() => showComingSoon("Cancellation policy editing is coming soon.")}
                className="text-xs font-medium text-blue-600 hover:text-blue-700"
              >
                Edit Policy
              </button>
            </div>
          </div>
        </SettingsCard>
      </div>

      <SettingsCard id="subscription-card" title="Subscription & Plan" badge={<PreviewPill />} helper="Your Nova Labs Schedule plan and billing.">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-8">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Plan</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">Standard</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Status</div>
              <div className="mt-1">
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full text-emerald-600 bg-emerald-50">Active</span>
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Billing</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">Managed by Nova Labs Digital</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => showComingSoon("Subscription management is coming soon.")}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Manage Subscription
          </button>
        </div>
      </SettingsCard>
    </div>
  );
}
