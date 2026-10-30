// Browser-local public demo: window.fetch interceptor.
//
// Patches window.fetch once. Any same-origin request whose path starts with
// /api/ is answered locally from the demo store (store.ts) by an explicit
// route table -- it NEVER reaches the real server. An /api/ path with no
// local handler fails closed with a synthetic 404 (and a console.error so a
// missing handler is obvious during development); it is never passed through
// to the network. Every non-/api/ request (static assets, fonts, etc.)
// passes through to the original fetch unchanged.
//
// Handlers reuse the real pure lib/* business logic (billing eligibility,
// billing validation, Needs Attention, recurrence generation, message
// classification) and only replace the database I/O with store reads/writes,
// returning the same JSON shapes the real routes return.
import type { Appointment, AppointmentEmployeeAssignment, Client } from "@/app/components/dashboard/types";
import {
  buildCompletedJobRows,
  buildReviewNeededRows,
  isCompletedForBilling,
  isValidPaymentMethod,
  normalizeInvoiceNumber,
  validateBillingState,
  type BillableAppointment,
  type CompletedJobBilling,
  type PaymentMethod,
} from "@/lib/completedJobBilling";
import { buildNeedsAttentionEntries, NEEDS_ATTENTION_LOOKBACK_DAYS } from "@/lib/needsAttention";
import {
  classifyMessageStatus,
  countUnresolvedFailedMessageGroupsByAppointment,
  describeMessageKind,
  type MessageAttemptRow,
} from "@/lib/messageStatus";
import { generateFutureDatesSafe } from "@/lib/recurrence";
import { nowInBusinessTz, zonedDateTimeToUTC, zonedDateValue, zonedTimeValue, effectiveTimezone, normalizeTimezone } from "@/lib/timezone";
import { toDateInputValue, isHistoricalAppointment } from "@/lib/payroll";
import { isValidPriceCents } from "@/lib/money";
import { validateTeamColorInput } from "@/lib/teamColor";
import { effectiveBusinessHours, normalizeBusinessHours } from "@/lib/businessHours";
// Type-only imports from lib/recurringSeries.ts (erased at compile time) --
// that module imports the Supabase admin client and must never load in a
// browser. See evaluateSeriesConsistencyLocal below.
import type { ConsistencyBlocker, ConsistencyResult, OccurrenceSnapshot, RecurringFrequency } from "@/lib/recurringSeries";
import { DateTime } from "luxon";
import {
  DEMO_LOCAL_WORKSPACE_ID,
  DEMO_TIMEZONE,
  type DemoEmployee,
  type DemoEmployeeHours,
  type DemoFixtureBundle,
  type DemoMessageSent,
} from "@/lib/demoLocal/fixtures/generate";
import { getSnapshot, notify, setSnapshot } from "@/lib/demoLocal/store";

type Handler = (req: Request, url: URL) => Promise<Response> | Response;
type Route = { method: string; path: string; handler: Handler };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function newId(): string {
  return crypto.randomUUID();
}

async function readJsonBody(req: Request): Promise<Record<string, any> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function groupAssignments(assignments: AppointmentEmployeeAssignment[]): Map<string, AppointmentEmployeeAssignment[]> {
  const map = new Map<string, AppointmentEmployeeAssignment[]>();
  for (const a of assignments) {
    const list = map.get(a.appointment_id);
    if (list) list.push(a);
    else map.set(a.appointment_id, [a]);
  }
  return map;
}

function toBillable(a: Appointment): BillableAppointment {
  return {
    id: a.id,
    client_id: a.client_id,
    service_type: a.service_type,
    scheduled_for: a.scheduled_for,
    scheduled_end: a.scheduled_end ?? null,
    duration_minutes: a.duration_minutes ?? null,
    status: a.status,
    price_cents: a.price_cents ?? null,
  };
}

// Plain local-calendar day math, same as the real routes' own private
// addOneDay/addDays helpers (app/api/billing/completed-jobs/route.ts,
// app/api/dashboard/needs-attention/route.ts).
function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return toDateInputValue(new Date(y, m - 1, d + 1));
}
function addLocalDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const byScheduledFor = (a: { scheduled_for: string; id: string }, b: { scheduled_for: string; id: string }) =>
  a.scheduled_for.localeCompare(b.scheduled_for) || a.id.localeCompare(b.id);

