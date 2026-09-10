"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatHoursAsDuration } from "@/lib/payroll";
import type { EmployeeEntitlementView } from "@/lib/entitlementView";
import EmployeeJobActionButton from "@/app/components/schedule/EmployeeJobActionButton";
import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";

type Appointment = {
  id: string;
  client_id: string;
  service_type: string;
  scheduled_for: string;
  scheduled_end?: string | null;
  status: string;
  notes: string | null;
  duration_minutes?: number | null;
  actual_started_at?: string | null;
  actual_completed_at?: string | null;
  // Employee Job Notes: this employee's own optional note for this job,
  // seeded from appointment_employees.job_notes (see app/schedule/page.tsx)
  // -- distinct from `notes` above (the owner-authored appointment note,
  // read-only, shown separately).
  job_notes?: string | null;
};

type ClientInfo = { name: string; address: string | null };

type Props = {
  employee: { id: string; name: string; color: string; position?: string | null };
  appointments: Appointment[];
  clients: Record<string, ClientInfo>;
  serviceColors: Record<string, string>;
  officePhone: string | null;
  thisWeekHours: number;
  lastWeekHours: number;
  // Phase 5.5B plumbed this through from app/schedule/page.tsx without
  // reading it. Phase 5.5E-D reads canUseJobTracking to disable Start/
  // Complete (via EmployeeJobActionButton) with a neutral operational
  // explanation -- the server-side canUseJobTracking capability gate in
  // app/api/appointments/job/route.ts remains the authoritative
  // enforcement; this is UX only.
  entitlement: EmployeeEntitlementView;
  // The workspace's own resolved timezone, resolved server-side
  // (app/schedule/page.tsx) -- every appointment date/time this screen
  // shows must agree with what the owner's dashboard shows for the same
  // appointment, never the employee's own device timezone. Worked-hours
  // totals (thisWeekHours/lastWeekHours) are also computed server-side
  // using this same resolved timezone (see app/schedule/page.tsx's
  // mondayOfWeek/computePayrollRows calls).
  timezone: string;
};

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDayHeader(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function formatTime(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function durationLabel(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function mapsUrl(address: string) {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// Employee Job Notes: autosaves this many ms after the employee stops
// typing -- "approximately 1 second" per the approved behavior.
const NOTE_AUTOSAVE_DEBOUNCE_MS = 1000;

type NoteStatus = "idle" | "saving" | "saved" | "error";

export default function EmployeeSchedule({ employee, appointments, clients, serviceColors, officePhone, thisWeekHours, lastWeekHours, entitlement, timezone }: Props) {
  const router = useRouter();
  const [dayOffset, setDayOffset] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loadingJob, setLoadingJob] = useState<string | null>(null);
  const [jobTimes, setJobTimes] = useState<Record<string, { started?: string; completed?: string }>>(() => {
    const map: Record<string, { started?: string; completed?: string }> = {};
    for (const a of appointments) {
      if (a.actual_started_at || a.actual_completed_at) {
        map[a.id] = { started: a.actual_started_at ?? undefined, completed: a.actual_completed_at ?? undefined };
      }
    }
    return map;
  });

  // Employee Job Notes: `jobNotes` is the textarea's live value (what the
  // employee is currently typing/has typed); `savedJobNotes` holds a key
  // for appointment `a.id` ONLY once a save has actually succeeded for it
  // (its value is whatever was last confirmed persisted, including an
  // intentionally-cleared ""). Both are seeded from the same appointments
  // prop so a reload/reopen shows the previously saved note (product
  // requirement).
  const [jobNotes, setJobNotes] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const a of appointments) {
      if (a.job_notes) map[a.id] = a.job_notes;
    }
    return map;
  });
  const [savedJobNotes, setSavedJobNotes] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const a of appointments) {
      if (a.job_notes) map[a.id] = a.job_notes;
    }
    return map;
  });
  const [noteStatus, setNoteStatus] = useState<Record<string, NoteStatus>>({});

  // Autosave plumbing. jobNotesRef mirrors jobNotes synchronously (updated
  // in the same tick as the keystroke, not on React's next render) so the
  // async save loop below always reads the truly-latest typed value, never
  // a stale snapshot captured when a request started. debounceTimers holds
  // the pending "stopped typing" timer per appointment; saveLoopActive/
  // saveLoopPromise track whether a save is currently in flight for an
  // appointment (and its promise, so Complete Job can await it) -- see
  // saveLoop/ensureSaveLoop below for how these together guarantee at most
  // one in-flight save per appointment, with the newest typed value always
  // winning.
  const jobNotesRef = useRef<Record<string, string>>({ ...jobNotes });
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveLoopActive = useRef<Record<string, boolean>>({});
  const saveLoopPromise = useRef<Record<string, Promise<{ ok: boolean }>>>({});

  // Any pending "stopped typing" timer must not fire after this component
  // unmounts (navigation away, sign out) -- there would be nothing left to
  // update, and the request would be pointless at best.
  useEffect(() => {
    return () => {
      for (const timer of Object.values(debounceTimers.current)) clearTimeout(timer);
      debounceTimers.current = {};
    };
  }, []);

  // Phase 5C: business-tz-anchored (never bare `new Date()`/native getters
  // on a raw `new Date(iso)`) -- this screen previously computed "today"
  // and each appointment's day in the EMPLOYEE's own device timezone,
  // which could disagree with the owner's dashboard the moment the two
  // devices weren't in the same zone.
  const today = nowInBusinessTz(timezone);
  today.setHours(0, 0, 0, 0);
  const currentDay = addDays(today, dayOffset);

  const dayAppts = appointments.filter((a) => {
    const d = toBusinessLocal(a.scheduled_for, timezone);
    return sameDay(d, currentDay);
  });

  async function handleLogout() {
    setLoggingOut(true);
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    router.push("/login");
  }

  // Synchronous, render-independent lock — belt-and-suspenders against a
  // double-click firing two requests before React re-renders the button's
  // `disabled` state (which itself already prevents most double-submits,
  // but relies on a state update landing first).
  const inFlightRef = useRef<Set<string>>(new Set());

  async function handleJobAction(appointmentId: string, action: "start" | "complete") {
    if (inFlightRef.current.has(appointmentId)) return;

    if (action === "complete") {
      const startedAtIso = jobTimes[appointmentId]?.started;
      if (startedAtIso) {
        const elapsedMs = Date.now() - new Date(startedAtIso).getTime();
        // A clock-out this soon after clock-in is almost always an
        // accidental tap, not a real sub-minute job — confirm before
        // recording it. Never blocks a deliberate confirmation: the
        // owner-side invalid-duration workflow (see lib/payroll.ts's
        // isJobTrackingComplete) is the safety net if the employee
        // proceeds anyway. Never fabricates or adjusts either timestamp.
        if (elapsedMs < 60_000) {
          const confirmed = window.confirm("You clocked in less than one minute ago. Are you sure you want to clock out?");
          if (!confirmed) return;
        }
      }

      // Employee Job Notes: flush any pending/in-flight autosave before
      // completing, so a note typed just before tapping Complete is never
      // silently discarded because it was still inside the debounce
      // window. Cancels the pending debounce timer (it would otherwise
      // fire redundantly after this) and, if the live value hasn't been
      // confirmed persisted yet (or a save is already in flight), waits
      // for a real save attempt to finish before proceeding.
      if (debounceTimers.current[appointmentId]) {
        clearTimeout(debounceTimers.current[appointmentId]);
        delete debounceTimers.current[appointmentId];
      }
      const liveNote = jobNotesRef.current[appointmentId] ?? "";
      const lastSavedNote = savedJobNotes[appointmentId] ?? "";
      if (saveLoopActive.current[appointmentId] || liveNote !== lastSavedNote) {
        const result = await ensureSaveLoop(appointmentId);
        if (!result.ok) {
          // Do not proceed with Complete -- the note failed to save. The
          // typed text and the "Not saved — try again" status (already
          // set inside saveLoop) are both preserved; Complete never runs.
          return;
        }
      }
    }

    inFlightRef.current.add(appointmentId);
    setLoadingJob(appointmentId);
    try {
      const res = await fetch("/api/appointments/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: appointmentId, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;

      setJobTimes((prev) => ({
        ...prev,
        [appointmentId]: {
          started: data.actual_started_at ?? prev[appointmentId]?.started,
          completed: data.actual_completed_at ?? prev[appointmentId]?.completed,
        },
      }));
    } catch {}
    finally {
      inFlightRef.current.delete(appointmentId);
      setLoadingJob(null);
    }
  }

  // Employee Job Notes: autosaves ~1s after the employee stops typing --
  // no request on every keystroke (handleNotesChange below debounces).
  // Reuses the same POST /api/appointments/job, action: "save_notes" the
  // old explicit Save Note button used; the server's own trim/2000-char/
  // started-not-completed/session-scoped rules are unchanged.
  //
  // Race-condition protection: rather than tracking response version
  // numbers, this SERIALIZES saves -- at most one request is ever in
  // flight per appointment (see ensureSaveLoop). If the employee edits
  // again while a save is still in flight, no second overlapping request
  // is sent; instead, the moment the in-flight request settles, this loop
  // re-checks jobNotesRef (the true latest value) and immediately sends
  // another request if it has since changed, repeating until the sent
  // value and the live value finally match. This guarantees the database
  // is never left holding an older value than what the employee actually
  // typed, and that a slow older response can never stomp a newer one.
  async function saveLoop(appointmentId: string): Promise<{ ok: boolean }> {
    for (;;) {
      const valueToSend = jobNotesRef.current[appointmentId] ?? "";
      setNoteStatus((prev) => ({ ...prev, [appointmentId]: "saving" }));

      let ok = false;
      let savedValue = valueToSend;
      try {
        const res = await fetch("/api/appointments/job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appointment_id: appointmentId, action: "save_notes", notes: valueToSend }),
        });
        const data = await res.json().catch(() => ({}));
        ok = res.ok;
        if (ok) savedValue = data.job_notes ?? "";
      } catch {
        ok = false;
      }

      if (!ok) {
        setNoteStatus((prev) => ({ ...prev, [appointmentId]: "error" }));
        return { ok: false };
      }

      setSavedJobNotes((prev) => ({ ...prev, [appointmentId]: savedValue }));
      // The employee may have kept typing while this request was in
      // flight -- if the live value has since moved on from what was just
      // sent, loop again immediately with the newest value rather than
      // reporting "Saved" for text that's already stale.
      if ((jobNotesRef.current[appointmentId] ?? "") !== valueToSend) {
        continue;
      }
      setNoteStatus((prev) => ({ ...prev, [appointmentId]: "saved" }));
      return { ok: true };
    }
  }

  // Idempotent: if a save is already in flight for this appointment,
  // returns the SAME promise instead of starting a second overlapping
  // request -- saveLoop's own internal re-check (above) already
  // guarantees that in-flight request will pick up any newer edit before
  // it resolves. This is what lets both the debounce timer and the
  // Complete-Job flush share one code path safely.
  function ensureSaveLoop(appointmentId: string): Promise<{ ok: boolean }> {
    if (saveLoopActive.current[appointmentId]) {
      return saveLoopPromise.current[appointmentId];
    }
    saveLoopActive.current[appointmentId] = true;
    const promise = saveLoop(appointmentId).finally(() => {
      saveLoopActive.current[appointmentId] = false;
    });
    saveLoopPromise.current[appointmentId] = promise;
    return promise;
  }

  function handleNotesChange(appointmentId: string, value: string) {
    jobNotesRef.current[appointmentId] = value;
    setJobNotes((prev) => ({ ...prev, [appointmentId]: value }));
    // A fresh edit makes any prior "Saved"/"Not saved" status stale --
    // clear it now rather than let it linger until the next save settles.
    setNoteStatus((prev) => (prev[appointmentId] && prev[appointmentId] !== "idle" ? { ...prev, [appointmentId]: "idle" } : prev));

    if (debounceTimers.current[appointmentId]) {
      clearTimeout(debounceTimers.current[appointmentId]);
    }
    debounceTimers.current[appointmentId] = setTimeout(() => {
      delete debounceTimers.current[appointmentId];
      ensureSaveLoop(appointmentId);
    }, NOTE_AUTOSAVE_DEBOUNCE_MS);
  }

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col safe-area-top">
      {/* Top bar */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: employee.color }}>
              {employee.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-900 truncate">{employee.name}</div>
              {employee.position && (
                <div className="text-xs font-normal text-slate-400 truncate">{employee.position}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setDayOffset((d) => d - 1)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              ←
            </button>
            <button
              onClick={() => setDayOffset(0)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              Today
            </button>
            <button
              onClick={() => setDayOffset((d) => d + 1)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              →
            </button>
          </div>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="text-xs text-slate-500 hover:text-rose-600 transition-colors shrink-0"
          >
            {loggingOut ? "..." : "Sign Out"}
          </button>
        </div>
      </div>

      {/* Welcome + day header */}
      <div className="px-4 py-3 bg-slate-100 border-b border-slate-200">
        {sameDay(currentDay, today) && (
          <div className="text-sm text-slate-700 mb-0.5">
            {greeting()}, <span className="font-semibold">{employee.name.split(" ")[0]}</span>.
          </div>
        )}
        <div className="text-sm font-semibold text-slate-900">{formatDayHeader(currentDay)}</div>
        <div className="text-xs text-slate-500 mt-0.5">
          {dayAppts.length === 0
            ? (sameDay(currentDay, today) ? "No appointments today" : "No appointments")
            : `${dayAppts.length} appointment${dayAppts.length !== 1 ? "s" : ""}${sameDay(currentDay, today) ? " today" : ""}`}
        </div>
      </div>

      {/* My Worked Hours — read-only, this employee's own hours only */}
      <div className="px-4 py-3 bg-white border-b border-slate-200">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">My Worked Hours</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-center">
            <div className="text-sm font-semibold text-slate-900">{formatHoursAsDuration(thisWeekHours)}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">This Week</div>
          </div>
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-center">
            <div className="text-sm font-semibold text-slate-900">{formatHoursAsDuration(lastWeekHours)}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Last Week</div>
          </div>
        </div>
      </div>

      {/* Appointment list */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-3">
        {dayAppts.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-3xl text-slate-200 mb-3">📅</div>
            <div className="text-sm text-slate-500">No appointments {sameDay(currentDay, today) ? "today" : "on this day"}</div>
            <div className="text-xs text-slate-400 mt-1">Use the arrows to check other days</div>
          </div>
        ) : (
          dayAppts.map((a) => {
            // rawStart is the real instant (used only for the duration
            // delta); start/end (display) are the workspace-local values
            // derived from it -- mixing the two would shift either.
            const rawStart = new Date(a.scheduled_for);
            let mins: number;
            if (a.scheduled_end) {
              mins = Math.round((new Date(a.scheduled_end).getTime() - rawStart.getTime()) / 60_000);
              if (mins <= 0) mins = a.duration_minutes ?? 60;
            } else {
              mins = a.duration_minutes ?? 60;
            }
            const start = toBusinessLocal(a.scheduled_for, timezone);
            const end = new Date(start.getTime() + mins * 60_000);
            const client = clients[a.client_id];
            const svcColor = serviceColors[a.service_type] ?? null;

            // rawStartedAt/rawCompletedAt are the real instants (used only
            // for the duration delta); startedAt/completedAt (display) are
            // the workspace-local values derived from them -- mixing the
            // two would shift either, exactly like rawStart/start above.
            const times = jobTimes[a.id];
            const rawStartedAt = times?.started ? new Date(times.started) : null;
            const rawCompletedAt = times?.completed ? new Date(times.completed) : null;
            const startedAt = times?.started ? toBusinessLocal(times.started, timezone) : null;
            const completedAt = times?.completed ? toBusinessLocal(times.completed, timezone) : null;
            const isStarted = !!startedAt;
            const isCompleted = !!completedAt;

            let actualDuration: string | null = null;
            if (rawStartedAt && rawCompletedAt) {
              const actualMins = Math.round((rawCompletedAt.getTime() - rawStartedAt.getTime()) / 60_000);
              if (actualMins >= 0) actualDuration = durationLabel(actualMins);
            }

            return (
              <div
                key={a.id}
                className={[
                  "rounded-xl border bg-white shadow-sm overflow-hidden",
                  isCompleted ? "border-emerald-200" : "border-slate-200",
                ].join(" ")}
              >
                <div className="h-1" style={{ backgroundColor: svcColor ?? employee.color }} />

                <div className="p-4 space-y-2">
                  {/* Service + time */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {svcColor && <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svcColor }} />}
                      <span className="font-semibold text-sm text-slate-900">{a.service_type}</span>
                    </div>
                    {isCompleted && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-emerald-50 text-emerald-600 shrink-0">Done</span>
                    )}
                  </div>

                  {/* Scheduled time */}
                  <div className="text-sm text-slate-700">
                    Scheduled: {formatTime(start)} – {formatTime(end)} ({durationLabel(mins)})
                  </div>

                  {/* Actual times */}
                  {isStarted && (
                    <div className="text-xs space-y-0.5">
                      <div className="text-slate-600">
                        Started: <span className="font-medium text-slate-800">{formatTime(startedAt)}</span>
                      </div>
                      {isCompleted && (
                        <>
                          <div className="text-slate-600">
                            Completed: <span className="font-medium text-slate-800">{formatTime(completedAt)}</span>
                          </div>
                          {actualDuration && (
                            <div className="text-slate-600">
                              Actual duration: <span className="font-medium text-slate-800">{actualDuration}</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Client info */}
                  {client && (
                    <div className="space-y-1 pt-1 border-t border-slate-100">
                      <div className="text-sm font-medium text-slate-800">{client.name}</div>
                      {client.address && (
                        <div className="text-xs text-slate-500">{client.address}</div>
                      )}
                    </div>
                  )}

                  {/* Notes */}
                  {a.notes && (
                    <div className="text-xs text-slate-500 italic pt-1 border-t border-slate-100">
                      {a.notes}
                    </div>
                  )}

                  {/* Job Notes -- employee's own optional note for this
                      job. Visible ONLY between Start and Complete (per
                      product decision, the workflow is START -> JOB NOTES
                      -> COMPLETE): before Start there is nothing to write
                      about yet, and after Complete it becomes read-only
                      from the employee workflow (no edit UI in V1 -- the
                      owner can still see it via AppointmentModal). */}
                  {isStarted && !isCompleted && (
                    <div className="pt-2 border-t border-slate-100 space-y-1.5">
                      <label htmlFor={`job-notes-${a.id}`} className="block text-xs font-medium text-slate-600">
                        Job Notes (optional)
                      </label>
                      <textarea
                        id={`job-notes-${a.id}`}
                        value={jobNotes[a.id] ?? ""}
                        onChange={(e) => handleNotesChange(a.id, e.target.value)}
                        maxLength={2000}
                        rows={3}
                        placeholder="e.g. client not home, gate locked, extra work requested..."
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      {noteStatus[a.id] === "saving" && (
                        <div className="text-xs text-slate-500">Saving...</div>
                      )}
                      {noteStatus[a.id] === "saved" && (
                        <div className="text-xs text-emerald-600">Saved</div>
                      )}
                      {noteStatus[a.id] === "error" && (
                        <div className="text-xs text-rose-600">Not saved — try again</div>
                      )}
                    </div>
                  )}

                  {/* Job action button */}
                  {!isCompleted && (
                    <div className="pt-2">
                      <EmployeeJobActionButton
                        action={!isStarted ? "start" : "complete"}
                        loading={loadingJob === a.id}
                        canUseJobTracking={entitlement.canUseJobTracking}
                        onActivate={() => handleJobAction(a.id, !isStarted ? "start" : "complete")}
                      />
                    </div>
                  )}

                  {/* Navigate + Call Office buttons */}
                  <div className="flex gap-2">
                    {client?.address && (
                      <a
                        href={mapsUrl(client.address)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white active:bg-slate-700 transition-colors"
                      >
                        <span className="text-base leading-none">📍</span>
                        Navigate
                      </a>
                    )}
                    {officePhone && (
                      <a
                        href={`tel:${officePhone}`}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 active:bg-slate-100 transition-colors"
                      >
                        <span className="text-base leading-none">📞</span>
                        Call Office
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 safe-area-bottom">
        {dayAppts.length} appointment{dayAppts.length !== 1 ? "s" : ""} {sameDay(currentDay, today) ? "today" : ""}
      </div>
    </div>
  );
}
