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
import { countUnresolvedFailedMessageGroupsByAppointment, type MessageAttemptRow } from "@/lib/messageStatus";
import { generateFutureDatesSafe } from "@/lib/recurrence";
import { nowInBusinessTz, zonedDateTimeToUTC, effectiveTimezone } from "@/lib/timezone";
import { toDateInputValue } from "@/lib/payroll";
import { isValidPriceCents } from "@/lib/money";
import { validateTeamColorInput } from "@/lib/teamColor";
import { effectiveBusinessHours } from "@/lib/businessHours";
import { DEMO_LOCAL_WORKSPACE_ID, DEMO_TIMEZONE, type DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";
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
// GET-only handlers for the real Settings panels (StaffPanel, ServicesPanel,
// ArchivedClientsPanel, RecurringSeriesPanel, CompanyInfoPanel) -- added so
// the demo's Settings (now the real SettingsTabBar/SettingsPanel, see
// DashboardSettingsArea.tsx's isLocalDemo branch) shows real fictional data
// to VIEW instead of a 404 error. Every MUTATING method on these same paths
// (create/update/delete/archive/restore/activate/save) is deliberately left
// unhandled this round -- it already falls through to the generic 404 below,
// which every one of these panels' own error handling renders as "Not
// available in this demo." inline, never a crash. Wiring those writes is
// explicit Stage-2 scope, reviewed separately from this layout-parity round.
// ---------------------------------------------------------------------

// GET /api/employees -- app/api/employees/route.ts returns the bare array,
// not wrapped in an envelope.
function handleListEmployees(): Response {
  return json(getSnapshot().employees);
}

// GET /api/services -- app/api/services/route.ts: { ok, services }.
function handleListServices(): Response {
  return json({ ok: true, services: getSnapshot().services });
}

// GET /api/clients/archived -- app/api/clients/archived/route.ts: { ok, clients },
// filtered to archived_at != null.
function handleListArchivedClients(): Response {
  const clients = getSnapshot().clients.filter((c) => c.archived_at != null);
  return json({ ok: true, clients });
}

// GET /api/recurring-series -- app/api/recurring-series/route.ts: { series }.
// Deliberately always empty: the fixture has no recurring_series-table-shaped
// registry rows (its "series" concept only lives as series_id/frequency_type
// on already-active appointments). This renders RecurringSeriesPanel's own
// genuine empty state -- the same screen a fully-migrated real workspace
// shows -- which IS layout parity, not an error state. Populating a demo
// review_required row plus its /activate write is explicit Stage 2 scope.
function handleListRecurringSeries(): Response {
  return json({ series: [] });
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

// ---------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------
// Exact pathname + method match (query strings are ignored for matching and
// passed to the handler via `url`). Exact rather than prefix matching so
// /api/billing/completed-jobs can never accidentally swallow
// /api/billing/completed-jobs/update or any future sibling path.
const ROUTES: Route[] = [
  { method: "POST", path: "/api/appointments/create", handler: handleCreateAppointment },
  { method: "GET", path: "/api/billing/completed-jobs", handler: handleCompletedJobs },
  { method: "PATCH", path: "/api/billing/completed-jobs/update", handler: handleBillingUpdate },
  { method: "GET", path: "/api/dashboard/needs-attention", handler: handleNeedsAttention },
  { method: "POST", path: "/api/auth/logout", handler: () => json({ ok: true }) },
  // Real empty-state shape (app/api/{appointments,clients}/messages/route.ts).
  // Simulated demo messages are not exposed through Message History in Stage 1.
  { method: "GET", path: "/api/appointments/messages", handler: () => json({ ok: true, messages: [], hasMore: false }) },
  { method: "GET", path: "/api/clients/messages", handler: () => json({ ok: true, messages: [], hasMore: false }) },
  { method: "GET", path: "/api/employees", handler: handleListEmployees },
  { method: "GET", path: "/api/services", handler: handleListServices },
  { method: "GET", path: "/api/clients/archived", handler: handleListArchivedClients },
  { method: "GET", path: "/api/recurring-series", handler: handleListRecurringSeries },
  { method: "GET", path: "/api/settings/company", handler: handleGetCompanySettings },
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
  location?: { origin?: string };
  __demoFetchInstalled?: boolean;
};

export function installDemoFetchInterceptor(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as DemoWindow;
  if (w.__demoFetchInstalled) return;
  w.__demoFetchInstalled = true;

  const originalFetch: typeof fetch = w.fetch.bind(window);
  const origin = w.location?.origin || "http://localhost";

  w.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
}