// ---------------------------------------------------------------------
// POST /api/appointments/create  (owner branch of the real route)
// ---------------------------------------------------------------------
// The real route's public-booking-only steps (booking_enabled, Business
// Hours, slot availability) and its notification sends never run for an
// owner/tester session, so they are correctly absent here. No message is
// sent or recorded.
async function handleCreateAppointment(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const tz = DEMO_TIMEZONE;

  const service_type = String(body.service_type || "").trim();
  const scheduled_for = String(body.scheduled_for || "").trim();
  const notes = String(body.notes || "").trim();
  const duration_minutes = typeof body.duration_minutes === "number" ? body.duration_minutes : 60;
  const scheduled_end = String(body.scheduled_end || "").trim() || null;
  const frequency_type = String(body.frequency_type || "one_time").trim();
  const repeat_weeks = typeof body.repeat_weeks === "number" ? body.repeat_weeks : 1;
  const repeat_months: number | null = typeof body.repeat_months === "number" ? body.repeat_months : null;
  if (frequency_type === "monthly") {
    if (!Number.isInteger(repeat_months) || (repeat_months as number) < 1 || (repeat_months as number) > 12) {
      return json({ error: "Repeat interval must be a whole number of months between 1 and 12." }, 400);
    }
  }
  // Same rule as lib/appointmentEmployees.ts's dedupeEmployeeIds (that
  // module imports the Supabase admin client, so it can't load in a browser).
  const employee_ids: string[] = Array.from(
    new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).filter((id: unknown) => typeof id === "string" && id.trim() !== ""))
  );

  let price_cents: number | null = null;
  if (body.price_cents !== undefined && body.price_cents !== null) {
    if (!isValidPriceCents(body.price_cents)) return json({ error: "Price must be a valid, non-negative amount." }, 400);
    price_cents = body.price_cents;
  }
  let team_color: string | null = null;
  if (body.team_color !== undefined) {
    const v = validateTeamColorInput(body.team_color);
    if (!v.ok) return json({ error: v.error }, 400);
    team_color = v.value;
  }
  if (!service_type || !scheduled_for) return json({ error: "Missing required fields" }, 400);

  let snap = getSnapshot();
  let clients = snap.clients;
  let clientId: string | null = String(body.client_id || "").trim() || null;
  if (clientId) {
    if (!clients.some((c) => c.id === clientId)) return json({ error: "Client not found" }, 404);
  } else {
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const phone = String(body.phone || "").trim();
    const address = String(body.address || "").trim();
    if (!name) return json({ error: "Client name is required" }, 400);
    if (!email && !phone) return json({ error: "Provide at least email or phone" }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);
    if (email) clientId = clients.find((c) => c.email === email)?.id ?? null;
    if (!clientId && phone) clientId = clients.find((c) => c.phone === phone)?.id ?? null;
    if (!clientId) {
      // Column defaults per migrations/005 (status 'active', auto_email false).
      const created: Client = {
        id: newId(),
        name,
        email: email || null,
        phone: phone || null,
        archived_at: null,
        address: address || null,
        client_since: null,
        referred_by: null,
        status: "active",
        notes: null,
        preferred_contact_method: null,
        auto_email: false,
        auto_sms: false,
      };
      clientId = created.id;
      clients = [...clients, created].sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  const knownEmployeeIds = new Set(snap.employees.map((e) => e.id));
  if (employee_ids.some((id) => !knownEmployeeIds.has(id))) {
    return json({ error: "One or more assigned employees were not found." }, 404);
  }

  const startDate = new Date(scheduled_for);
  if (isNaN(startDate.getTime())) return json({ error: "Invalid date/time." }, 400);
  const recurrence = generateFutureDatesSafe(startDate, frequency_type, repeat_weeks, tz, repeat_months ?? undefined);
  if (!recurrence.ok) return json({ error: recurrence.error }, 400);
  const dates = [startDate, ...recurrence.dates];
  const seriesId = dates.length > 1 ? newId() : null;
  const endOffsetMs = scheduled_end ? new Date(scheduled_end).getTime() - startDate.getTime() : 0;
  const nowIso = new Date().toISOString();

  const newAppointments: Appointment[] = dates.map((d) => ({
    id: newId(),
    client_id: clientId as string,
    service_type,
    scheduled_for: d.toISOString(),
    status: "scheduled",
    notes: notes || null,
    duration_minutes,
    scheduled_end: endOffsetMs ? new Date(d.getTime() + endOffsetMs).toISOString() : null,
    series_id: seriesId,
    frequency_type,
    repeat_weeks,
    repeat_months,
    employee_id: employee_ids.length === 1 ? employee_ids[0] : null,
    actual_started_at: null,
    actual_completed_at: null,
    price_cents,
    team_color,
    cancelled_at: null,
    cancellation_reported_date: null,
    cancellation_reason: null,
  }));
  const newAssignments: AppointmentEmployeeAssignment[] = newAppointments.flatMap((a) =>
    employee_ids.map((employee_id) => ({
      id: newId(),
      appointment_id: a.id,
      employee_id,
      actual_started_at: null,
      actual_completed_at: null,
      job_notes: null,
      created_at: nowIso,
      updated_at: nowIso,
    }))
  );

  snap = getSnapshot();
  setSnapshot({
    ...snap,
    clients,
    appointments: [...snap.appointments, ...newAppointments].sort(byScheduledFor),
    assignments: [...snap.assignments, ...newAssignments],
  });
  notify();

  return json({ ok: true, appointmentId: newAppointments[0].id, created: newAppointments.length });
}

// ---------------------------------------------------------------------
// PATCH /api/appointments/update  (owner branch of the real route)
// ---------------------------------------------------------------------
// The real route (app/api/appointments/update/route.ts) also: quarantines
// an ACTIVE recurring series into review_required before a "this & future"
// edit, atomically compare-and-swaps assignment changes against concurrent
// writers, and re-finalizes/reactivates the series afterward if the edited
// occurrence still agrees with its siblings. None of that concurrency
// machinery applies to a single-tab local store (there is no concurrent
// writer to race), so this handler keeps only what the real route's
// behavior actually LOOKS like from the UI: historical-record protection,
// the same field set, assignment sync, and ("future" mode) propagating
// field changes to future siblings in the series. It never touches a
// recurring_series registry row, never sends a real notification (no
// server exists here to send one from), and intentionally does not
// reproduce the real route's registry quarantine/reactivate state machine
// -- a documented simplification, not a silent gap.
async function handleUpdateAppointment(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const appointment_id = String(body.appointment_id || "").trim();
  if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
  const mode = String(body.mode || "single").trim();

  const snap = getSnapshot();
  const existing = snap.appointments.find((a) => a.id === appointment_id);
  if (!existing) return json({ error: "Appointment not found" }, 404);

  const existingAssignments = snap.assignments.filter((a) => a.appointment_id === appointment_id);
  if (isHistoricalAppointment(existing, existingAssignments)) {
    return json({ error: "This appointment is a past record and can no longer be changed.", code: "APPOINTMENT_IS_HISTORICAL" }, 409);
  }

  const apptUpdate: Partial<Appointment> = {};
  if (body.service_type !== undefined) apptUpdate.service_type = String(body.service_type).trim();
  if (body.scheduled_for !== undefined) apptUpdate.scheduled_for = String(body.scheduled_for).trim();
  if (body.scheduled_end !== undefined) apptUpdate.scheduled_end = body.scheduled_end ? String(body.scheduled_end).trim() : null;
  if (body.notes !== undefined) apptUpdate.notes = String(body.notes).trim() || null;
  if (body.status !== undefined) apptUpdate.status = String(body.status).trim() as Appointment["status"];
  if (typeof body.duration_minutes === "number") apptUpdate.duration_minutes = body.duration_minutes;
  if (body.price_cents !== undefined) {
    if (body.price_cents === null) {
      apptUpdate.price_cents = null;
    } else if (isValidPriceCents(body.price_cents)) {
      apptUpdate.price_cents = body.price_cents;
    } else {
      return json({ error: "Price must be a valid, non-negative amount." }, 400);
    }
  }
  if (body.team_color !== undefined) {
    const v = validateTeamColorInput(body.team_color);
    if (!v.ok) return json({ error: v.error }, 400);
    apptUpdate.team_color = v.value;
  }

  let employee_ids: string[] | undefined;
  if (body.employee_ids !== undefined) {
    employee_ids = Array.from(
      new Set((Array.isArray(body.employee_ids) ? body.employee_ids : []).filter((id: unknown) => typeof id === "string" && id.trim() !== ""))
    );
    const knownEmployeeIds = new Set(snap.employees.map((e) => e.id));
    if (employee_ids.some((id) => !knownEmployeeIds.has(id))) {
      return json({ error: "One or more assigned employees were not found." }, 404);
    }
    apptUpdate.employee_id = employee_ids.length === 1 ? employee_ids[0] : null;
  }

  const startDeltaMs = apptUpdate.scheduled_for ? new Date(apptUpdate.scheduled_for).getTime() - new Date(existing.scheduled_for).getTime() : 0;
  const oldEnd = existing.scheduled_end ? new Date(existing.scheduled_end).getTime() : null;
  const endDeltaMs = apptUpdate.scheduled_end && oldEnd ? new Date(apptUpdate.scheduled_end).getTime() - oldEnd : startDeltaMs;

  const nowIso = new Date().toISOString();
  let appointments = snap.appointments.map((a) => (a.id === appointment_id ? { ...a, ...apptUpdate } : a));
  let assignments = snap.assignments;
  if (employee_ids !== undefined) {
    assignments = assignments.filter((a) => a.appointment_id !== appointment_id);
    assignments = [
      ...assignments,
      ...employee_ids.map((employee_id) => ({
        id: newId(),
        appointment_id,
        employee_id,
        actual_started_at: null,
        actual_completed_at: null,
        job_notes: null,
        created_at: nowIso,
        updated_at: nowIso,
      })),
    ];
  }

  if (mode === "future" && existing.series_id) {
    appointments = appointments.map((a) => {
      if (a.id === appointment_id || a.series_id !== existing.series_id || a.status !== "scheduled" || a.scheduled_for <= existing.scheduled_for) {
        return a;
      }
      const sibUpdate: Partial<Appointment> = {};
      if (apptUpdate.service_type !== undefined) sibUpdate.service_type = apptUpdate.service_type;
      if (apptUpdate.notes !== undefined) sibUpdate.notes = apptUpdate.notes;
      if (apptUpdate.duration_minutes !== undefined) sibUpdate.duration_minutes = apptUpdate.duration_minutes;
      if (apptUpdate.employee_id !== undefined) sibUpdate.employee_id = apptUpdate.employee_id;
      if (apptUpdate.price_cents !== undefined) sibUpdate.price_cents = apptUpdate.price_cents;
      if (apptUpdate.team_color !== undefined) sibUpdate.team_color = apptUpdate.team_color;
      if (startDeltaMs) sibUpdate.scheduled_for = new Date(new Date(a.scheduled_for).getTime() + startDeltaMs).toISOString();
      if (endDeltaMs && a.scheduled_end) sibUpdate.scheduled_end = new Date(new Date(a.scheduled_end).getTime() + endDeltaMs).toISOString();
      return { ...a, ...sibUpdate };
    });
    if (employee_ids !== undefined) {
      const siblingIds = new Set(
        appointments.filter((a) => a.series_id === existing.series_id && a.id !== appointment_id && a.status === "scheduled" && a.scheduled_for > existing.scheduled_for).map((a) => a.id)
      );
      assignments = assignments.filter((a) => !siblingIds.has(a.appointment_id));
      assignments = [
        ...assignments,
        ...[...siblingIds].flatMap((sibId) =>
          employee_ids!.map((employee_id) => ({
            id: newId(), appointment_id: sibId, employee_id, actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: nowIso, updated_at: nowIso,
          }))
        ),
      ];
    }
  }

  setSnapshot({ ...snap, appointments: appointments.sort(byScheduledFor), assignments });
  notify();
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// GET /api/billing/completed-jobs?start=YYYY-MM-DD&end=YYYY-MM-DD
// ---------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function handleCompletedJobs(_req: Request, url: URL): Response {
  const rangeStart = url.searchParams.get("start") || "";
  const rangeEnd = url.searchParams.get("end") || "";
  if (!DATE_RE.test(rangeStart) || !DATE_RE.test(rangeEnd)) {
    return json({ error: "start and end must be dates in YYYY-MM-DD format" }, 400);
  }
  if (rangeStart > rangeEnd) return json({ error: "start must not be after end" }, 400);
  const timezone = DEMO_TIMEZONE;
  const lower = zonedDateTimeToUTC(rangeStart, "00:00", timezone);
  const upper = zonedDateTimeToUTC(addOneDay(rangeEnd), "00:00", timezone);
  if (!lower.ok || !upper.ok) return json({ error: "Invalid date range" }, 400);

  const snap = getSnapshot();
  const appointments = snap.appointments
    .filter((a) => a.scheduled_for >= lower.iso && a.scheduled_for < upper.iso)
    .sort(byScheduledFor)
    .map(toBillable);
  const ids = new Set(appointments.map((a) => a.id));
  const assignmentsByAppointmentId = groupAssignments(snap.assignments.filter((a) => ids.has(a.appointment_id)));
  const billingByAppointmentId = new Map(snap.completedJobBilling.filter((b) => ids.has(b.appointment_id)).map((b) => [b.appointment_id, b]));
  const employeeHours = snap.employeeHours.filter((h) => ids.has(h.appointment_id));

  const completed = buildCompletedJobRows({
    appointments, clients: snap.clients, assignmentsByAppointmentId, billingByAppointmentId, employeeHours, rangeStart, rangeEnd, timezone,
  });
  const reviewNeeded = buildReviewNeededRows({
    appointments, clients: snap.clients, assignmentsByAppointmentId, employeeHours, rangeStart, rangeEnd, timezone,
  });
  return json({ completed, reviewNeeded, timezone });
}

// ---------------------------------------------------------------------
// PATCH /api/billing/completed-jobs/update
// ---------------------------------------------------------------------
// Mirrors the real route's validation and merge rules, plus (in plain JS)
// what its upsert_completed_job_billing RPC (migrations/033) does in one
// transaction: reject an invoice number already used by a DIFFERENT client,
// upsert this row, and when invoice_number is non-null sync paid/
// payment_method onto every other row sharing (client_id, invoice_number).
async function handleBillingUpdate(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const appointment_id = String(body.appointment_id || "").trim();
  if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
  const hasField = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  if (hasField("invoice_number") && body.invoice_number !== null && typeof body.invoice_number !== "string") {
    return json({ error: "Invalid invoice number" }, 400);
  }
  if (hasField("paid") && typeof body.paid !== "boolean") return json({ error: "paid must be true or false" }, 400);
  if (hasField("payment_method") && body.payment_method !== null && !isValidPaymentMethod(body.payment_method)) {
    return json({ error: "Invalid payment method" }, 400);
  }

  const snap = getSnapshot();
  const appt = snap.appointments.find((a) => a.id === appointment_id);
  if (!appt) return json({ error: "Appointment not found" }, 404);
  const assignments = snap.assignments.filter((a) => a.appointment_id === appointment_id);
  const employeeHours = snap.employeeHours.filter((h) => h.appointment_id === appointment_id);
  if (!isCompletedForBilling(appointment_id, assignments, employeeHours)) {
    return json({ error: "This appointment is not marked completed yet." }, 409);
  }

  const existing = snap.completedJobBilling.find((b) => b.appointment_id === appointment_id) ?? null;
  const merged = {
    invoice_number: hasField("invoice_number") ? normalizeInvoiceNumber(body.invoice_number) : (existing?.invoice_number ?? null),
    paid: hasField("paid") ? (body.paid as boolean) : (existing?.paid ?? false),
    payment_method: (hasField("payment_method") ? (body.payment_method ?? null) : (existing?.payment_method ?? null)) as string | null,
  };

  // Inherit the invoice group's paid state when only the invoice number changes.
  const incomingInvoice = hasField("invoice_number") ? normalizeInvoiceNumber(body.invoice_number) : null;
  const invoiceNumberChanged = hasField("invoice_number") && incomingInvoice !== (existing?.invoice_number ?? null);
  if (invoiceNumberChanged && merged.invoice_number !== null && !hasField("paid") && !hasField("payment_method")) {
    const sibling = snap.completedJobBilling.find(
      (b) => b.client_id === appt.client_id && b.invoice_number === merged.invoice_number && b.appointment_id !== appointment_id
    );
    if (sibling) {
      merged.paid = sibling.paid;
      merged.payment_method = sibling.payment_method;
    }
  }

  const validation = validateBillingState(merged);
  if (!validation.ok) return json({ error: validation.error }, 400);

  if (merged.invoice_number !== null) {
    const conflict = snap.completedJobBilling.some(
      (b) => b.invoice_number === merged.invoice_number && b.appointment_id !== appointment_id && b.client_id !== appt.client_id
    );
    if (conflict) return json({ error: "That invoice number is already used by a different client in this workspace." }, 409);
  }

  const nowIso = new Date().toISOString();
  const row: CompletedJobBilling = {
    id: existing?.id ?? newId(),
    workspace_id: existing?.workspace_id ?? DEMO_LOCAL_WORKSPACE_ID,
    appointment_id,
    client_id: appt.client_id,
    invoice_number: merged.invoice_number,
    paid: merged.paid,
    payment_method: merged.payment_method as PaymentMethod | null,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };

  let found = false;
  const billing = snap.completedJobBilling.map((b) => {
    if (b.appointment_id === appointment_id) {
      found = true;
      return row;
    }
    if (row.invoice_number !== null && b.client_id === row.client_id && b.invoice_number === row.invoice_number) {
      return { ...b, paid: row.paid, payment_method: row.payment_method, updated_at: nowIso };
    }
    return b;
  });
  if (!found) billing.push(row);

  setSnapshot({ ...snap, completedJobBilling: billing });
  notify();
  return json({ ok: true, billing: row });
}

// ---------------------------------------------------------------------
// GET /api/dashboard/needs-attention
// ---------------------------------------------------------------------
// Deliberate deviation from the real route: includeInvoicing is ALWAYS
// true here. The real route turns it off for the tester role (which has no
// Billing destination); this local demo does have a working Settings ->
// Billing, so its billing issues are actionable.
const NA_DEFAULT_LIMIT = 25;
const NA_MAX_LIMIT = 100;

export function computeDemoNeedsAttention(snap: DemoFixtureBundle, limit = NA_MAX_LIMIT, offset = 0) {
  const timezone = DEMO_TIMEZONE;
  const todayLocal = nowInBusinessTz(timezone);
  todayLocal.setHours(0, 0, 0, 0);
  const rangeEnd = toDateInputValue(todayLocal);
  const messagesRangeStart = toDateInputValue(addLocalDays(todayLocal, -NEEDS_ATTENTION_LOOKBACK_DAYS));
  const messagesLowerBound = zonedDateTimeToUTC(messagesRangeStart, "00:00", timezone);
  const upperBoundExclusive = zonedDateTimeToUTC(toDateInputValue(addLocalDays(todayLocal, 1)), "00:00", timezone);
  if (!messagesLowerBound.ok || !upperBoundExclusive.ok) return null;

  const appointments = snap.appointments
    .filter((a) => a.scheduled_for < upperBoundExclusive.iso)
    .sort(byScheduledFor)
    .map(toBillable);
  const apptIds = new Set(appointments.map((a) => a.id));
  const recentApptIds = new Set(appointments.filter((a) => a.scheduled_for >= messagesLowerBound.iso).map((a) => a.id));

  const messageRows: MessageAttemptRow[] = snap.messagesSent
    .filter((m) => m.appointment_id !== null && recentApptIds.has(m.appointment_id))
    .map((m) => ({
      id: m.id,
      appointment_id: m.appointment_id as string,
      channel: m.channel,
      kind: m.kind,
      scheduled_for: m.scheduled_for,
      provider_id: m.provider_id,
      created_at: m.created_at,
    }));

  const allEntries = buildNeedsAttentionEntries({
    appointments,
    clients: snap.clients,
    assignmentsByAppointmentId: groupAssignments(snap.assignments.filter((a) => apptIds.has(a.appointment_id))),
    billingByAppointmentId: new Map(snap.completedJobBilling.filter((b) => apptIds.has(b.appointment_id)).map((b) => [b.appointment_id, b])),
    employeeHours: snap.employeeHours.filter((h) => apptIds.has(h.appointment_id)),
    failedMessageCountsByAppointmentId: countUnresolvedFailedMessageGroupsByAppointment(messageRows),
    rangeEnd,
    timezone,
    includeInvoicing: true,
  });
  const totalCount = allEntries.length;
  const entries = allEntries.slice(offset, offset + limit);
  const hasMore = offset + entries.length < totalCount;
  return { entries, totalCount, hasMore, rangeStart: messagesRangeStart, rangeEnd, timezone };
}

function handleNeedsAttention(_req: Request, url: URL): Response {
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), NA_MAX_LIMIT) : NA_DEFAULT_LIMIT;
  const offsetParam = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;
  const result = computeDemoNeedsAttention(getSnapshot(), limit, offset);
  if (!result) return json({ error: "Invalid date range" }, 500);
  return json(result);
}

