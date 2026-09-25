"use client";

import { useEffect, useRef, useState } from "react";
import { Appointment, Client, Service, Employee, EmployeeHours, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { countFutureOccurrences } from "@/lib/recurrence";
import { findManualHoursEntry, formatMinutesAsDuration, hasInvalidJobTrackingDuration, isJobTrackingComplete, getMissingHoursEmployeeIds, resolveWorkedMinutes, needsWorkedTimeReview, trackedMinutes } from "@/lib/payroll";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";
import AdjustWorkedTimeControl from "@/app/components/dashboard/AdjustWorkedTimeControl";
import { centsToInputValue, parsePriceToCents } from "@/lib/money";
import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";
import { buildTeamColorChoices, resolveTeamAccentColor } from "@/lib/teamColor";
import { zonedDateValue, zonedTimeValue, zonedDateTimeToUTC, toBusinessLocal } from "@/lib/timezone";

// Phase 5.5E-E1A: shown once per modal instance, referenced via
// aria-describedby by every capability-gated mutation button below, rather
// than repeating the explanation next to each one -- avoids duplicating a
// billing-adjacent notice throughout a single modal. Deliberately generic
// operational wording (never billing/subscription/Stripe/entitlement
// language) -- the existing owner account-status banner rendered above
// this modal by its parent (unchanged by this phase) is the one place
// that context is actually explained.
const RESTRICTED_NOTICE_ID = "appointment-modal-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

const FALLBACK_SERVICES = [
  "Regular Cleaning",
  "Deep Cleaning",
  "Move-Out Cleaning",
  "Office Cleaning",
  "Estimate",
];

function buildTimeSlots() {
  const slots: { value: string; label: string }[] = [];
  for (let h = 6; h <= 20; h++) {
    for (let m = 0; m < 60; m += 15) {
      const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      const mStr = m === 0 ? "00" : String(m);
      slots.push({ value: val, label: `${h12}:${mStr} ${ampm}` });
    }
  }
  return slots;
}
const TIME_SLOTS = buildTimeSlots();

function snapTo15(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const snapped = Math.round(m / 15) * 15;
  if (snapped >= 60) return `${String(h + 1).padStart(2, "0")}:00`;
  return `${String(h).padStart(2, "0")}:${String(snapped).padStart(2, "0")}`;
}

function addMinsToHHMM(hhmm: string, mins: number) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function diffMins(a: string, b: string) {
  const [sh, sm] = a.split(":").map(Number);
  const [eh, em] = b.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function durationLabel(mins: number) {
  if (mins <= 0) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function frequencyLabel(ft?: string | null, rw?: number | null, rm?: number | null): string {
  if (!ft || ft === "one_time") return "One Time";
  if (ft === "daily") return "Daily";
  if (ft === "weekdays") return "Weekdays (Mon–Fri)";
  if (ft === "weekly") {
    if (!rw || rw === 1) return "Weekly";
    if (rw === 2) return "Every 2 Weeks";
    return `Every ${rw} Weeks`;
  }
  if (ft === "monthly") {
    if (!rm || rm === 1) return "Monthly";
    return `Every ${rm} Months`;
  }
  return ft;
}

const WEEK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const MONTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export type NotifyChannel = "email" | "sms" | "both" | "none";

export function NotifyChoice({
  value, onChange, hasEmail, hasPhone, label,
}: {
  value: NotifyChannel;
  onChange: (v: NotifyChannel) => void;
  hasEmail: boolean;
  hasPhone: boolean;
  label: string;
}) {
  const options: { value: NotifyChannel; label: string; disabled: boolean }[] = [
    { value: "both", label: "Both", disabled: !hasEmail || !hasPhone },
    { value: "email", label: "Email", disabled: !hasEmail },
    { value: "sms", label: "SMS", disabled: !hasPhone },
    { value: "none", label: "No notification", disabled: false },
  ];
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-2">{label}</label>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {options.map((o) => (
          <label key={o.value} className={`flex items-center gap-1.5 text-sm ${o.disabled ? "text-slate-300 cursor-not-allowed" : "cursor-pointer"}`}>
            <input
              type="radio"
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
              className="accent-slate-900"
            />
            {o.label}
          </label>
        ))}
      </div>
      {!hasEmail && !hasPhone && (
        <div className="text-[11px] text-amber-600 mt-1">No email or phone on file — notification can&apos;t be sent.</div>
      )}
    </div>
  );
}

// Picks a sensible default channel for a "smart" preselect: the client's own
// preferred method if it's actually reachable, otherwise both if both are
// available, otherwise whichever single channel exists, otherwise none.
export function preferredNotifyChannel(
  preferredContactMethod: string | null | undefined,
  hasEmail: boolean,
  hasPhone: boolean
): NotifyChannel {
  if (preferredContactMethod === "email" && hasEmail) return "email";
  if (preferredContactMethod === "sms" && hasPhone) return "sms";
  if (hasEmail && hasPhone) return "both";
  if (hasEmail) return "email";
  if (hasPhone) return "sms";
  return "none";
}

// Wraps NotifyChoice with a visible outcome summary, so staff always sees
// plainly whether — and how — the client will be notified before saving.
export function NotifyChoicePanel(props: Parameters<typeof NotifyChoice>[0]) {
  const { value } = props;
  const willNotify = value !== "none";
  return (
    <div className={[
      "rounded-xl border p-3",
      willNotify ? "border-blue-200 bg-blue-50/50" : "border-slate-200 bg-slate-50",
    ].join(" ")}>
      <NotifyChoice {...props} />
      <div className={["mt-2 text-[11px] font-medium", willNotify ? "text-blue-700" : "text-slate-500"].join(" ")}>
        {willNotify
          ? `Client will be notified by ${value === "both" ? "email and SMS" : value === "email" ? "email" : "SMS"}.`
          : "Client will not be notified of this change."}
      </div>
    </div>
  );
}

type Props = {
  onClose: () => void;
  onSaved: () => void;
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  // Called whenever the Worked Hours card's "Adjust Worked Time" control
  // saves a correction -- same shape and same purpose as DispatchPanel's own
  // onHoursSaved (DashboardShell.tsx's handleHoursSaved), so a correction
  // made from either surface updates the same shared employeeHours state
  // immediately, without waiting on this modal's own onSaved()/close.
  onHoursSaved: (entry: EmployeeHours) => void;
  // Phase 5.7D-R18: every appointment_employees row for the workspace (not
  // pre-filtered to this appointment) -- filtered internally below to the
  // appointment being edited, for both the multi-employee selector's
  // initial state and the per-employee Worked Hours cards.
  assignments: AppointmentEmployeeAssignment[];
  editing?: { appointment: Appointment; client: Client };
  prefill?: { date: string; time: string };
  // Phase 5.5E-E1A: the one canonical EntitlementView field this modal's
  // mutation controls are governed by -- never a raw EntitlementView/
  // EntitlementResult, never billing/subscription state, never a
  // workspace/Stripe identifier. The server-side canMutateOperationalData
  // capability gate on appointments/create, update, delete, and
  // manage-recurrence (unchanged by this phase) remains the sole security
  // boundary; this is UX only.
  canMutateOperationalData: boolean;
  // The owner-correction capability gate for the "Adjust Worked Time"
  // control -- the same EntitlementView field (not canMutateOperationalData)
  // DispatchPanel's own manual-hours correction already uses, matching the
  // capability the server route (save_employee_hours) actually enforces.
  canUseJobTracking: boolean;
  // Phase 5C: the workspace's own resolved timezone -- every date/time form
  // field reads/writes through this explicitly (via
  // zonedDateValue/zonedTimeValue/zonedDateTimeToUTC in lib/timezone.ts),
  // never the browser/device's own ambient timezone. A 9:00 AM New York
  // appointment must display and save as 9:00 AM New York even when the
  // owner is physically traveling in a different timezone.
  timezone: string;
};

