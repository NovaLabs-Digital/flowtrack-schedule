"use client";

import { useEffect, useRef, useState } from "react";
import SettingsCard, { DirtyHint, PreviewPill } from "@/app/components/dashboard/SettingsCard";
import SettingsToggle from "@/app/components/dashboard/SettingsToggle";
import CompanyStatusStrip from "@/app/components/dashboard/CompanyStatusStrip";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";
import { WEEKDAY_KEYS, type WeekdayKey } from "@/lib/businessHours";

// Phase 5.5E-E1F: two separate logical mutation-control areas in this
// panel -- Company Information and Automation are independent cards with
// independent Save actions and independent dirty-state, matching this
// codebase's own card-splitting principle (one card answers one question) --
// so each gets its own notice rather than sharing one across the whole
// panel. Distinct from every other component's notice id established in
// earlier phases.
const COMPANY_NOTICE_ID = "company-info-restricted-notice";
const AUTOMATION_NOTICE_ID = "company-automation-restricted-notice";
// Phase 4: Business Hours is its own card (its own question -- "how does my
// business operate" -- distinct from Company Information's "who are we"),
// so it gets its own notice id, matching the Company Information/Automation
// precedent above.
const HOURS_NOTICE_ID = "company-hours-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

type CompanyForm = { company_name: string; phone: string; email: string; address: string; city: string; state: string; zip: string };
type Status = { emailConfigured: boolean; smsConfigured: boolean; activeStaff: number; totalStaff: number; timezoneLabel: string };

type TimeRange = { start: string; end: string };
type BusinessHoursForm = Record<WeekdayKey, TimeRange[]>;

const EMPTY: CompanyForm = { company_name: "", phone: "", email: "", address: "", city: "", state: "", zip: "" };
const EMPTY_HOURS: BusinessHoursForm = Object.fromEntries(WEEKDAY_KEYS.map((d) => [d, [] as TimeRange[]])) as BusinessHoursForm;
const inputCls =
  "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
const selectCls =
  "rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
// A native time-of-day input at a compact width silently clips its AM/PM
// segment on this browser/OS combination -- 17:00 visibly rendered as
// "05:00" with no PM indicator, indistinguishable from 05:00. A <select> of
// plain option text can't clip that way, so Business Hours' start/end
// controls use one (see BUSINESS_HOURS_TIME_OPTIONS below), matching the
// same value="HH:mm"/label="h:mm AM/PM" pattern AppointmentModal.tsx's own
// buildTimeSlots() already establishes for its Time In/Time Out selects --
// wide enough ("12:00 AM" et al.) to never truncate its own label either.
const timeSelectCls =
  "rounded-xl border border-slate-300 px-2 py-2 text-sm bg-white w-[7.5rem] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";
const primaryBtnCls =
  "rounded-xl bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-40 transition-colors";