// ---------------------------------------------------------------------
// Settings panels (StaffPanel, ServicesPanel, ArchivedClientsPanel,
// RecurringSeriesPanel, CompanyInfoPanel) -- reads and writes. Each write
// handler mirrors its real route's validation, error messages, status codes
// and response shape; only the database I/O is replaced by store writes.
// Real-route checks that cannot apply to a single local sandbox (session
// role, entitlement capability, workspace scoping, tester is_demo scoping)
// are absent by design.
// ---------------------------------------------------------------------

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

// GET /api/employees -- app/api/employees/route.ts returns the bare array,
// not wrapped in an envelope.
function handleListEmployees(): Response {
  return json(getSnapshot().employees);
}

// POST /api/employees -- app/api/employees/route.ts POST: 201 with the new
// row (id, name, phone, color, active, email, position).
//
// password: the real route bcrypt-hashes a non-empty password into
// password_hash so the employee can log in. There is no auth backend in this
// demo for any credential to ever be checked against, so the value is
// accepted (the real route never requires it either) and DISCARDED -- never
// hashed, never stored, never persisted to sessionStorage.
async function handleCreateEmployee(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const name = (body.name || "").trim();
  if (!name) return json({ error: "Name is required" }, 400);
  const email = (body.email || "").trim().toLowerCase();
  const position = (body.position || "").trim();
  const row: DemoEmployee = {
    id: newId(),
    name,
    phone: (body.phone || "").trim() || null,
    color: (body.color || "#3B82F6").trim(),
    active: body.active !== false,
    email: email || null,
    position: position || null,
  };
  const snap = getSnapshot();
  setSnapshot({ ...snap, employees: [...snap.employees, row].sort(byName) });
  notify();
  return json(row, 201);
}