export default function AppointmentModal({ onClose, onSaved, clients, appointments, services, employees, employeeHours, onHoursSaved, assignments, editing, prefill, canMutateOperationalData, canUseJobTracking, timezone }: Props) {
  const isEdit = !!editing;

  // Phase 5.7D-R18: this appointment's own assignment rows (edit mode
  // only) -- the source of truth for both the initial multi-employee
  // selection and the per-employee Worked Hours cards below.
  const apptAssignments = isEdit ? assignments.filter((a) => a.appointment_id === editing!.appointment.id) : [];
  const initialEmployeeIds = apptAssignments.map((a) => a.employee_id);

  const serviceNames = services.length > 0 ? services.map((s) => s.name) : FALLBACK_SERVICES;
  const serviceDurations: Record<string, number> = {};
  const serviceDefaultPriceCents: Record<string, number | null> = {};
  for (const s of services) {
    serviceDurations[s.name] = s.duration_minutes;
    serviceDefaultPriceCents[s.name] = s.default_price_cents ?? null;
  }
  const initialService = editing?.appointment.service_type ?? serviceNames[0] ?? "";
  function defaultDuration(name: string) { return serviceDurations[name] ?? 60; }

  function initTimeIn(): string {
    if (editing) return snapTo15(zonedTimeValue(editing.appointment.scheduled_for, timezone));
    if (prefill?.time) return snapTo15(prefill.time);
    return "09:00";
  }
  function initTimeOut(): string {
    if (editing?.appointment.scheduled_end) return snapTo15(zonedTimeValue(editing.appointment.scheduled_end, timezone));
    return addMinsToHHMM(initTimeIn(), editing?.appointment.duration_minutes ?? defaultDuration(initialService));
  }
  // Editing an appointment always shows its OWN price snapshot, never the
  // service's current default (see migrations/020 -- a service's default
  // price never retroactively changes an existing appointment). Creating a
  // new appointment proposes the initially-selected service's default price
  // (or blank, if that service has none).
  function initPrice(): string {
    if (editing) return centsToInputValue(editing.appointment.price_cents);
    return centsToInputValue(serviceDefaultPriceCents[initialService] ?? null);
  }

  // Client state
  const [clientMode, setClientMode] = useState<"existing" | "new">("existing");
  const [selectedClientId, setSelectedClientId] = useState(editing?.appointment.client_id ?? "");
  const [newClient, setNewClient] = useState({ name: "", email: "", phone: "" });

  // Employee state -- Phase 5.7D-R18: zero, one, or many assigned
  // employees, initialized from this appointment's own assignment rows
  // (never from the legacy single appointments.employee_id column).
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>(initialEmployeeIds);
  const [confirmUnassign, setConfirmUnassign] = useState(false);

  function addEmployee(id: string) {
    setSelectedEmployeeIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }
  function removeEmployee(id: string) {
    setSelectedEmployeeIds((prev) => prev.filter((e) => e !== id));
  }

  // Team Color state (Phase 5.7D-R19) -- initialized from the appointment's
  // own stored value (null for a brand new appointment, or one that's never
  // had an explicit selection). Only ever changed by clicking a swatch
  // below -- adding/removing employees never reads or writes this state,
  // which is exactly what preserves it across a temporary drop to one/zero
  // employees (see resolveTeamAccentColor, which ignores it below 2
  // assignments without this component ever having to clear it).
  const [teamColor, setTeamColor] = useState<string | null>(editing?.appointment.team_color ?? null);

  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;

  // A live preview of "assignment order" for the CURRENTLY selected
  // employees, used only to resolve which color the card would show right
  // now (before saving). selectedEmployeeIds already carries the correct
  // order on its own -- it starts as apptAssignments' own stable order
  // (see initialEmployeeIds above, itself derived from the assignments
  // prop, which is now queried in stable order) and only ever grows by
  // appending (addEmployee), exactly matching how a real new assignment row
  // would sort after every existing one. Synthetic, strictly increasing
  // per-index timestamps let this route through the exact same
  // resolveTeamAccentColor/sortAssignmentsStable logic every other surface
  // uses, rather than duplicating the resolution rule here.
  const previewAssignments = selectedEmployeeIds.map((employee_id, index) => ({
    id: `preview-${index}`,
    employee_id,
    created_at: new Date(index).toISOString(),
  }));
  const effectiveAccentColor = resolveTeamAccentColor(previewAssignments, employeeById, teamColor);
  const teamColorChoices = buildTeamColorChoices(
    selectedEmployeeIds.map((id) => employeeById[id]).filter((e): e is Employee => !!e)
  );

  // Form state
  const [form, setForm] = useState({
    service_type: initialService,
    date: editing ? zonedDateValue(editing.appointment.scheduled_for, timezone) : (prefill?.date ?? ""),
    time_in: initTimeIn(),
    time_out: initTimeOut(),
    notes: editing?.appointment.notes ?? "",
    status: editing?.appointment.status ?? "scheduled",
    frequency_type: "one_time" as string,
    repeat_weeks: 1,
    repeat_months: 1,
    price: initPrice(),
  });
  // True once the owner has directly typed into the Price field themselves
  // this session, OR (when editing) the appointment already had a real
  // price snapshot on file when the modal opened -- in either case, a later
  // service change must never silently overwrite it. Starts false when
  // creating a new appointment (or editing one with no price yet), so a
  // service change safely proposes that service's default price until the
  // owner enters their own value.
  const [priceTouched, setPriceTouched] = useState(isEdit && editing!.appointment.price_cents != null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [error, setError] = useState("");

  // Notification choice — defaults to "none" so staff must opt in before anything is sent.
  // For edits, a smart default kicks in below once a meaningful field changes (see effect),
  // but only until the staff member touches the control themselves.
  const [notifyChannel, setNotifyChannel] = useState<NotifyChannel>("none");
  const [notifyTouched, setNotifyTouched] = useState(false);
  const [cancelNotifyChannel, setCancelNotifyChannel] = useState<NotifyChannel>("none");

  const contactEmail = isEdit ? (editing!.client.email ?? "") : (clientMode === "existing" ? (clients.find((c) => c.id === selectedClientId)?.email ?? "") : newClient.email);
  const contactPhone = isEdit ? (editing!.client.phone ?? "") : (clientMode === "existing" ? (clients.find((c) => c.id === selectedClientId)?.phone ?? "") : newClient.phone);
  const hasEmail = !!contactEmail.trim();
  const hasPhone = !!contactPhone.trim();

  const [showManageRecurrence, setShowManageRecurrence] = useState(false);
  const [manageFreq, setManageFreq] = useState<string>(editing?.appointment.frequency_type ?? "one_time");
  const [manageWeeks, setManageWeeks] = useState<number>(editing?.appointment.repeat_weeks ?? 1);
  const [manageMonths, setManageMonths] = useState<number>(editing?.appointment.repeat_months ?? 1);
  // Coordinated-save fix (recurrence changes silently dropped on save): a
  // pending recurrence change is detected from manageFreq/manageWeeks/
  // manageMonths against the appointment's CURRENTLY PERSISTED values --
  // deliberately independent of whether the Manage Recurrence panel is
  // currently expanded (showManageRecurrence), so collapsing it before
  // saving can never hide a real, still-pending selection from the save
  // path. These three fields never change except via direct owner
  // interaction with this panel's own radio buttons (see the "Manage >"
  // handlers below, which explicitly re-sync them from the appointment),
  // so comparing against `editing.appointment` -- stable for this modal's
  // whole lifetime -- is correct for the entire session, including retries.
  const hasPendingRecurrenceChange = isEdit && (
    manageFreq !== (editing!.appointment.frequency_type ?? "one_time") ||
    (manageFreq === "weekly" && manageWeeks !== (editing!.appointment.repeat_weeks ?? 1)) ||
    (manageFreq === "monthly" && manageMonths !== (editing!.appointment.repeat_months ?? 1))
  );
  // Double-click / re-entrancy guard: a synchronous ref (not state, which
  // only takes effect on the next render) so two rapid activations of
  // either save control can never both pass the "not currently saving"
  // check before the first one's own disabled-button re-render commits.
  const savingRef = useRef(false);
  // Atomic recurrence change: identifies ONE specific save to the server
  // (migrations/029). The server binds this id to the workspace, the
  // appointment, and the ENTIRE normalized request, so it is only reused
  // while every input is unchanged -- i.e. a retry of the same click after a
  // lost response or network error, which the server then answers with the
  // stored result instead of running the change twice. Changing ANYTHING
  // (date, time, service, notes, price, employees, pattern) mints a new id,
  // because the same id with a different request is answered with a
  // conflict. `for` is the request signature the current id was minted for;
  // it is cleared once the server confirms the change.
  const recurrenceOperationRef = useRef<{ id: string; for: string } | null>(null);
  function getRecurrenceOperationId(signature: string): string {
    if (!recurrenceOperationRef.current || recurrenceOperationRef.current.for !== signature) {
      recurrenceOperationRef.current = { id: crypto.randomUUID(), for: signature };
    }
    return recurrenceOperationRef.current.id;
  }

  function set(field: string, value: string | number) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "service_type" && typeof value === "string") {
        next.time_out = addMinsToHHMM(next.time_in, defaultDuration(value));
        // Proposes the newly selected service's default price -- but never
        // once the owner has entered/kept a price of their own (see
        // priceTouched above).
        if (!priceTouched) {
          next.price = centsToInputValue(serviceDefaultPriceCents[value] ?? null);
        }
      }
      if (field === "time_in" && typeof value === "string") {
        const dur = diffMins(prev.time_in, prev.time_out);
        next.time_out = addMinsToHHMM(value, dur > 0 ? dur : defaultDuration(prev.service_type));
      }
      return next;
    });
  }

  function setPrice(value: string) {
    setPriceTouched(true);
    setForm((prev) => ({ ...prev, price: value }));
  }

  const computedDuration = diffMins(form.time_in, form.time_out);
  const durationDisplay = computedDuration > 0 ? durationLabel(computedDuration) : "";
  const timeOutError = computedDuration <= 0 && form.time_in && form.time_out;

  // Detect whether an edit changed something the client would actually care about
  // (date/time, employee, or service) versus only internal fields (notes, status).
  // originalDurationMins reuses initTimeIn/initTimeOut, which are pure functions of
  // `editing` — they reflect the appointment's original values, unaffected by `form`.
  const originalStartMs = isEdit ? new Date(editing!.appointment.scheduled_for).getTime() : null;
  const currentStartConversion = form.date && form.time_in ? zonedDateTimeToUTC(form.date, form.time_in, timezone) : null;
  const currentStartMs = currentStartConversion?.ok ? new Date(currentStartConversion.iso).getTime() : null;
  const originalDurationMins = isEdit ? diffMins(initTimeIn(), initTimeOut()) : 0;
  const dateTimeChanged = isEdit && (currentStartMs !== originalStartMs || computedDuration !== originalDurationMins);
  // Phase 5.7D-R18: employee-assignment changes are staffing-only and must
  // default to NO client notification (Section G.2) -- removing Teresa is
  // not a cancellation and shouldn't read like one. Unlike date/time and
  // service changes, an employee-assignment change is deliberately never
  // added to importantFieldsChanged's smart-notify trigger below.
  const serviceChanged = isEdit && form.service_type !== editing!.appointment.service_type;
  const importantFieldsChanged = dateTimeChanged || serviceChanged;

  // Coordinated-save fix: whether THIS occurrence's own fields (not its
  // recurrence pattern) differ from what's currently persisted -- used to
  // skip sending a redundant, no-op /api/appointments/update call (and its
  // notification) for a pure recurrence-only edit, and to build the
  // retry-safety signature below.
  const notesChanged = isEdit && form.notes.trim() !== (editing!.appointment.notes ?? "");
  const statusChanged = isEdit && form.status !== editing!.appointment.status;
  const currentPriceCents = form.price.trim() === "" ? null : parsePriceToCents(form.price);
  const priceChanged = isEdit && currentPriceCents !== (editing!.appointment.price_cents ?? null);
  const teamColorChanged = isEdit && teamColor !== (editing!.appointment.team_color ?? null);
  const employeeIdsChanged = isEdit && (
    selectedEmployeeIds.length !== initialEmployeeIds.length ||
    [...selectedEmployeeIds].sort().join(",") !== [...initialEmployeeIds].sort().join(",")
  );
  const hasPendingApptFieldChanges = isEdit && (
    dateTimeChanged || serviceChanged || notesChanged || statusChanged || priceChanged || teamColorChanged || employeeIdsChanged
  );

  // Missing-hours identification is now per assigned employee (Section
  // E.7) -- getMissingHoursEmployeeIds (lib/payroll.ts) is the exact same
  // predicate driving the schedule grid's warning triangle, so this modal
  // and the triangle never disagree about which employee(s) need
  // attention.
  const jobTrackingAppt = editing?.appointment ?? null;
  const missingHoursEmployeeIds = jobTrackingAppt ? getMissingHoursEmployeeIds(jobTrackingAppt, apptAssignments, employeeHours) : [];

  // Smart default: preselect a notify channel once a meaningful field changes, but
  // never override a choice the staff member already made themselves.
  useEffect(() => {
    if (!isEdit || notifyTouched) return;
    setNotifyChannel(importantFieldsChanged ? preferredNotifyChannel(editing!.client.preferred_contact_method, hasEmail, hasPhone) : "none");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importantFieldsChanged]);

  const isRecurring = isEdit && !!editing.appointment.series_id && editing.appointment.frequency_type !== "one_time";
  const [editScope, setEditScope] = useState<"single" | "future" | null>(null);

  function validateForm(): boolean {
    setError("");
    if (clientMode === "existing" && !selectedClientId) { setError("Select a client."); return false; }
    if (clientMode === "new") {
      if (!newClient.name.trim()) { setError("Client name is required."); return false; }
      if (!newClient.email.trim() && !newClient.phone.trim()) { setError("Provide at least an email or phone."); return false; }
    }
    if (!form.date || !form.time_in || !form.time_out) { setError("Date, Time In, and Time Out are required."); return false; }
    if (computedDuration <= 0) { setError("Time Out must be after Time In."); return false; }
    if (form.price.trim() !== "" && parsePriceToCents(form.price) === null) {
      setError("Enter a valid price (e.g. 45 or 45.00), or leave it blank.");
      return false;
    }
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Blocks both a click on the (already-disabled) submit button AND a
    // native implicit form submission triggered by pressing Enter inside
    // any text input in this form -- the latter goes straight to this
    // onSubmit handler, bypassing the button and its `disabled` attribute
    // entirely, so this check (not the button's disabled state alone) is
    // what actually prevents a restricted Enter-submit.
    if (!canMutateOperationalData) return;
    if (!validateForm()) return;
    proceedAfterValidation();
  }

  // Phase 5.7D-R18: removing the last assigned employee must not silently
  // save an unassigned appointment (Section C.6) -- this gate runs BEFORE
  // the recurring edit-scope gate, so an owner sees "this will become
  // unassigned" before "apply to this occurrence or all future ones,"
  // never the reverse. `unassignConfirmed` lets the confirmation button
  // below continue synchronously without waiting on a state re-render.
  function proceedAfterValidation(unassignConfirmed = confirmUnassign) {
    const removingLastEmployee = isEdit && initialEmployeeIds.length > 0 && selectedEmployeeIds.length === 0;
    if (removingLastEmployee && !unassignConfirmed) {
      setConfirmUnassign(true);
      return;
    }

    // A pending recurrence change is inherently series-wide -- that's what
    // "repeat every N weeks" means, it always replaces the series' own
    // future occurrences regardless of which single occurrence the owner
    // happened to edit it from -- so the "Only this appointment" / "This and
    // all future appointments" choice does not apply and is skipped. The
    // accompanying appointment edits and the recurrence change are saved
    // TOGETHER, in one transaction (see submitAtomicRecurrenceChange).
    if (isEdit && hasPendingRecurrenceChange) {
      executeCoordinatedSave("single");
      return;
    }

    if (isEdit && isRecurring && !editScope) {
      setEditScope("single");
      return;
    }

    executeCoordinatedSave(editScope ?? "single");
  }

  // Saves the pending recurrence change TOGETHER with every other pending
  // appointment edit as ONE atomic server operation (/api/appointments/
  // manage-recurrence -> apply_recurrence_change): either everything is saved
  // (date/time, fields, employees, old series stopped, eligible occurrences
  // replaced, new series activated) or nothing is. `expected` is what this
  // modal opened with; the server compares it against the locked row and
  // rejects the whole request if someone else changed the appointment since.
  // There is deliberately no "previous scheduled_for" here: the server reads
  // the original position itself, from the locked row.
  async function submitAtomicRecurrenceChange(desired: {
    scheduled_for: string;
    scheduled_end: string;
    price_cents: number | null;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const a = editing!.appointment;
    const fields = {
      scheduled_for: desired.scheduled_for,
      scheduled_end: desired.scheduled_end,
      service_type: form.service_type,
      notes: form.notes.trim(),
      duration_minutes: computedDuration,
      price_cents: desired.price_cents,
      team_color: teamColor,
      status: form.status,
    };
    const employee_ids = [...selectedEmployeeIds].sort();
    const expected = {
      scheduled_for: a.scheduled_for,
      scheduled_end: a.scheduled_end ?? null,
      service_type: a.service_type,
      notes: a.notes ?? null,
      duration_minutes: a.duration_minutes ?? null,
      price_cents: a.price_cents ?? null,
      team_color: a.team_color ?? null,
      status: a.status,
      series_id: a.series_id ?? null,
      frequency_type: a.frequency_type ?? "one_time",
      employee_ids: initialEmployeeIds,
      timezone,
    };
    const signature = JSON.stringify({ fields, employee_ids, manageFreq, manageWeeks, manageMonths });
    try {
      const res = await fetch("/api/appointments/manage-recurrence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointment_id: a.id,
          client_operation_id: getRecurrenceOperationId(signature),
          frequency_type: manageFreq,
          repeat_weeks: manageFreq === "weekly" ? manageWeeks : undefined,
          repeat_months: manageFreq === "monthly" ? manageMonths : undefined,
          fields,
          employee_ids,
          expected,
          notify_channel: notifyChannel,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message: string = data?.error || `Request failed (${res.status}). Nothing was saved.`;
        // A 4xx means the server refused the request before changing anything
        // (the whole operation is atomic), so "nothing was saved" is exact --
        // say it for every such rejection, not only the ones whose own wording
        // already does. A 5xx keeps the server's own wording: it may not know.
        const refused = res.status >= 400 && res.status < 500;
        return { ok: false, error: refused && !/nothing was saved/i.test(message) ? `${message} Nothing was saved.` : message };
      }
      if (data?.notice?.message) alert(data.notice.message);
      recurrenceOperationRef.current = null;
      return { ok: true };
    } catch {
      // The request may or may not have reached the server. The operation id
      // is kept, so retrying the same click is answered with the stored
      // result if it did commit -- never applied twice.
      return { ok: false, error: "Network error. Please try again -- nothing will be applied twice." };
    }
  }

  // The single save path for an edit session:
  //   - A pending recurrence change goes through submitAtomicRecurrenceChange
  //     with every other pending edit: one request, one transaction, all or
  //     nothing. The modal closes (onSaved()) only after the server confirms.
  //   - Otherwise only the appointment's own fields are saved via
  //     /api/appointments/update (and only if something actually changed).
  // For a brand-new appointment (!isEdit), this preserves the exact
  // pre-existing create-mode behavior (a single POST to
  // /api/appointments/create, which already includes frequency_type/
  // repeat_weeks/repeat_months).
  async function executeCoordinatedSave(mode: "single" | "future") {
    // Defense-in-depth: this function has a second call site (the
    // recurring-appointment edit-scope buttons below) that bypasses
    // handleSubmit's own guard entirely, so both checks are repeated here.
    if (!canMutateOperationalData) return;
    if (!validateForm()) return;
    // Double-click / re-entrancy guard -- see savingRef's own declaration.
    if (savingRef.current) return;
    savingRef.current = true;

    const startResult = zonedDateTimeToUTC(form.date, form.time_in, timezone);
    if (!startResult.ok) { setError(startResult.error); savingRef.current = false; return; }
    const endResult = zonedDateTimeToUTC(form.date, form.time_out, timezone);
    if (!endResult.ok) { setError(endResult.error); savingRef.current = false; return; }
    const scheduled_for = startResult.iso;
    const scheduled_end = endResult.iso;
    const price_cents = form.price.trim() === "" ? null : parsePriceToCents(form.price);

    setSubmitting(true);
    setEditScope(null);
    setError("");
    try {
      if (!isEdit) {
        const payload: Record<string, any> = {
          service_type: form.service_type,
          scheduled_for, scheduled_end,
          notes: form.notes.trim(),
          duration_minutes: computedDuration,
          frequency_type: form.frequency_type,
          repeat_weeks: form.repeat_weeks,
          repeat_months: form.repeat_months,
          employee_ids: selectedEmployeeIds,
          price_cents,
          team_color: teamColor,
          notify_channel: notifyChannel,
        };
        if (clientMode === "existing") payload.client_id = selectedClientId;
        else {
          payload.name = newClient.name.trim();
          payload.email = newClient.email.trim();
          payload.phone = newClient.phone.trim();
        }
        const res = await fetch("/api/appointments/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setError(data?.error || `Request failed (${res.status})`); return; }
        if (data?.warning?.message) alert(data.warning.message);
        notifyDemoAction("create-appointment");
        onSaved();
        return;
      }

      // Edit mode.
      if (hasPendingRecurrenceChange) {
        if (form.status !== "scheduled") {
          setError("Set the status back to Scheduled before changing the recurrence.");
          return;
        }
        const result = await submitAtomicRecurrenceChange({ scheduled_for, scheduled_end, price_cents });
        if (!result.ok) { setError(result.error); return; }
        if (serviceChanged) notifyDemoAction("save-service");
        onSaved();
        return;
      }

      // No recurrence change: only this appointment's own fields, and only
      // when something actually changed (a no-op save sends nothing).
      if (hasPendingApptFieldChanges) {
        const res = await fetch("/api/appointments/update", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appointment_id: editing.appointment.id,
            service_type: form.service_type,
            scheduled_for, scheduled_end,
            notes: form.notes.trim(),
            status: form.status,
            duration_minutes: computedDuration,
            employee_ids: [...selectedEmployeeIds].sort(),
            price_cents,
            team_color: teamColor,
            mode,
            notify_channel: notifyChannel,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setError(data?.error || `Request failed (${res.status})`); return; }
        if (data?.warning?.message) alert(data.warning.message);
        if (serviceChanged) notifyDemoAction("save-service");
      }

      onSaved();

    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
      savingRef.current = false;
    }
  }

  const [confirmDelete, setConfirmDelete] = useState<"single" | "future" | null>(null);

  async function executeDelete(mode: "single" | "future") {
    if (!editing) return;
    if (!canMutateOperationalData) return;

    setCancelling(true);
    setError("");
    try {
      const res = await fetch("/api/appointments/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: editing.appointment.id, mode, notify_channel: cancelNotifyChannel }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error || `Delete failed (${res.status})`); return; }
      if (data?.warning?.message) alert(data.warning.message);
      onSaved();
    } catch {
      setError("Network error. Please try again.");
    } finally { setCancelling(false); setShowDeleteMenu(false); setConfirmDelete(null); }
  }

  const inputCls = "w-full rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900";

  return (
    <div data-tour="appointment-modal" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 sm:px-0">
      <div className="w-full max-w-lg rounded-2xl border bg-white p-5 sm:p-6 shadow-lg max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{isEdit ? "Edit Appointment" : "New Appointment"}</div>
          <button onClick={onClose} className="rounded-lg border px-2 py-1 text-xs hover:bg-slate-50">Close</button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          {/* Client */}
          {isEdit ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Client</label>
              <div className="rounded-xl border px-3 py-2 text-sm bg-slate-50 text-slate-700">
                {editing.client.name}
                {editing.client.email && <span className="text-slate-400 ml-2">{editing.client.email}</span>}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-600">Client *</label>
                <button type="button" onClick={() => { setClientMode((m) => m === "existing" ? "new" : "existing"); setError(""); }}
                  className="text-[11px] text-blue-600 hover:text-blue-700">
                  {clientMode === "existing" ? "+ New Client" : "Select Existing"}
                </button>
              </div>
              {clientMode === "existing" ? (
                <select value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)} className={inputCls}>
                  <option value="">— Select a client —</option>
                  {clients.filter((c) => !c.archived_at).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.email ? ` (${c.email})` : c.phone ? ` (${c.phone})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/30 p-3">
                  <input type="text" value={newClient.name} onChange={(e) => setNewClient((p) => ({ ...p, name: e.target.value }))} className={inputCls} placeholder="Client name *" />
                  <div className="grid grid-cols-2 gap-2">
                    <input type="email" value={newClient.email} onChange={(e) => setNewClient((p) => ({ ...p, email: e.target.value }))} className={inputCls} placeholder="Email" />
                    <input type="tel" value={newClient.phone} onChange={(e) => setNewClient((p) => ({ ...p, phone: e.target.value }))} className={inputCls} placeholder="Phone" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Service + Status */}
          <div className={isEdit ? "grid grid-cols-2 gap-3" : ""}>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Service Type</label>
              <select data-tour="service-selector" value={form.service_type} onChange={(e) => set("service_type", e.target.value)} className={inputCls}>
                {serviceNames.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {isEdit && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
                <select value={form.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
                  <option value="scheduled">Scheduled</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            )}
          </div>

          {/* Assigned Employees -- Phase 5.7D-R18: zero, one, or many. Each
              selected employee is shown as its own removable chip (never
              hidden behind a menu the owner has to reopen), and a plain
              <select> below adds one more -- both work identically on
              touch/mobile. */}
          {employees.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Assigned Employees</label>
              {selectedEmployeeIds.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {selectedEmployeeIds.map((id) => {
                    const emp = employees.find((e) => e.id === id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 pl-2.5 pr-1 py-1 text-xs text-slate-700">
                        {emp?.name ?? "Unknown"}
                        <button
                          type="button"
                          onClick={() => removeEmployee(id)}
                          aria-label={`Remove ${emp?.name ?? "employee"}`}
                          className="rounded-full hover:bg-slate-200 w-4 h-4 flex items-center justify-center text-slate-500 leading-none"
                        >
                          &times;
                        </button>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-slate-400 mb-1.5">Unassigned</div>
              )}
              <select
                value=""
                onChange={(e) => { if (e.target.value) addEmployee(e.target.value); }}
                className={inputCls}
              >
                <option value="">+ Add employee…</option>
                {employees.filter((emp) => emp.active && !selectedEmployeeIds.includes(emp.id)).map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Team Color -- Phase 5.7D-R19: only shown at two or more
              assigned employees (a single employee's own color already
              represents the card, and an unassigned appointment has no
              color to choose). teamColor itself stays exactly as it was
              when the modal opened until the owner clicks a swatch --
              dropping to one/zero employees hides this section without
              touching that state, so re-adding a second employee later
              reveals the same preserved selection. The currently
              "selected" swatch is effectiveAccentColor, which already
              falls back to the deterministic first-assignment color when
              teamColor is null -- so a never-explicitly-set team color
              still visibly highlights the color the card is actually
              showing right now. */}
          {selectedEmployeeIds.length >= 2 && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Team Color</label>
              <div role="radiogroup" aria-label="Team Color" className="flex flex-wrap gap-1.5">
                {teamColorChoices.map((choice) => {
                  const isSelected = choice.hex === effectiveAccentColor;
                  return (
                    <button
                      key={choice.hex}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      title={choice.kind === "employee" ? `${choice.label}'s color` : choice.label}
                      onClick={() => setTeamColor(choice.hex)}
                      className={[
                        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors",
                        isSelected ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:bg-slate-50",
                      ].join(" ")}
                    >
                      <span
                        aria-hidden="true"
                        className="w-4 h-4 rounded-full border border-black/10 shrink-0 flex items-center justify-center"
                        style={{ backgroundColor: choice.hex }}
                      >
                        {isSelected && <span className="text-white text-[9px] leading-none">&#10003;</span>}
                      </span>
                      <span className={choice.kind === "employee" ? "text-slate-700" : "text-slate-500"}>
                        {choice.label}
                      </span>
                      {isSelected && <span className="sr-only"> (selected)</span>}
                    </button>
                  );
                })}
              </div>
              {!teamColor && (
                <div className="text-[11px] text-slate-400 mt-1">
                  Using {employeeById[previewAssignments[0]?.employee_id]?.name ?? "the first"}&apos;s color by default — select a color to customize.
                </div>
              )}
            </div>
          )}

          {/* Date / Time In / Time Out */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date *</label>
              <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 sm:contents gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Time In *</label>
                <select value={form.time_in} onChange={(e) => set("time_in", e.target.value)} className={inputCls}>
                  {TIME_SLOTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Time Out *</label>
                <select value={form.time_out} onChange={(e) => set("time_out", e.target.value)} className={inputCls}>
                  {TIME_SLOTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
          </div>

          {durationDisplay && !timeOutError && (
            <div className="text-xs text-slate-500 -mt-1">
              Duration: <span className="font-medium text-slate-700">{durationDisplay}</span>
            </div>
          )}
          {timeOutError && <div className="text-xs text-rose-600 -mt-1">Time Out must be after Time In.</div>}

          {/* Frequency — create mode only */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Frequency</label>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {(["one_time", "daily", "weekdays", "weekly", "monthly"] as const).map((ft) => (
                  <label key={ft} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="frequency"
                      checked={form.frequency_type === ft}
                      onChange={() => set("frequency_type", ft)}
                      className="accent-slate-900"
                    />
                    {ft === "one_time" ? "One Time" : ft === "daily" ? "Daily" : ft === "weekdays" ? "Weekdays" : ft === "weekly" ? "Weekly" : "Monthly"}
                  </label>
                ))}
              </div>

              {form.frequency_type === "weekly" && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-slate-600">Repeat Every</span>
                  <select
                    value={form.repeat_weeks}
                    onChange={(e) => set("repeat_weeks", Number(e.target.value) as any)}
                    className="rounded-xl border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-20"
                  >
                    {WEEK_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                  <span className="text-xs text-slate-600">Week{form.repeat_weeks > 1 ? "s" : ""}</span>
                </div>
              )}

              {form.frequency_type === "monthly" && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-slate-600">Repeat Every</span>
                  <select
                    value={form.repeat_months}
                    onChange={(e) => set("repeat_months", Number(e.target.value) as any)}
                    className="rounded-xl border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-20"
                  >
                    {MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <span className="text-xs text-slate-600">Month{form.repeat_months > 1 ? "s" : ""}</span>
                </div>
              )}

              {form.frequency_type !== "one_time" && (
                <div className="mt-1 text-[11px] text-slate-500">
                  {form.frequency_type === "weekdays"
                    ? "Appointments will be created for weekdays (Mon–Fri) over the next 26 weeks."
                    : form.frequency_type === "monthly"
                      ? "Appointments will be created for the next 24 months from the start date."
                      : "Appointments will be created for the next 26 weeks from the start date."}
                </div>
              )}
            </div>
          )}

          {/* Recurrence info — edit mode */}
          {isEdit && !showManageRecurrence && (() => {
            const ft = editing.appointment.frequency_type;
            const isOneTime = !ft || ft === "one_time";

            if (isOneTime) {
              return (
                <div className="rounded-xl border bg-slate-50 px-3 py-2 flex items-center justify-between">
                  <span className="text-xs text-slate-500">One-time appointment</span>
                  <button type="button" onClick={() => { setManageFreq("one_time"); setManageWeeks(1); setManageMonths(1); setShowManageRecurrence(true); }}
                    className="text-[11px] text-blue-600 hover:text-blue-700 font-medium">Manage &gt;</button>
                </div>
              );
            }

            const rw = editing.appointment.repeat_weeks ?? 1;
            const rm = editing.appointment.repeat_months ?? 1;
            const sid = editing.appointment.series_id;
            const currentTime = new Date(editing.appointment.scheduled_for).getTime();

            const remaining = sid
              ? appointments.filter((a) =>
                  a.series_id === sid &&
                  a.status === "scheduled" &&
                  new Date(a.scheduled_for).getTime() >= currentTime
                ).length
              : 0;

            const intervalLabel = ft === "daily"
              ? "Daily"
              : ft === "weekdays"
                ? "Weekdays (Mon–Fri)"
                : ft === "monthly"
                  ? (rm === 1 ? "Monthly" : `Monthly • Every ${rm} months`)
                  : rw === 1 ? "Weekly" : `Weekly • Every ${rw} weeks`;

            return (
              <div className="rounded-xl border bg-slate-50 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Recurring Schedule</div>
                  <button type="button" onClick={() => { setManageFreq(ft!); setManageWeeks(rw); setManageMonths(rm); setShowManageRecurrence(true); }}
                    className="text-[11px] text-blue-600 hover:text-blue-700 font-medium">Manage &gt;</button>
                </div>
                <div className="text-sm font-medium text-slate-900 mt-1">{intervalLabel}</div>
                {remaining > 0 && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {remaining} appointment{remaining !== 1 ? "s" : ""} remaining
                  </div>
                )}
              </div>
            );
          })()}

          {/* Manage Recurrence panel */}
          {isEdit && showManageRecurrence && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/30 p-4 space-y-3">
              <div className="text-xs font-semibold text-slate-700">Manage Recurrence</div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-2">Change to:</label>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {(["one_time", "daily", "weekdays", "weekly", "monthly"] as const).map((ft) => (
                    <label key={ft} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input type="radio" name="manage_freq" checked={manageFreq === ft}
                        onChange={() => { setManageFreq(ft); if (ft !== "weekly") setManageWeeks(1); if (ft !== "monthly") setManageMonths(1); }}
                        className="accent-slate-900" />
                      {ft === "one_time" ? "One-time" : ft === "daily" ? "Daily" : ft === "weekdays" ? "Weekdays" : ft === "weekly" ? "Weekly" : "Monthly"}
                    </label>
                  ))}
                </div>
              </div>

              {manageFreq === "weekly" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-600">Repeat every</span>
                  <select value={manageWeeks} onChange={(e) => setManageWeeks(Number(e.target.value))}
                    className="rounded-xl border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-20">
                    {WEEK_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                  <span className="text-xs text-slate-600">week{manageWeeks > 1 ? "s" : ""}</span>
                </div>
              )}

              {manageFreq === "monthly" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-600">Repeat every</span>
                  <select value={manageMonths} onChange={(e) => setManageMonths(Number(e.target.value))}
                    className="rounded-xl border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-20">
                    {MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <span className="text-xs text-slate-600">month{manageMonths > 1 ? "s" : ""}</span>
                </div>
              )}

              {manageFreq !== "one_time" && (
                <div className="text-xs text-slate-500">
                  This will create approximately {countFutureOccurrences(manageFreq, manageWeeks, timezone, new Date(editing.appointment.scheduled_for), manageMonths)} future appointments.
                </div>
              )}
              {manageFreq === "one_time" && editing.appointment.series_id && (
                <div className="text-xs text-slate-500">
                  Future recurring appointments will be cancelled.
                </div>
              )}

              {/* This button routes through the exact same save workflow as
                  the main "Save Changes" button below (proceedAfterValidation),
                  rather than a separate, independent submission -- so it can
                  never apply a recurrence change against a stale date/time
                  still sitting unsaved in the form above it. Any pending
                  appointment field edits (date, time, service, notes, etc.)
                  are saved TOGETHER with this recurrence change, in one
                  atomic server operation. */}
              {hasPendingApptFieldChanges && (
                <div className="text-[11px] text-slate-500">
                  Your other appointment changes above are saved together with this recurrence change -- all of it is saved, or none of it.
                </div>
              )}
              <div className="flex gap-2 pt-1">
                <CapabilityGatedButton
                  type="button"
                  allowed={canMutateOperationalData}
                  disabled={submitting}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  onClick={() => proceedAfterValidation()}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors">
                  {submitting ? "Saving..." : "Save Recurrence"}
                </CapabilityGatedButton>
                <button type="button" onClick={() => setShowManageRecurrence(false)} disabled={submitting}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-white transition-colors disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Job Tracking / Worked Hours — edit mode only, one card per
              assigned employee (Phase 5.7D-R18, Section C.8: Worked Hours
              are shown separately by employee, below the appointment's own
              fields and above Price -- Price itself stays a single,
              appointment-level value regardless of how many employees are
              assigned, see the Price field above). Never fabricates a
              timestamp — Started/Completed only ever show a real
              actual_started_at/actual_completed_at value or "Not recorded." */}
          {/* Phase 5.7D-R19: hidden entirely for a cancelled appointment --
              matches computePayrollRows' unconditional cancelled-skip
              (lib/payroll.ts) and ScheduleGrid's own cancelled-appointments-
              never-shown convention. Rows are rendered in stable assignment
              order (sortAssignmentsStable), the same order Team Color's
              deterministic fallback and the Assigned Employees chips use. */}
          {isEdit && editing!.appointment.status !== "cancelled" && apptAssignments.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-600">Worked Hours</div>
              {sortAssignmentsStable(apptAssignments).map((assignment) => {
                const emp = employees.find((e) => e.id === assignment.employee_id);
                const manualEntry = findManualHoursEntry(editing!.appointment.id, assignment.employee_id, employeeHours);
                const complete = isJobTrackingComplete(assignment);
                const isWarning = missingHoursEmployeeIds.includes(assignment.employee_id);
                // Unresolved only — once a valid manual entry (or complete
                // tracking) exists, this employee no longer appears in
                // missingHoursEmployeeIds, so the warning styling drops
                // away on its own; no separate "dismiss" step needed.
                const hasAnyRecordedActivity = !!assignment.actual_started_at || !!assignment.actual_completed_at || !!manualEntry;

                // Phase 5.7D-R19: an assigned employee with no recorded
                // activity and no warning yet (a future appointment, or a
                // same-day appointment that hasn't started -- both are
                // exactly the appointments isEligibleForWorkedHoursWarning
                // says are "not due yet") used to be silently omitted here.
                // Every assigned employee must always appear -- this is
                // purely informational: it never creates
                // appointment_employee_hours, never touches assignment
                // timestamps, and (being neither `complete` nor `isWarning`)
                // never affects missingHoursCount or payroll.
                if (!hasAnyRecordedActivity && !isWarning) {
                  return (
                    <div key={assignment.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs space-y-1">
                      <div className="font-medium text-slate-700">{emp?.name ?? "Unknown employee"}</div>
                      <div className="text-slate-500">Not tracked yet.</div>
                    </div>
                  );
                }

                // Displayed in the business's own resolved timezone, not
                // the owner's device timezone -- toBusinessLocal's
                // synthesized Date is self-consistent for this native
                // toLocaleString() read (no explicit timeZone needed) the
                // same way it already is for native getters elsewhere.
                const startedLabel = assignment.actual_started_at
                  ? toBusinessLocal(assignment.actual_started_at, timezone).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                  : "Not recorded";
                const completedLabel = assignment.actual_completed_at
                  ? toBusinessLocal(assignment.actual_completed_at, timezone).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                  : "Not recorded";
                const workedMins = resolveWorkedMinutes(editing!.appointment.id, assignment.employee_id, assignment, employeeHours);
                // An owner override (appointment_employee_hours row) wins for
                // display now -- see resolveWorkedMinutes (lib/payroll.ts) --
                // so this branches on manualEntry FIRST, matching that same
                // precedence. `complete` still distinguishes "Adjusted by
                // owner, original tracked time was X" from the pre-existing
                // "Manually entered" case (no tracked value to compare
                // against), exactly like DispatchPanel's own card.
                const needsReview = needsWorkedTimeReview(editing!.appointment, editing!.appointment.id, assignment.employee_id, assignment, employeeHours);

                return (
                  <div
                    key={assignment.id}
                    className={[
                      "rounded-xl border px-3 py-2 text-xs space-y-1",
                      isWarning ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-600",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between">
                      <div className={isWarning ? "font-medium text-amber-800" : "font-medium text-slate-700"}>{emp?.name ?? "Unknown employee"}</div>
                      {needsReview && (
                        <span className="text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                          &#9888; Needs Review
                        </span>
                      )}
                    </div>
                    <div>Started: <span className="font-medium text-slate-900">{startedLabel}</span></div>
                    <div>Completed: <span className="font-medium text-slate-900">{completedLabel}</span></div>
                    {manualEntry ? (
                      <>
                        <div>Worked Time: <span className="font-medium text-slate-900">{formatMinutesAsDuration(workedMins)}</span></div>
                        <div className="text-emerald-700">Adjusted by owner.</div>
                        {complete && (
                          <div>Original tracked time: <span className="font-medium text-slate-900">{formatMinutesAsDuration(trackedMinutes(assignment) ?? 0)}</span></div>
                        )}
                        {manualEntry.note && (
                          <div>Reason: <span className="italic">{manualEntry.note}</span></div>
                        )}
                      </>
                    ) : complete ? (
                      <>
                        <div>Actual duration: <span className="font-medium text-slate-900">{formatMinutesAsDuration(workedMins)}</span></div>
                        <div className="text-emerald-700">Tracked automatically.</div>
                      </>
                    ) : (
                      <>
                        <div>Worked duration: not yet available.</div>
                        {isWarning && (
                          <div className="text-amber-700">
                            {hasInvalidJobTrackingDuration(assignment)
                              ? "Clock-in and clock-out produced no valid worked time."
                              : "Employee did not complete Job Tracking."}
                          </div>
                        )}
                      </>
                    )}
                    {/* Employee Job Notes: the employee's own optional
                        free text about how their portion of the job went
                        (migrations/028), saved via the "Save Note" action
                        while their job was active. Deliberately separate
                        from the appointment's own `notes` field (shown
                        elsewhere in this modal, owner-authored) and from
                        a manual hours entry's `note` correction reason
                        (shown above, in the branch that reads
                        manualEntry.note) -- read-only here in V1, but kept
                        visible right next to the correction control below
                        as supporting information for the owner. Never
                        parsed for a time, never used to alter payroll. */}
                    {assignment.job_notes && (
                      <div className="pt-1 border-t border-slate-200 mt-1">
                        <div className="font-medium text-slate-700">Job Notes:</div>
                        <div className="whitespace-pre-wrap">{assignment.job_notes}</div>
                      </div>
                    )}
                    {(complete || manualEntry) && (
                      <div className="pt-1">
                        <AdjustWorkedTimeControl
                          appointmentId={editing!.appointment.id}
                          employeeId={assignment.employee_id}
                          canCorrect={canUseJobTracking}
                          onSaved={onHoursSaved}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Price -- Phase 5.7D-R18, Section C.8: displayed below Worked
              Hours, since Price belongs to the appointment as a whole, not
              to any individual employee -- it is never duplicated or
              divided because multiple employees are assigned (Section
              C.9). An independent snapshot, not tied to the service's
              current default once saved (see migrations/020). Proposed
              from the selected service's default price above until the
              owner types their own value; see setPrice/priceTouched. */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Price</label>
            <div className="relative max-w-[10rem]">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-400">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => setPrice(e.target.value)}
                className={inputCls + " pl-6"}
                placeholder="Optional"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={inputCls + " resize-none"} placeholder="Optional notes..." />
          </div>

          {/* Notification choice */}
          <NotifyChoicePanel
            value={notifyChannel}
            onChange={(v) => { setNotifyChannel(v); setNotifyTouched(true); }}
            hasEmail={hasEmail}
            hasPhone={hasPhone}
            label={isEdit ? "Notify client about this change?" : "Send confirmation to client?"}
          />

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
          )}

          {/* Phase 5.5E-E1A: one shared notice for the whole modal, referenced
              via aria-describedby by every capability-gated button below --
              never repeated per-button. Rendered regardless of which panel
              (main actions / edit scope / delete confirm / recurrence) is
              currently visible, since it sits above all of them. */}
          {!canMutateOperationalData && (
            <div id={RESTRICTED_NOTICE_ID} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {RESTRICTED_WORDING}
            </div>
          )}

          {/* Phase 5.7D-R18, Section C.6: removing the last assigned
              employee must not silently save an unassigned appointment --
              explicit confirmation is required first. Does not delete the
              appointment; the client, service, date/time, notes, price,
              and recurrence identity are all completely unaffected. */}
          {confirmUnassign && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2">
              <div className="text-xs font-medium text-amber-800">
                Removing the last assigned employee will leave this appointment unassigned. The appointment itself will not be deleted. Continue?
              </div>
              <div className="flex gap-2">
                <CapabilityGatedButton
                  type="button"
                  allowed={canMutateOperationalData}
                  disabled={submitting}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  onClick={() => proceedAfterValidation(true)}
                  className="rounded-lg bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                  Yes, Save Unassigned
                </CapabilityGatedButton>
                <button type="button" onClick={() => setConfirmUnassign(false)} disabled={submitting}
                  className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs text-slate-700 hover:bg-white disabled:opacity-50">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Edit scope choice for recurring appointments */}
          {!confirmUnassign && editScope && isRecurring && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-2 space-y-1">
              <div className="text-[11px] font-medium text-slate-500 px-2 pb-1">Apply changes to:</div>
              <CapabilityGatedButton
                type="button"
                allowed={canMutateOperationalData}
                disabled={submitting}
                ariaDescribedBy={RESTRICTED_NOTICE_ID}
                onClick={() => executeCoordinatedSave("single")}
                className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">
                <div className="font-medium text-slate-900">Only this appointment</div>
                <div className="text-slate-500 mt-0.5">Change this one only</div>
              </CapabilityGatedButton>
              <CapabilityGatedButton
                type="button"
                allowed={canMutateOperationalData}
                disabled={submitting}
                ariaDescribedBy={RESTRICTED_NOTICE_ID}
                onClick={() => executeCoordinatedSave("future")}
                className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-blue-200 hover:bg-blue-50 disabled:opacity-50">
                <div className="font-medium text-blue-700">This and all future appointments</div>
                <div className="text-slate-500 mt-0.5">Apply to all remaining in this series</div>
              </CapabilityGatedButton>
              <button type="button" onClick={() => setEditScope(null)} disabled={submitting}
                className="w-full rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50">
                Cancel
              </button>
            </div>
          )}

          {/* Item 4 (make series scope explicit): whenever a recurrence
              change is pending, this explanation must be visible regardless
              of whether the Manage Recurrence panel itself is expanded or
              collapsed -- a note sitting only inside that panel would be
              invisible the moment the owner collapses it and clicks the
              main Save Changes button below, which applies the SAME
              recurrence change (see hasPendingRecurrenceChange and
              proceedAfterValidation). Only rendered when a recurrence
              change is actually pending -- an ordinary date/time-only or
              occurrence-only edit still gets the normal "Only this
              appointment" / "This and all future appointments" scope
              choice below, completely unaffected. */}
          {!editScope && !confirmUnassign && hasPendingRecurrenceChange && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/50 px-3 py-2 text-xs text-blue-800">
              Saving will update this appointment and apply the new recurrence pattern to its eligible future occurrences in this series. Occurrences with recorded work will be left on their current schedule.
            </div>
          )}

          {/* Actions */}
          {!editScope && !confirmUnassign && (
            <div className="flex gap-2 pt-1">
              <CapabilityGatedButton
                type="submit"
                allowed={canMutateOperationalData}
                disabled={submitting || cancelling}
                ariaDescribedBy={RESTRICTED_NOTICE_ID}
                className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50">
                {submitting ? (isEdit ? "Saving..." : "Creating...") : (isEdit ? "Save Changes" : "Create Appointment")}
              </CapabilityGatedButton>
              {isEdit && editing.appointment.status !== "cancelled" && (
                <div className="relative">
                  <button type="button" onClick={() => setShowDeleteMenu((v) => !v)} disabled={submitting || cancelling}
                    className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 hover:bg-rose-100 disabled:opacity-50">
                    {cancelling ? "Deleting..." : "Delete ▾"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Delete options — inline below action buttons */}
          {showDeleteMenu && isEdit && !confirmDelete && (
            <div className="mt-2 rounded-xl border border-rose-100 bg-rose-50/50 p-2 space-y-1">
              <div className="text-[11px] font-medium text-slate-500 px-2 pb-1">Delete Appointment</div>
              <button type="button" onClick={() => setConfirmDelete("single")}
                className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-slate-200 hover:bg-slate-50">
                <div className="font-medium text-slate-900">Only this appointment</div>
                <div className="text-slate-500 mt-0.5">Cancel this one only</div>
              </button>
              <button type="button" onClick={() => setConfirmDelete("future")}
                className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-rose-200 hover:bg-rose-50">
                <div className="font-medium text-rose-700">This and future appointments</div>
                <div className="text-slate-500 mt-0.5">{editing!.appointment.series_id ? "All remaining in this series" : "Same client & service"}</div>
              </button>
            </div>
          )}

          {/* Confirm delete step */}
          {confirmDelete && isEdit && (
            <div className="mt-2 rounded-xl border border-rose-300 bg-rose-50 p-3">
              <div className="text-xs font-medium text-rose-800">
                {confirmDelete === "single"
                  ? "Cancel this appointment? It will be marked as cancelled."
                  : "Cancel this and all future appointments? They will be marked as cancelled."}
              </div>
              <div className="mt-2">
                <NotifyChoicePanel
                  value={cancelNotifyChannel}
                  onChange={setCancelNotifyChannel}
                  hasEmail={hasEmail}
                  hasPhone={hasPhone}
                  label="Notify client about cancellation?"
                />
              </div>
              <div className="flex gap-2 mt-2">
                <CapabilityGatedButton
                  type="button"
                  allowed={canMutateOperationalData}
                  disabled={cancelling}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  onClick={() => executeDelete(confirmDelete)}
                  className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50">
                  {cancelling ? "Deleting..." : "Yes, Delete"}
                </CapabilityGatedButton>
                <button type="button" onClick={() => setConfirmDelete(null)}
                  className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs text-slate-700 hover:bg-white">
                  No, Go Back
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