// Full 24-hour range (Business Hours can span any wall-clock time, unlike
// AppointmentModal's 6am-8pm appointment-scheduling window) at the same
// 15-minute granularity as that existing precedent. option.value is always
// the normalized "HH:mm" string that gets stored -- option.label is the
// friendly, unambiguous "h:mm AM/PM" text the owner actually sees.
function buildBusinessHoursTimeOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      options.push({ value, label: `${h12}:${String(m).padStart(2, "0")} ${ampm}` });
    }
  }
  return options;
}
const BUSINESS_HOURS_TIME_OPTIONS = buildBusinessHoursTimeOptions();

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export default function CompanyInfoPanel({
  canMutateOperationalData,
  isTrialing,
}: {
  canMutateOperationalData: boolean;
  // Phase 5.6D: true only for a plain trialing subscription with no
  // cancellation already scheduled -- see lib/entitlementView.ts. The one
  // condition under which the Cancel Free Trial action below is offered.
  isTrialing: boolean;
}) {
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

  // Phase 5.6D — Cancel Free Trial: a two-step confirm (never a single
  // click) that ends TRIAL access immediately via POST
  // /api/stripe/cancel-trial. Separate from `msg` above -- this is its own
  // real network action, not a Company Information save result. `confirming`
  // gates the inline warning;
  // `cancelling` plus the synchronous `cancelInFlightRef` guard (the same
  // double-click protection pattern already established elsewhere in this
  // codebase's billing-action components) prevents a duplicate request
  // from one rapid double-click.
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelResult, setCancelResult] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const cancelInFlightRef = useRef(false);

  async function handleCancelTrial() {
    if (cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;
    setCancelling(true);
    setCancelResult(null);
    try {
      const res = await fetch("/api/stripe/cancel-trial", { method: "POST" });
      const data = await res.json().catch(() => ({}) as { error?: string });
      if (res.ok) {
        setConfirmingCancel(false);
        setCancelResult({ type: "success", text: "Your free trial has ended immediately, as requested." });
      } else {
        setCancelResult({ type: "error", text: data.error || "Unable to cancel your trial right now. Please try again." });
      }
    } catch {
      setCancelResult({ type: "error", text: "Unable to cancel your trial right now. Please try again." });
    } finally {
      cancelInFlightRef.current = false;
      setCancelling(false);
    }
  }

  // Automation toggles — real, persisted columns, live together in their
  // own Automation card (Settings → Automation) with a shared Save,
  // separate from the Company Information profile fields above.
  //
  // Phase 5.7C: both toggles MUST default to false, matching the fail-closed
  // semantics every server-side consumer already enforces
  // (Boolean(data?.notifications_enabled) in lib/notify.ts and
  // app/api/cron/reminders/route.ts -- a missing row or missing column reads
  // as "off," never "on"). Before this fix, notificationsEnabled/
  // notificationsSaved defaulted to true, so a brand-new workspace with no
  // company_settings row yet (see docs/CONTROLLED_CUSTOMER_ONBOARDING.md)
  // would silently treat notifications as already-on -- and because
  // handleSaveAutomation always sends BOTH toggle values together (see
  // below), saving after touching only the booking toggle would persist
  // that never-loaded true as if the owner had explicitly enabled it. The
  // load effect below (loadCompanySettings) is the only thing ever allowed
  // to move either of these off false -- and only with a genuinely loaded,
  // persisted value, never a default.
  const [bookingEnabled, setBookingEnabled] = useState(false);
  const [bookingSaved, setBookingSaved] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationsSaved, setNotificationsSaved] = useState(false);

  // Visual-only fields with no backing column yet (no schema change made
  // for this pass) — interactive so the page doesn't look broken, but not
  // included in the Save payload. See final report for what's deferred.
  const [website, setWebsite] = useState("");

  // Phase 4: Business Hours -- real, persisted (company_settings.business_hours),
  // its own card with its own Save, matching the Automation card's
  // independent-save precedent above. Starts all-Closed (EMPTY_HOURS) until
  // the load effect below replaces it with the server's effective value
  // (the saved value, or the Mon-Fri 07:00-17:00 fallback) -- never a guess.
  const [businessHours, setBusinessHours] = useState<BusinessHoursForm>(EMPTY_HOURS);
  const [businessHoursSaved, setBusinessHoursSaved] = useState<BusinessHoursForm>(EMPTY_HOURS);
  const [hoursSaving, setHoursSaving] = useState(false);
  const [hoursMsg, setHoursMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

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
          setNotificationsEnabled(Boolean(s.notifications_enabled));
          setNotificationsSaved(Boolean(s.notifications_enabled));

          // s.business_hours is always the server's already-effective value
          // (saved, or the Mon-Fri 07:00-17:00 fallback) -- coerced
          // defensively here the same way every other loaded field above is.
          const nextHours = {} as BusinessHoursForm;
          for (const day of WEEKDAY_KEYS) {
            const dayRanges = s.business_hours?.[day];
            nextHours[day] = Array.isArray(dayRanges) ? dayRanges : [];
          }
          setBusinessHours(nextHours);
          setBusinessHoursSaved(nextHours);
        }
        if (data.status) setStatus(data.status);
      })
      .catch(() => { setMsg({ type: "error", text: "Failed to load company settings." }); setLoadFailed(true); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadCompanySettings(); }, []);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const automationDirty = bookingEnabled !== bookingSaved || notificationsEnabled !== notificationsSaved;
  const hoursDirty = JSON.stringify(businessHours) !== JSON.stringify(businessHoursSaved);

  // Toggling a day open seeds it with the canonical Mon-Fri fallback range
  // (07:00-17:00) so the UI never shows "Open" with zero ranges -- Closed is
  // represented purely as an empty array, never a separate boolean.
  function toggleDayOpen(day: WeekdayKey) {
    setBusinessHours((p) => ({
      ...p,
      [day]: p[day].length > 0 ? [] : [{ start: "07:00", end: "17:00" }],
    }));
  }
  function updateHoursRange(day: WeekdayKey, index: number, field: "start" | "end", value: string) {
    setBusinessHours((p) => ({
      ...p,
      [day]: p[day].map((r, i) => (i === index ? { ...r, [field]: value } : r)),
    }));
  }
  function addHoursRange(day: WeekdayKey) {
    setBusinessHours((p) => ({ ...p, [day]: [...p[day], { start: "09:00", end: "17:00" }] }));
  }
  function removeHoursRange(day: WeekdayKey, index: number) {
    setBusinessHours((p) => ({ ...p, [day]: p[day].filter((_, i) => i !== index) }));
  }

  async function handleSaveHours() {
    if (!canMutateOperationalData) return;
    setHoursSaving(true);
    setHoursMsg(null);
    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_hours: businessHours }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setHoursMsg({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      setBusinessHoursSaved(businessHours);
      setHoursMsg({ type: "success", text: "Saved." });
    } catch {
      setHoursMsg({ type: "error", text: "Network error. Please try again." });
    } finally {
      setHoursSaving(false);
    }
  }

  async function handleSave() {
    // Defense-in-depth: the server route this reaches already enforces this
    // same capability before mutating anything -- this guard only prevents
    // a restricted owner's client from ever issuing the request at all.
    if (!canMutateOperationalData) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      setSaved(form);
      setMsg({ type: "success", text: "Saved." });
    } catch {
      setMsg({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  // Automation settings save independently of the company profile above —
  // a feature's on/off switch shouldn't be entangled with unrelated profile
  // edits (or block on them being valid/saved first).
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationMsg, setAutomationMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function handleSaveAutomation() {
    if (!canMutateOperationalData) return;
    setAutomationSaving(true);
    setAutomationMsg(null);
    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_enabled: bookingEnabled, notifications_enabled: notificationsEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAutomationMsg({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      setBookingSaved(bookingEnabled);
      setNotificationsSaved(notificationsEnabled);
      setAutomationMsg({ type: "success", text: "Saved." });
    } catch {
      setAutomationMsg({ type: "error", text: "Network error. Please try again." });
    } finally {
      setAutomationSaving(false);
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
          <CapabilityGatedButton
            allowed={canMutateOperationalData}
            disabled={saving || !dirty}
            onClick={handleSave}
            ariaDescribedBy={COMPANY_NOTICE_ID}
            className={primaryBtnCls}
          >
            {saving ? "Saving..." : "Save Changes"}
          </CapabilityGatedButton>
        }
      >
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="shrink-0 flex flex-col items-center gap-2 w-28">
            <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-blue-500 to-blue-700 text-white flex items-center justify-center text-2xl font-bold shadow-sm">
              {initials(form.company_name || "Your Company")}
            </div>
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
          </div>
        </div>

        <div className="flex items-center justify-between pt-1">
          <DirtyHint dirty={dirty} />
        </div>

        {!canMutateOperationalData && (
          <div id={COMPANY_NOTICE_ID} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {RESTRICTED_WORDING}
          </div>
        )}

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

      <SettingsCard
        id="business-hours-card"
        title="Business Hours"
        helper="Set when your business is open. This controls what times customers can request online — it never blocks you from scheduling an appointment yourself."
        headerRight={
          <CapabilityGatedButton
            allowed={canMutateOperationalData}
            disabled={hoursSaving || !hoursDirty}
            onClick={handleSaveHours}
            ariaDescribedBy={HOURS_NOTICE_ID}
            className={primaryBtnCls}
          >
            {hoursSaving ? "Saving..." : "Save Changes"}
          </CapabilityGatedButton>
        }
      >
        <div className="divide-y divide-slate-100">
          {WEEKDAY_KEYS.map((day) => {
            const ranges = businessHours[day];
            const isOpen = ranges.length > 0;
            return (
              <div key={day} className="flex flex-col sm:flex-row sm:items-start gap-2 py-3">
                <div className="flex items-center gap-3 sm:w-36 shrink-0">
                  <span className="text-sm font-medium text-slate-800 capitalize">{day}</span>
                  <button
                    type="button"
                    onClick={() => toggleDayOpen(day)}
                    disabled={!canMutateOperationalData}
                    className={[
                      "text-[11px] font-medium px-2 py-0.5 rounded-full transition-colors disabled:opacity-50",
                      isOpen ? "text-emerald-700 bg-emerald-50" : "text-slate-500 bg-slate-100",
                    ].join(" ")}
                  >
                    {isOpen ? "Open" : "Closed"}
                  </button>
                </div>
                {isOpen && (
                  <div className="flex-1 flex flex-col gap-2">
                    {ranges.map((range, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <select
                          value={range.start}
                          onChange={(e) => updateHoursRange(day, index, "start", e.target.value)}
                          disabled={!canMutateOperationalData}
                          className={timeSelectCls}
                        >
                          {BUSINESS_HOURS_TIME_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <span className="text-slate-400 text-sm">&ndash;</span>
                        <select
                          value={range.end}
                          onChange={(e) => updateHoursRange(day, index, "end", e.target.value)}
                          disabled={!canMutateOperationalData}
                          className={timeSelectCls}
                        >
                          {BUSINESS_HOURS_TIME_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        {/* The primary (first) range closes via the Open/Closed
                            control above, never via Remove -- Remove only
                            applies to additional ranges created through
                            + Add hours, so it never appears for index 0. */}
                        {index > 0 && (
                          <button
                            type="button"
                            onClick={() => removeHoursRange(day, index)}
                            disabled={!canMutateOperationalData}
                            className="text-xs font-medium text-slate-400 hover:text-rose-600 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addHoursRange(day)}
                      disabled={!canMutateOperationalData}
                      className="self-start text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                    >
                      + Add hours
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-1">
          <DirtyHint dirty={hoursDirty} />
        </div>

        {!canMutateOperationalData && (
          <div id={HOURS_NOTICE_ID} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {RESTRICTED_WORDING}
          </div>
        )}

        {hoursMsg && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs",
              hoursMsg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            {hoursMsg.text}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        id="automation-card"
        title="Automation"
        helper="Control what happens automatically for your business."
        headerRight={
          <CapabilityGatedButton
            allowed={canMutateOperationalData}
            disabled={automationSaving || !automationDirty}
            onClick={handleSaveAutomation}
            ariaDescribedBy={AUTOMATION_NOTICE_ID}
            className={primaryBtnCls}
          >
            {automationSaving ? "Saving..." : "Save Changes"}
          </CapabilityGatedButton>
        }
      >
        <SettingsToggle
          checked={bookingEnabled}
          onChange={setBookingEnabled}
          label="Enable Public Booking"
          helper={
            bookingEnabled
              ? "Your /book page is live — customers can request appointments online."
              : "Off by default. Customers see a friendly message and must contact you directly."
          }
        />
        <div className="border-t border-slate-100 pt-3">
          <SettingsToggle
            checked={notificationsEnabled}
            onChange={setNotificationsEnabled}
            label="Enable Client Notifications"
            helper={
              notificationsEnabled
                ? "Confirmations, updates, cancellations, and reminders send normally, per each client's own email/SMS preferences."
                : "Master switch is off — no email or SMS goes out for any appointment, even for clients with email/SMS preferences enabled."
            }
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <DirtyHint dirty={automationDirty} />
        </div>

        {!canMutateOperationalData && (
          <div id={AUTOMATION_NOTICE_ID} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {RESTRICTED_WORDING}
          </div>
        )}

        {automationMsg && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs",
              automationMsg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            {automationMsg.text}
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
          {isTrialing && !confirmingCancel && (
            <button
              type="button"
              onClick={() => {
                setCancelResult(null);
                setConfirmingCancel(true);
              }}
              className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 transition-colors"
            >
              Cancel Free Trial
            </button>
          )}
        </div>
        {isTrialing && confirmingCancel && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4">
            <div className="text-sm font-semibold text-rose-900">Cancel your free trial?</div>
            <div className="mt-1 text-xs text-rose-800">
              Canceling now ends access immediately — you will not keep access for the remainder of the trial, and there is no
              read-only period afterward.
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleCancelTrial}
                disabled={cancelling}
                aria-busy={cancelling}
                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50 transition-colors"
              >
                {cancelling ? "Cancelling..." : "Confirm Cancellation"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingCancel(false)}
                disabled={cancelling}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                Never mind
              </button>
            </div>
          </div>
        )}
        {cancelResult && (
          <div
            role={cancelResult.type === "error" ? "alert" : "status"}
            className={`mt-3 text-xs ${cancelResult.type === "error" ? "text-rose-700" : "text-emerald-700"}`}
          >
            {cancelResult.text}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