// PATCH /api/employees -- app/api/employees/route.ts PATCH: { ok: true }.
// Same partial-update rules; password handled exactly as in POST above
// (accepted, discarded). A password-only PATCH therefore has no field to
// write -- the real route would update password_hash there; this returns
// { ok: true } too so the owner's flow matches, while storing nothing.
async function handleUpdateEmployee(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const id = (body.id || "").trim();
  if (!id) return json({ error: "Missing employee id" }, 400);
  const snap = getSnapshot();
  const existing = snap.employees.find((e) => e.id === id);
  if (!existing) return json({ error: "Employee not found" }, 404);

  const update: Partial<DemoEmployee> = {};
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.phone !== undefined) update.phone = body.phone.trim() || null;
  if (body.color !== undefined) update.color = body.color.trim();
  if (body.active !== undefined) update.active = body.active;
  if (body.email !== undefined) update.email = body.email.trim().toLowerCase() || null;
  if (body.position !== undefined) update.position = body.position.trim() || null;
  const passwordProvided = !!(body.password || "").trim();

  if (Object.keys(update).length === 0 && !passwordProvided) {
    return json({ error: "No fields to update" }, 400);
  }
  if (Object.keys(update).length > 0) {
    setSnapshot({ ...snap, employees: snap.employees.map((e) => (e.id === id ? { ...e, ...update } : e)).sort(byName) });
    notify();
  }
  return json({ ok: true });
}

// GET /api/services -- app/api/services/route.ts: { ok, services }.
function handleListServices(): Response {
  return json({ ok: true, services: getSnapshot().services });
}

// POST /api/services -- app/api/services/route.ts POST: { ok: true }.
async function handleCreateService(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const name = (body.name || "").trim();
  if (!name) return json({ error: "Service name is required" }, 400);
  let default_price_cents: number | null = null;
  if (body.default_price_cents !== undefined && body.default_price_cents !== null) {
    if (!isValidPriceCents(body.default_price_cents)) {
      return json({ error: "Price must be a valid, non-negative amount." }, 400);
    }
    default_price_cents = body.default_price_cents;
  }
  const snap = getSnapshot();
  const row = {
    id: newId(),
    name,
    description: (body.description || "").trim() || null,
    duration_minutes: typeof body.duration_minutes === "number" ? body.duration_minutes : 60,
    active: true,
    // services.color column default (migrations/007).
    color: body.color ? body.color.trim() : "#3B82F6",
    default_price_cents,
  };
  setSnapshot({ ...snap, services: [...snap.services, row].sort(byName) });
  notify();
  return json({ ok: true });
}

