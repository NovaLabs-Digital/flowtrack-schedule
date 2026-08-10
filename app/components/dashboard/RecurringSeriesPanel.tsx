"use client";

import { useEffect, useState } from "react";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";

// Phase 5.5E-E1x-style restricted notice, distinct from every other panel's
// own id -- see CompanyInfoPanel/ArchivedClientsPanel for the established
// pattern this mirrors.
const RESTRICTED_NOTICE_ID = "recurring-series-panel-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

type Candidate = {
  id: string;
  scheduledFor: string;
  serviceType: string;
  priceCents: number | null;
  durationMinutes: number | null;
};

type SeriesRow = {
  id: string;
  frequencyType: "daily" | "weekdays" | "weekly" | "monthly";
  repeatWeeks: number | null;
  repeatMonths: number | null;
  anchorLocalDate: string;
  anchorLocalTime: string;
  anchorTimezone: string;
  isDemo: boolean;
  createdAt: string;
  clientId: string;
  clientName: string | null;
  clientInactiveOrArchived: boolean;
  candidates: Candidate[];
  hasLiveOccurrences: boolean;
  expiresWithin30Days: boolean;
};

const BLOCKER_LABELS: Record<string, string> = {
  no_live_occurrences: "This series has no upcoming scheduled appointments to build from.",
  template_not_in_series: "The chosen appointment isn't a current occurrence of this series.",
  service_type_mismatch: "Its upcoming appointments don't all use the same service.",
  price_mismatch: "Its upcoming appointments don't all have the same price.",
  duration_mismatch: "Its upcoming appointments don't all have the same duration.",
  team_color_mismatch: "Its upcoming appointments don't all share the same team color.",
  employee_set_mismatch: "Its upcoming appointments aren't all assigned to the same employee(s).",
  time_pattern_unexplained: "Its upcoming appointments don't all fall at the same time of day, and it isn't the known legacy daylight-saving pattern.",
  weekend_occurrence_in_weekdays_series: "At least one upcoming appointment falls on a weekend for a weekdays series.",
  weekly_weekday_pattern_inconsistent: "Its upcoming appointments don't all fall on the same day of the week.",
  monthly_progression_invalid: "Its upcoming appointments don't follow a valid monthly pattern.",
};

function frequencyLabel(s: SeriesRow): string {
  if (s.frequencyType === "daily") return "Daily";
  if (s.frequencyType === "weekdays") return "Weekdays";
  if (s.frequencyType === "weekly") return s.repeatWeeks === 1 ? "Weekly" : `Every ${s.repeatWeeks} weeks`;
  return s.repeatMonths === 1 ? "Monthly" : `Every ${s.repeatMonths} months`;
}

