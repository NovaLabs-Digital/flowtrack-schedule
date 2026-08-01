"use client";

import { useEffect, useRef, useState } from "react";
import SettingsCard, { DirtyHint, PreviewPill } from "@/app/components/dashboard/SettingsCard";
import SettingsToggle from "@/app/components/dashboard/SettingsToggle";
import CompanyStatusStrip from "@/app/components/dashboard/CompanyStatusStrip";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";

// Phase 5.5E-E1F: two separate logical mutation-control areas in this
// panel -- Company Information and Automation are independent cards with
// independent Save actions and independent dirty-state, matching this
// codebase's own card-splitting principle (one card answers one question) --
// so each gets its own notice rather than sharing one across the whole
// panel. Distinct from every other component's notice id established in
// earlier phases.
const COMPANY_NOTICE_ID = "company-info-restricted-notice";
const AUTOMATION_NOTICE_ID = "company-automation-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

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
          setNotificationsEnabled(Boolean(s.notifications_enabled));
          setNotificationsSaved(Boolean(s.notifications_enabled));
        }
        if (data.status) setStatus(data.status);
      })
      .catch(() => { setMsg({ type: "error", text: "Failed to load company settings." }); setLoadFailed(true); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadCompanySettings(); }, []);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const automationDirty = bookingEnabled !== bookingSaved || notificationsEnabled !== notificationsSaved;

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