// PATCH /api/services -- app/api/services/route.ts PATCH: { ok: true }.
async function handleUpdateService(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const id = (body.id || "").trim();
  if (!id) return json({ error: "Missing service id" }, 400);
  const snap = getSnapshot();
  if (!snap.services.some((s) => s.id === id)) return json({ error: "Service not found" }, 404);

  const update: Record<string, any> = {};
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.description !== undefined) update.description = body.description.trim() || null;
  if (typeof body.duration_minutes === "number") update.duration_minutes = body.duration_minutes;
  if (typeof body.active === "boolean") update.active = body.active;
  if (body.color !== undefined) update.color = body.color.trim();
  if (body.default_price_cents !== undefined) {
    if (body.default_price_cents === null) {
      update.default_price_cents = null;
    } else if (isValidPriceCents(body.default_price_cents)) {
      update.default_price_cents = body.default_price_cents;
    } else {
      return json({ error: "Price must be a valid, non-negative amount." }, 400);
    }
  }
  setSnapshot({ ...snap, services: snap.services.map((s) => (s.id === id ? { ...s, ...update } : s)).sort(byName) });
  notify();
  return json({ ok: true });
}

// DELETE /api/services -- app/api/services/route.ts DELETE: { ok: true }.
// The real route hard-deletes ONLY is_demo rows (real services can only be
// toggled inactive). In this fully-local store every row is conceptually
// demo data, so any existing service may be removed; an unknown id is the
// same 404 the real route returns for a missing/non-demo row.
async function handleDeleteService(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const id = (body.id || "").trim();
  if (!id) return json({ error: "Missing service id" }, 400);
  const snap = getSnapshot();
  if (!snap.services.some((s) => s.id === id)) return json({ error: "Service not found" }, 404);
  setSnapshot({ ...snap, services: snap.services.filter((s) => s.id !== id) });
  notify();
  return json({ ok: true });
}

// GET /api/clients/archived -- app/api/clients/archived/route.ts: { ok, clients },
// filtered to archived_at != null.
function handleListArchivedClients(): Response {
  const clients = getSnapshot().clients.filter((c) => c.archived_at != null);
  return json({ ok: true, clients });
}

// PATCH /api/clients -- app/api/clients/route.ts PATCH: { ok: true }.
// Every optional column the real route probes with hasColumn() exists in
// this store, so each is always writable here.
const CLIENT_OPTIONAL_TEXT_FIELDS = ["address", "referred_by", "status", "notes", "preferred_contact_method"] as const;
const CLIENT_OPTIONAL_BOOL_FIELDS = ["auto_email", "auto_sms"] as const;

async function handleUpdateClient(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const id = (body.id || "").trim();
  if (!id) return json({ error: "Missing client id" }, 400);
  const snap = getSnapshot();
  if (!snap.clients.some((c) => c.id === id)) return json({ error: "Client not found" }, 404);

  const update: Record<string, any> = {};
  if (body.name !== undefined) update.name = body.name.trim();
  if (body.email !== undefined) update.email = body.email.trim() || null;
  if (body.phone !== undefined) update.phone = body.phone.trim() || null;
  if (body.client_since !== undefined) update.client_since = body.client_since || null;
  for (const f of CLIENT_OPTIONAL_TEXT_FIELDS) {
    if (body[f] !== undefined) update[f] = typeof body[f] === "string" ? (body[f].trim() || null) : body[f];
  }
  for (const f of CLIENT_OPTIONAL_BOOL_FIELDS) {
    if (body[f] !== undefined) update[f] = !!body[f];
  }
  if (Object.keys(update).length === 0) return json({ error: "Nothing to update" }, 400);

  setSnapshot({ ...snap, clients: snap.clients.map((c) => (c.id === id ? { ...c, ...update } : c)).sort(byName) });
  notify();
  return json({ ok: true });
}