function fmtAnchorTime(t: string): string {
  const [hStr, m] = t.split(":");
  const h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

function fmtCandidateLabel(c: Candidate): string {
  const d = new Date(c.scheduledFor);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${date} — ${c.serviceType}`;
}

// Owner review/activation queue for legacy recurring series (Block 2B).
// Read-only listing plus one explicit, owner-confirmed activation action --
// no automatic write replenishment exists yet, and no appointment is ever
// created, cancelled, rescheduled, or rewritten from this panel. A series
// with no live occurrences, an inactive/archived client, or a demo flag
// cannot be activated here regardless of what the owner selects -- the
// Activate control is disabled for those rows rather than merely warned
// about after the fact.
export default function RecurringSeriesPanel({ canMutateOperationalData }: { canMutateOperationalData: boolean }) {
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Record<string, string>>({});
  const [activating, setActivating] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<string, { type: "success" | "error"; text: string }>>({});

  function load() {
    setLoadFailed(false);
    fetch("/api/recurring-series")
      .then((r) => r.json())
      .then((data) => {
        if (data.series) {
          setSeries(data.series);
          const defaults: Record<string, string> = {};
          for (const s of data.series as SeriesRow[]) {
            if (s.candidates.length > 0) defaults[s.id] = s.candidates[s.candidates.length - 1].id;
          }
          setSelectedTemplate(defaults);
        } else if (data.error) {
          setLoadFailed(true);
        }
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function activate(s: SeriesRow) {
    if (!canMutateOperationalData) return;
    const templateAppointmentId = selectedTemplate[s.id];
    if (!templateAppointmentId) return;
    setActivating(s.id);
    setRowMessage((m) => ({ ...m, [s.id]: undefined as any }));
    try {
      const res = await fetch("/api/recurring-series/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ series_id: s.id, template_appointment_id: templateAppointmentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const blockerText = Array.isArray(data.blockers)
          ? data.blockers.map((b: string) => BLOCKER_LABELS[b] || b).join(" ")
          : "";
        setRowMessage((m) => ({ ...m, [s.id]: { type: "error", text: blockerText || data?.error || "Activation failed." } }));
        return;
      }
      setRowMessage((m) => ({ ...m, [s.id]: { type: "success", text: "Activated." } }));
      setSeries((prev) => prev.filter((row) => row.id !== s.id));
    } catch {
      setRowMessage((m) => ({ ...m, [s.id]: { type: "error", text: "Network error." } }));
    } finally {
      setActivating(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading recurring series...</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">Recurring Series Review</div>
      <div className="mt-1 text-xs text-slate-500">
        Series created before automatic recurring-series support need one-time review before they can be extended automatically.
        Reviewing here doesn't change any existing appointment.
      </div>

      {loadFailed && (
        <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 flex items-center justify-between gap-3">
          <span>Failed to load recurring series.</span>
          <button type="button" onClick={() => { setLoading(true); load(); }} className="shrink-0 font-medium underline hover:no-underline">
            Retry
          </button>
        </div>
      )}

      {!canMutateOperationalData && (
        <div id={RESTRICTED_NOTICE_ID} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {RESTRICTED_WORDING}
        </div>
      )}

      {series.length === 0 && !loadFailed ? (
        <div className="mt-6 text-center py-8">
          <div className="text-3xl text-slate-200 mb-2">&#128260;</div>
          <div className="text-sm text-slate-400">Nothing needs review</div>
          <div className="text-xs text-slate-400 mt-0.5">Every recurring series is either active or already reviewed.</div>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {series.map((s) => {
            const canActivate =
              canMutateOperationalData && s.hasLiveOccurrences && !s.clientInactiveOrArchived && !s.isDemo;
            const msg = rowMessage[s.id];
            return (
              <div key={s.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-medium text-slate-900">
                      {s.clientName ?? "Unknown client"}
                      {s.isDemo && (
                        <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Demo</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {frequencyLabel(s)} · {fmtAnchorTime(s.anchorLocalTime)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {s.expiresWithin30Days && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Expiring soon</span>
                    )}
                    {!s.hasLiveOccurrences && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">No upcoming appointments</span>
                    )}
                    {s.clientInactiveOrArchived && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Client inactive</span>
                    )}
                  </div>
                </div>

                {s.candidates.length > 0 && (
                  <div className="mt-3">
                    <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                      Choose the appointment that represents this series going forward
                    </label>
                    <select
                      value={selectedTemplate[s.id] ?? ""}
                      onChange={(e) => setSelectedTemplate((m) => ({ ...m, [s.id]: e.target.value }))}
                      disabled={!canActivate}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                    >
                      {s.candidates.map((c) => (
                        <option key={c.id} value={c.id}>{fmtCandidateLabel(c)}</option>
                      ))}
                    </select>
                  </div>
                )}

                {msg && (
                  <div
                    className={[
                      "mt-3 rounded-lg border px-3 py-2 text-xs",
                      msg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
                    ].join(" ")}
                  >
                    {msg.text}
                  </div>
                )}

                <div className="mt-3">
                  <CapabilityGatedButton
                    allowed={canActivate}
                    disabled={activating === s.id}
                    onClick={() => activate(s)}
                    ariaDescribedBy={RESTRICTED_NOTICE_ID}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {activating === s.id ? "Activating..." : "Confirm & Activate"}
                  </CapabilityGatedButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