// POST /api/clients { id, action: "archive" | "restore" } -- app/api/clients/
// route.ts POST: { ok: true }. Both actions first move every ACTIVE
// recurring_series row for this client to stopped (the real route's
// quarantineActiveSeriesForClient + finalizeStoppedSeriesByIds pair -- a
// single synchronous step here, so the real route's partial-failure warning
// can never arise). A review_required or already-stopped series is never
// touched, exactly as in the real route.
async function handleClientAction(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const action = (body.action || "").trim();
  const id = (body.id || "").trim();
  if (!id) return json({ error: "Missing client id" }, 400);
  const snap = getSnapshot();
  if (!snap.clients.some((c) => c.id === id)) return json({ error: "Client not found" }, 404);
  if (action !== "archive" && action !== "restore") return json({ error: "Invalid action" }, 400);

  const nowIso = new Date().toISOString();
  const recurringSeries = snap.recurringSeries.map((r) =>
    r.client_id === id && r.status === "active" ? { ...r, status: "stopped" as const, stopped_at: nowIso, updated_at: nowIso } : r
  );
  const update = action === "archive" ? { archived_at: nowIso, status: "inactive" } : { archived_at: null, status: "active" };
  setSnapshot({ ...snap, recurringSeries, clients: snap.clients.map((c) => (c.id === id ? { ...c, ...update } : c)) });
  notify();
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// POST /api/appointments/employee-hours  (owner worked-time correction)
// ---------------------------------------------------------------------
// Mirrors the route's own validation, then -- in plain JS -- the
// save_employee_hours RPC (migrations/030, relaxed by 031): unknown
// appointment or unassigned employee -> not_assigned (404); a brand-new row
// on an appointment whose status is no longer 'scheduled' ->
// appointment_not_active (409); an EXISTING row may still be corrected
// regardless of status; otherwise upsert on (appointment_id, employee_id).
async function handleSaveEmployeeHours(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const appointment_id = (body.appointment_id || "").trim();
  const employee_id = (body.employee_id || "").trim();
  const hours_worked = Number(body.hours_worked);
  const note = (body.note || "").trim();

  if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
  if (!employee_id) return json({ error: "Missing employee_id" }, 400);
  if (!Number.isFinite(hours_worked) || hours_worked <= 0) {
    return json({ error: "Hours worked must be a positive number" }, 400);
  }
  if (!note) return json({ error: "A reason is required (e.g. forgot to clock in/out)." }, 400);
  // RPC's own invalid_input bound (p_hours_worked >= 1000).
  if (hours_worked >= 1000) return json({ error: "Hours worked must be a positive number" }, 400);

  const snap = getSnapshot();
  const appt = snap.appointments.find((a) => a.id === appointment_id);
  const assigned = !!appt && snap.assignments.some((a) => a.appointment_id === appointment_id && a.employee_id === employee_id);
  if (!appt || !assigned) return json({ error: "Employee is not assigned to this appointment." }, 404);

  const existing = snap.employeeHours.find((h) => h.appointment_id === appointment_id && h.employee_id === employee_id);
  if (!existing && appt.status !== "scheduled") {
    return json({ error: "This appointment was cancelled or replaced and hours can no longer be added to it.", code: "APPOINTMENT_NOT_ACTIVE" }, 409);
  }

  const nowIso = new Date().toISOString();
  const row: DemoEmployeeHours = existing
    ? { ...existing, hours_worked, note, updated_at: nowIso }
    : { id: newId(), appointment_id, employee_id, hours_worked, note, workspace_id: DEMO_LOCAL_WORKSPACE_ID, created_at: nowIso, updated_at: nowIso };
  const employeeHours = existing ? snap.employeeHours.map((h) => (h.id === existing.id ? row : h)) : [...snap.employeeHours, row];
  setSnapshot({ ...snap, employeeHours });
  notify();

  // The RPC's returned entry has no workspace_id.
  const entry = {
    id: row.id,
    appointment_id: row.appointment_id,
    employee_id: row.employee_id,
    hours_worked: row.hours_worked,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return json({ ok: true, entry });
}

// ---------------------------------------------------------------------
// Recurring series review queue + owner activation
// ---------------------------------------------------------------------

// Verbatim copy of lib/recurringSeries.ts's evaluateSeriesConsistency (and
// its private minutesOfDay helper). That function is pure, but its module
// imports the Supabase admin client at top level, so it cannot load in a
// browser -- same precedent as the lib/appointmentEmployees.ts rule copied
// into handleCreateAppointment above. fetchInterceptor.test.ts runs this
// copy against the REAL function on the same inputs to catch any drift.
function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function evaluateSeriesConsistencyLocal(
  occurrences: OccurrenceSnapshot[],
  templateAppointmentId: string,
  frequencyType: RecurringFrequency,
  timezone: string,
  repeatMonths: number | null
): ConsistencyResult {
  if (occurrences.length === 0) return { ok: false, blockers: ["no_live_occurrences"] };

  const template = occurrences.find((o) => o.id === templateAppointmentId);
  if (!template) return { ok: false, blockers: ["template_not_in_series"] };

  const blockers = new Set<ConsistencyBlocker>();

  if (new Set(occurrences.map((o) => o.serviceType)).size > 1) blockers.add("service_type_mismatch");
  if (new Set(occurrences.map((o) => o.priceCents ?? -1)).size > 1) blockers.add("price_mismatch");
  if (new Set(occurrences.map((o) => o.durationMinutes ?? -1)).size > 1) blockers.add("duration_mismatch");
  if (new Set(occurrences.map((o) => o.teamColor ?? "none")).size > 1) blockers.add("team_color_mismatch");

  const employeeSignature = (ids: string[]) => [...ids].sort().join(",");
  if (new Set(occurrences.map((o) => employeeSignature(o.employeeIds))).size > 1) blockers.add("employee_set_mismatch");

  const localized = occurrences.map((o) => {
    const dt = DateTime.fromISO(o.scheduledFor).setZone(timezone);
    return {
      hhmm: dt.toFormat("HH:mm"),
      isoWeekday: dt.weekday,
      offsetMinutes: dt.offset,
      utcHHmm: DateTime.fromISO(o.scheduledFor, { zone: "utc" }).toFormat("HH:mm"),
      day: dt.day,
      daysInMonth: dt.daysInMonth,
      year: dt.year,
      month: dt.month,
    };
  });

  const distinctLocalTimes = Array.from(new Set(localized.map((l) => l.hhmm))).sort();
  const distinctUtcTimes = new Set(localized.map((l) => l.utcHHmm));
  const distinctOffsets = new Set(localized.map((l) => l.offsetMinutes));

  let timePattern: "consistent" | "legacy_dst_signature" = "consistent";

  if (distinctLocalTimes.length > 1) {
    const isLegacyDstSignature =
      distinctUtcTimes.size === 1 &&
      distinctOffsets.size > 1 &&
      distinctLocalTimes.length === 2 &&
      Math.abs(minutesOfDay(distinctLocalTimes[0]) - minutesOfDay(distinctLocalTimes[1])) === 60;

    if (isLegacyDstSignature) {
      timePattern = "legacy_dst_signature";
    } else {
      blockers.add("time_pattern_unexplained");
    }
  }

  if (frequencyType === "weekdays") {
    if (localized.some((l) => l.isoWeekday === 6 || l.isoWeekday === 7)) {
      blockers.add("weekend_occurrence_in_weekdays_series");
    }
  } else if (frequencyType === "weekly") {
    if (new Set(localized.map((l) => l.isoWeekday)).size > 1) {
      blockers.add("weekly_weekday_pattern_inconsistent");
    }
  } else if (frequencyType === "monthly") {
    if (repeatMonths == null) {
      blockers.add("monthly_progression_invalid");
    } else {
      const templateLocal = DateTime.fromISO(template.scheduledFor).setZone(timezone);
      const anchorDay = templateLocal.day!;
      const anchorYearMonth = templateLocal.year * 12 + (templateLocal.month - 1);
      for (const o of occurrences) {
        const dt = DateTime.fromISO(o.scheduledFor).setZone(timezone);
        const expectedDay = Math.min(anchorDay, dt.daysInMonth!);
        const occYearMonth = dt.year * 12 + (dt.month - 1);
        const monthDistance = occYearMonth - anchorYearMonth;
        if (dt.day !== expectedDay || monthDistance % repeatMonths !== 0) {
          blockers.add("monthly_progression_invalid");
          break;
        }
      }
    }
  }

  if (blockers.size > 0) return { ok: false, blockers: Array.from(blockers) };
  return { ok: true, timePattern };
}

// Store equivalent of lib/recurringSeries.ts's fetchLiveOccurrenceSnapshots:
// every scheduled, strictly-future occurrence of the series, with its
// assignment set.
function liveOccurrenceSnapshots(snap: DemoFixtureBundle, seriesId: string): OccurrenceSnapshot[] {
  const nowIso = new Date().toISOString();
  return snap.appointments
    .filter((a) => a.series_id === seriesId && a.status === "scheduled" && a.scheduled_for > nowIso)
    .map((a) => ({
      id: a.id,
      scheduledFor: a.scheduled_for,
      serviceType: a.service_type,
      priceCents: a.price_cents ?? null,
      durationMinutes: a.duration_minutes ?? null,
      teamColor: a.team_color ?? null,
      employeeIds: snap.assignments.filter((x) => x.appointment_id === a.id).map((x) => x.employee_id),
    }));
}

// GET /api/recurring-series -- app/api/recurring-series/route.ts: { series },
// every review_required registry row joined to its client and its live
// (scheduled, future) occurrences, with the same derived fields and sort.
function handleListRecurringSeries(): Response {
  const snap = getSnapshot();
  const rows = snap.recurringSeries.filter((r) => r.status === "review_required");
  if (rows.length === 0) return json({ series: [] });

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const series = rows.map((r) => {
    const client = snap.clients.find((c) => c.id === r.client_id);
    const occurrences = snap.appointments
      .filter((a) => a.series_id === r.id && a.status === "scheduled" && a.scheduled_for > nowIso)
      .sort(byScheduledFor);
    const latest = occurrences.length > 0 ? occurrences[occurrences.length - 1] : null;
    return {
      id: r.id,
      frequencyType: r.frequency_type,
      repeatWeeks: r.repeat_weeks,
      repeatMonths: r.repeat_months,
      anchorLocalDate: r.anchor_local_date,
      anchorLocalTime: r.anchor_local_time,
      anchorTimezone: r.anchor_timezone,
      isDemo: r.is_demo,
      createdAt: r.created_at,
      clientId: r.client_id,
      clientName: client?.name ?? null,
      clientInactiveOrArchived: client ? client.status === "inactive" || !!client.archived_at : false,
      candidates: occurrences.map((o) => ({
        id: o.id,
        scheduledFor: o.scheduled_for,
        serviceType: o.service_type,
        priceCents: o.price_cents ?? null,
        durationMinutes: o.duration_minutes ?? null,
      })),
      hasLiveOccurrences: occurrences.length > 0,
      expiresWithin30Days: latest ? new Date(latest.scheduled_for).getTime() - now <= THIRTY_DAYS_MS : false,
    };
  });
  series.sort((a, b) => {
    if (a.hasLiveOccurrences !== b.hasLiveOccurrences) return a.hasLiveOccurrences ? -1 : 1;
    if (!a.hasLiveOccurrences) return 0;
    const aLatest = a.candidates[a.candidates.length - 1]?.scheduledFor ?? "";
    const bLatest = b.candidates[b.candidates.length - 1]?.scheduledFor ?? "";
    return aLatest.localeCompare(bLatest);
  });
  return json({ series });
}

// POST /api/recurring-series/activate -- app/api/recurring-series/activate/
// route.ts: { ok: true, timePattern } or { error, blockers? }. Same gates in
// the same order, including the real route's "Demo series cannot be
// activated." refusal for an is_demo row. On success, applies what the
// activate_recurring_series RPC (migrations/027a) writes to the row's own
// columns: status 'active', reviewed_at, template_appointment_id, and the
// anchor re-derived from the template in the workspace timezone. (The RPC's
// snapshot_* columns are not part of the registry row shape this store
// keeps; its concurrency outcomes -- conflict / state_changed -- cannot
// occur in a single-tab synchronous store.)
async function handleActivateRecurringSeries(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const seriesId = (body.series_id || "").trim();
  const templateAppointmentId = (body.template_appointment_id || "").trim();
  if (!seriesId || !templateAppointmentId) {
    return json({ error: "Missing series_id or template_appointment_id" }, 400);
  }

  const snap = getSnapshot();
  const series = snap.recurringSeries.find((r) => r.id === seriesId);
  if (!series) return json({ error: "Series not found" }, 404);
  if (series.status !== "review_required") {
    return json({ error: "Only a series awaiting review can be activated." }, 409);
  }
  if (series.is_demo) {
    return json({ error: "Demo series cannot be activated." }, 400);
  }

  const client = snap.clients.find((c) => c.id === series.client_id);
  if (!client) return json({ error: "Client not found" }, 404);
  if (client.status === "inactive" || client.archived_at) {
    return json({ error: "This series' client is inactive or archived and cannot be activated." }, 409);
  }

  const occurrenceSnapshots = liveOccurrenceSnapshots(snap, seriesId);
  if (occurrenceSnapshots.length === 0) {
    return json({ error: "This series has no scheduled future occurrences to activate from.", blockers: ["no_live_occurrences"] }, 409);
  }

  const nowIso = new Date().toISOString();
  const templateRow = snap.appointments.find(
    (a) =>
      a.id === templateAppointmentId &&
      a.series_id === seriesId &&
      a.client_id === series.client_id &&
      a.status === "scheduled" &&
      a.scheduled_for > nowIso
  );
  if (!templateRow) {
    return json(
      { error: "The chosen appointment is not a current, scheduled occurrence of this series.", blockers: ["template_not_in_series"] },
      400
    );
  }

  const timezone = effectiveTimezone(snap.companySettings.timezone);
  const consistency = evaluateSeriesConsistencyLocal(occurrenceSnapshots, templateAppointmentId, series.frequency_type, timezone, series.repeat_months);
  if (!consistency.ok) {
    return json(
      {
        error: "This series can't be activated yet -- its scheduled occurrences don't all agree. Review or reconcile the differing occurrence(s), then try again.",
        blockers: consistency.blockers,
      },
      409
    );
  }

  // The RPC's employee_not_eligible re-check: every employee assigned to the
  // template must still exist and be active.
  const templateEmployeeIds = occurrenceSnapshots.find((o) => o.id === templateAppointmentId)!.employeeIds;
  const eligible = templateEmployeeIds.every((eid) => snap.employees.some((e) => e.id === eid && e.active));
  if (!eligible) {
    return json(
      { error: "One or more assigned employees are no longer active or no longer belong to this workspace. Update the assignment and try again." },
      409
    );
  }

  const activated = {
    ...series,
    status: "active" as const,
    reviewed_at: nowIso,
    template_appointment_id: templateAppointmentId,
    anchor_local_date: zonedDateValue(templateRow.scheduled_for, timezone),
    anchor_local_time: zonedTimeValue(templateRow.scheduled_for, timezone),
    anchor_timezone: timezone,
    updated_at: nowIso,
  };
  setSnapshot({ ...snap, recurringSeries: snap.recurringSeries.map((r) => (r.id === seriesId ? activated : r)) });
  notify();
  return json({ ok: true, timePattern: consistency.timePattern });
}

// ---------------------------------------------------------------------
// Message History (appointment- and client-scoped)
// ---------------------------------------------------------------------
// Same response row shape, order (created_at desc, id desc), and
// limit/offset/hasMore paging as app/api/{appointments,clients}/messages/
// route.ts, using the REAL classifyMessageStatus and describeMessageKind.
// Every demo row is simulated (nothing was ever sent), so the mapping --
// and only the mapping -- marks it: the subject (or, for an SMS with no
// subject, the kind label) gets a "[Simulated] " prefix. MessageHistory.tsx
// and lib/messageStatus.ts stay unmodified.
const MSG_DEFAULT_LIMIT = 20;
const MSG_MAX_LIMIT = 50;
const SIMULATED_PREFIX = "[Simulated] ";

function pageParams(url: URL): { limit: number; offset: number } {
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MSG_MAX_LIMIT) : MSG_DEFAULT_LIMIT;
  const offsetParam = Number(url.searchParams.get("offset"));
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;
  return { limit, offset };
}

function mapMessage(m: DemoMessageSent) {
  const kindLabel = describeMessageKind(m.kind);
  const subject = m.subject ?? null;
  return {
    id: m.id,
    channel: m.channel,
    kindLabel: m.simulated && !subject ? SIMULATED_PREFIX + kindLabel : kindLabel,
    toValue: m.to_value,
    body: m.body,
    subject: m.simulated && subject ? SIMULATED_PREFIX + subject : subject,
    status: classifyMessageStatus(m.provider_id, m.channel),
    createdAt: m.created_at,
    scheduledFor: m.scheduled_for ?? null,
  };
}

function pageMessages(rows: DemoMessageSent[], url: URL) {
  const { limit, offset } = pageParams(url);
  const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const slice = sorted.slice(offset, offset + limit + 1);
  const hasMore = slice.length > limit;
  return { page: hasMore ? slice.slice(0, limit) : slice, hasMore };
}

function handleAppointmentMessages(_req: Request, url: URL): Response {
  const appointmentId = (url.searchParams.get("appointment_id") || "").trim();
  if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
  const snap = getSnapshot();
  if (!snap.appointments.some((a) => a.id === appointmentId)) return json({ error: "Appointment not found" }, 404);
  const { page, hasMore } = pageMessages(snap.messagesSent.filter((m) => m.appointment_id === appointmentId), url);
  return json({ ok: true, messages: page.map(mapMessage), hasMore });
}

function handleClientMessages(_req: Request, url: URL): Response {
  const clientId = (url.searchParams.get("client_id") || "").trim();
  if (!clientId) return json({ error: "Missing client_id" }, 400);
  const snap = getSnapshot();
  if (!snap.clients.some((c) => c.id === clientId)) return json({ error: "Client not found" }, 404);
  const appointmentIds = new Set(snap.appointments.filter((a) => a.client_id === clientId).map((a) => a.id));
  if (appointmentIds.size === 0) return json({ ok: true, messages: [], hasMore: false });
  const { page, hasMore } = pageMessages(snap.messagesSent.filter((m) => m.appointment_id !== null && appointmentIds.has(m.appointment_id)), url);
  return json({ ok: true, messages: page.map((m) => ({ appointmentId: m.appointment_id, ...mapMessage(m) })), hasMore });
}

// GET /api/settings/company -- app/api/settings/company/route.ts: { ok, settings, status }.
function handleGetCompanySettings(): Response {
  const snap = getSnapshot();
  const cs = snap.companySettings;
  const settings = {
    ...cs,
    business_hours: effectiveBusinessHours(cs.business_hours),
    timezone: effectiveTimezone(cs.timezone),
  };
  const activeStaff = snap.employees.filter((e) => e.active).length;
  const status = {
    // Deliberately hardcoded false, NEVER derived from process.env: the real
    // route reads this deployment's actual Resend/Twilio configuration
    // (!!process.env.RESEND_API_KEY etc.) -- echoing that here would leak
    // this production deployment's real integration status to every
    // anonymous demo visitor. No real integration is ever "connected" in
    // the demo, full stop.
    emailConfigured: false,
    smsConfigured: false,
    activeStaff,
    totalStaff: snap.employees.length,
  };
  return json({ ok: true, settings, status });
}

// POST /api/settings/company -- app/api/settings/company/route.ts POST:
// { ok: true }. Partial update, same field rules: the 7 profile text fields
// (blank -> null), booking_enabled / notifications_enabled (booleans only),
// business_hours and timezone each validated by the real normalize helpers.
// CompanyInfoPanel sends four distinct shapes (profile form, timezone,
// business hours, the two automation toggles); all go through this one path.
// The automation toggles only flip these local fields -- the demo has no
// public booking page and sends no notifications, whatever they are set to.
const COMPANY_TEXT_FIELDS = ["company_name", "phone", "email", "address", "city", "state", "zip"] as const;

async function handleSaveCompanySettings(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body) return json({ error: "Invalid request body" }, 400);
  const fields: Record<string, unknown> = {};
  for (const f of COMPANY_TEXT_FIELDS) {
    if (body[f] !== undefined) fields[f] = (body[f] || "").trim() || null;
  }
  if (typeof body.booking_enabled === "boolean") fields.booking_enabled = body.booking_enabled;
  if (typeof body.notifications_enabled === "boolean") fields.notifications_enabled = body.notifications_enabled;
  if (body.business_hours !== undefined) {
    const validation = normalizeBusinessHours(body.business_hours);
    if (!validation.ok) return json({ error: validation.error }, 400);
    fields.business_hours = validation.value;
  }
  if (body.timezone !== undefined) {
    const validation = normalizeTimezone(body.timezone);
    if (!validation.ok) return json({ error: validation.error }, 400);
    fields.timezone = validation.value;
  }
  const snap = getSnapshot();
  setSnapshot({ ...snap, companySettings: { ...snap.companySettings, ...fields } });
  notify();
  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------
// Exact pathname + method match (query strings are ignored for matching and
// passed to the handler via `url`). Exact rather than prefix matching so
// /api/billing/completed-jobs can never accidentally swallow
// /api/billing/completed-jobs/update or any future sibling path.
const ROUTES: Route[] = [
  { method: "POST", path: "/api/appointments/create", handler: handleCreateAppointment },
  { method: "PATCH", path: "/api/appointments/update", handler: handleUpdateAppointment },
  { method: "GET", path: "/api/billing/completed-jobs", handler: handleCompletedJobs },
  { method: "PATCH", path: "/api/billing/completed-jobs/update", handler: handleBillingUpdate },
  { method: "GET", path: "/api/dashboard/needs-attention", handler: handleNeedsAttention },
  { method: "POST", path: "/api/auth/logout", handler: () => json({ ok: true }) },
  { method: "POST", path: "/api/appointments/employee-hours", handler: handleSaveEmployeeHours },
  { method: "GET", path: "/api/appointments/messages", handler: handleAppointmentMessages },
  { method: "GET", path: "/api/clients/messages", handler: handleClientMessages },
  { method: "GET", path: "/api/employees", handler: handleListEmployees },
  { method: "POST", path: "/api/employees", handler: handleCreateEmployee },
  { method: "PATCH", path: "/api/employees", handler: handleUpdateEmployee },
  { method: "GET", path: "/api/services", handler: handleListServices },
  { method: "POST", path: "/api/services", handler: handleCreateService },
  { method: "PATCH", path: "/api/services", handler: handleUpdateService },
  { method: "DELETE", path: "/api/services", handler: handleDeleteService },
  { method: "PATCH", path: "/api/clients", handler: handleUpdateClient },
  { method: "POST", path: "/api/clients", handler: handleClientAction },
  { method: "GET", path: "/api/clients/archived", handler: handleListArchivedClients },
  { method: "GET", path: "/api/recurring-series", handler: handleListRecurringSeries },
  { method: "POST", path: "/api/recurring-series/activate", handler: handleActivateRecurringSeries },
  { method: "GET", path: "/api/settings/company", handler: handleGetCompanySettings },
  { method: "POST", path: "/api/settings/company", handler: handleSaveCompanySettings },
  // Deliberately absent: /api/book/* (the demo has no public booking page,
  // whatever booking_enabled is set to).
];

function findRoute(method: string, pathname: string): Route | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES.find((r) => r.method === method && r.path === path);
}

// ---------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------

type DemoWindow = {
  fetch: typeof fetch;
  location?: { origin?: string; pathname?: string };
  __demoFetchInstalled?: boolean;
};

// True only on /demo itself or a path beneath it (not e.g. "/demonstration").
function isDemoPath(pathname: string | undefined): boolean {
  return typeof pathname === "string" && (pathname === "/demo" || pathname.startsWith("/demo/"));
}

// Lifecycle: Next.js navigates client-side by default, so a visitor can leave
// /demo for another route WITHOUT a page reload -- the patched fetch would
// then still be live and would answer (or 404) real /api/ calls on that page,
// e.g. a real login. The patched fetch therefore checks the CURRENT path on
// every call (one string check); the first call made off /demo restores the
// original window.fetch, clears the install flag (so returning to /demo in
// the same tab, e.g. via the Back button, reinstalls for real), and hands
// that call -- and, the real fetch now being back, every later one -- to the
// original fetch.
export function installDemoFetchInterceptor(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as DemoWindow;
  if (w.__demoFetchInstalled) return;
  w.__demoFetchInstalled = true;

  const rawFetch: typeof fetch = w.fetch;
  const originalFetch: typeof fetch = rawFetch.bind(window);
  const origin = w.location?.origin || "http://localhost";

  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isDemoPath(w.location?.pathname)) {
      // Only unpatch if nothing has wrapped fetch on top of us since --
      // never clobber someone else's wrapper. Either way this call (and
      // every later one through us) goes to the real fetch.
      if (w.fetch === patchedFetch) w.fetch = rawFetch;
      w.__demoFetchInstalled = false;
      return originalFetch(input, init);
    }
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url: URL;
    try {
      url = new URL(rawUrl, origin);
    } catch {
      return originalFetch(input, init);
    }
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) {
      return originalFetch(input, init);
    }

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const route = findRoute(method, url.pathname);
    if (!route) {
      console.error("DEMO_FETCH_UNHANDLED", url.href);
      return json({ error: "Not available in this demo." }, 404);
    }
    try {
      const req = new Request(input instanceof Request ? new Request(url.href, input) : url.href, init);
      return await route.handler(req, url);
    } catch (e: any) {
      console.error("DEMO_FETCH_HANDLER_ERROR", url.pathname, e);
      return json({ error: e?.message || "Server error" }, 500);
    }
  };
  w.fetch = patchedFetch;
}
