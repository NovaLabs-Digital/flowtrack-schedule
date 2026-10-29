// Browser-local public demo: relative-date fixture generator.
//
// Every date below is an OFFSET from the `now` passed in -- never an
// absolute literal -- so the demo always looks current no matter when it is
// opened. Date math goes exclusively through this codebase's own helpers
// (lib/timezone.ts, lib/recurrence.ts) so a generated wall-clock time means
// exactly what it means everywhere else in the app (DST-safe, workspace-
// timezone-anchored).
//
// Needs Attention tuning: the real lib/needsAttention.ts, run against this
// bundle (includeInvoicing: true), returns EXACTLY four entries -- one each
// of worked_time_review, needs_invoicing, payment_outstanding,
// failed_message -- each on its own DISTINCT appointment (entries are
// deduplicated by appointmentId). Every other past, non-cancelled
// appointment is deliberately kept clean: fully tracked (or owner-corrected)
// AND paid. See generate.test.ts, which proves this against the real module.
// Caveat by design: an appointment that is still upcoming/in progress at
// generation time becomes "past" as real time moves on during a long demo
// session, at which point it can legitimately show up as needing review --
// exactly like the real app.
import type {
  Appointment,
  AppointmentEmployeeAssignment,
  Client,
  Employee,
  EmployeeHours,
  Service,
} from "@/app/components/dashboard/types";
import type { CompletedJobBilling, PaymentMethod } from "@/lib/completedJobBilling";
import { effectiveTimezone, toBusinessLocal, zonedDateTimeToUTC, zonedDateValue } from "@/lib/timezone";
import { addCalendarMonths, addDays } from "@/lib/recurrence";

// Not a real workspace -- a plain local marker carried on rows whose real
// table has a workspace_id column. Never sent to any server.
export const DEMO_LOCAL_WORKSPACE_ID = "demo-local";

// The same fallback the real app uses for a workspace with no saved Time
// Zone (effectiveTimezone(null) -> America/New_York).
export const DEMO_TIMEZONE = effectiveTimezone(null);

// appointment_employee_hours row (migrations/031): the dashboard's own
// EmployeeHours plus the workspace_id column the real table carries.
export type DemoEmployeeHours = EmployeeHours & { workspace_id: string };

// messages_sent-shaped row (incl. migrations/037 scheduled_for and
// migrations/040 subject). `simulated: true` is demo-only and is never part
// of any real production type: nothing in this demo was ever actually sent.
export type DemoMessageSent = {
  id: string;
  workspace_id: string;
  appointment_id: string | null;
  channel: "email" | "sms";
  kind: string;
  to_value: string;
  body: string;
  subject: string | null;
  provider_id: string;
  scheduled_for: string | null;
  created_at: string;
  simulated: true;
};

export type DemoFixtureBundle = {
  sessionInitIso: string;
  clients: Client[];
  appointments: Appointment[];
  employees: Employee[];
  services: Service[];
  employeeHours: DemoEmployeeHours[];
  assignments: AppointmentEmployeeAssignment[];
  completedJobBilling: CompletedJobBilling[];
  messagesSent: DemoMessageSent[];
};

// Honest placeholder provider_id for a simulated "successful" send.
// Deliberately matches NEITHER lib/messageStatus.ts's Resend UUID pattern
// nor its Twilio SID pattern, and is none of lib/notify.ts's sentinels
// ("failed" / "disabled" / "notifications-off") -- so it classifies as
// "unknown", never as a fabricated "sent".
export const DEMO_SIMULATED_PROVIDER_ID = "demo-simulated";

// ---------------------------------------------------------------------
// Static reference data (Sunshine Property Services theme -- same names/
// style as scripts/seed-demo-data.cjs)
// ---------------------------------------------------------------------

const EMPLOYEE_SEED = [
  { name: "Marcus Bell", phone: "(407) 555-0201", color: "#22C55E" },
  { name: "Priya Nandan", phone: "(407) 555-0202", color: "#3B82F6" },
  { name: "Derek Osei", phone: "(407) 555-0203", color: "#F59E0B" },
];

const SERVICE_SEED = [
  { name: "Lawn Mowing & Edging", description: "Routine mowing, edging, and trimming", duration_minutes: 45, color: "#22C55E", default_price_cents: 4500 },
  { name: "Property Inspection", description: "Walkthrough inspection with condition report", duration_minutes: 30, color: "#F59E0B", default_price_cents: 6500 },
  { name: "Window Washing", description: "Interior and exterior window cleaning", duration_minutes: 90, color: "#38BDF8", default_price_cents: 12000 },
  { name: "Pressure Washing", description: "Driveway, walkway, and siding pressure wash", duration_minutes: 120, color: "#0EA5E9", default_price_cents: 18000 },
  { name: "Move-Out Turnover Cleaning", description: "Full turnover cleaning between tenants", duration_minutes: 180, color: "#A855F7", default_price_cents: 25000 },
  { name: "Landscaping & Yard Cleanup", description: "Seasonal yard cleanup and landscaping touch-ups", duration_minutes: 150, color: "#84CC16", default_price_cents: 15000 },
];

// sinceDaysAgo replaces the seed script's absolute client_since literals.
const CLIENT_SEED: { name: string; address: string; sinceDaysAgo: number; preferred?: string; referred_by?: string; status?: string; notes?: string }[] = [
  { name: "Jordan Whitfield", address: "118 Sunbeam Lane, Palmetto Cove, FL 32999", sinceDaysAgo: 960, preferred: "phone", notes: "Gate code 4471. Friendly golden retriever in back yard — keep gate latched." },
  { name: "Melissa Carter", address: "42 Harbor View Dr, Palmetto Cove, FL 32999", sinceDaysAgo: 1090, preferred: "email", notes: "Prefers text confirmation the morning of service." },
  { name: "Devon Marsh", address: "275 Maple Ridge Ct, Palmetto Cove, FL 32999", sinceDaysAgo: 640, preferred: "phone" },
  { name: "Priscilla Nguyen", address: "9 Coral Breeze Ave, Palmetto Cove, FL 32999", sinceDaysAgo: 840, preferred: "sms", notes: "Two indoor-only cats — do not prop doors open." },
  { name: "Owen Fairweather", address: "630 Willowbend Rd, Palmetto Cove, FL 32999", sinceDaysAgo: 1500, referred_by: "Melissa Carter", notes: "Gate code 8823." },
  { name: "Natalie Brooks", address: "14 Seagrass Ln, Palmetto Cove, FL 32999", sinceDaysAgo: 620, notes: "Side gate sticks — lift slightly while pushing." },
  { name: "Terrence Wallace", address: "501 Driftwood Ct, Palmetto Cove, FL 32999", sinceDaysAgo: 1250 },
  { name: "Sophia Delgado", address: "88 Palmetto Ave, Palmetto Cove, FL 32999", sinceDaysAgo: 700, notes: "Please call ahead, prefers 30 min notice." },
  { name: "Grant Kim", address: "226 Heron Point Dr, Palmetto Cove, FL 32999", sinceDaysAgo: 1160, notes: "Gate code 1290. Two dogs, keep gate closed at all times." },
  { name: "Renee Ashworth", address: "77 Bayview Ter, Palmetto Cove, FL 32999", sinceDaysAgo: 570, referred_by: "Grant Kim" },
  { name: "Corey Padilla", address: "340 Magnolia St, Palmetto Cove, FL 32999", sinceDaysAgo: 1580, notes: "Leave invoice under the mat." },
  { name: "Angela Winslow", address: "19 Tidewater Way, Palmetto Cove, FL 32999", sinceDaysAgo: 750 },
  { name: "Felix Contreras", address: "512 Cypress Bend, Palmetto Cove, FL 32999", sinceDaysAgo: 1810, status: "inactive", notes: "Seasonal resident — only present Nov–Apr." },
  { name: "Brianna Holt", address: "63 Lighthouse Rd, Palmetto Cove, FL 32999", sinceDaysAgo: 530, notes: "Gate code 6604." },
  { name: "Walter Ngata", address: "205 Sandpiper Ln, Palmetto Cove, FL 32999", sinceDaysAgo: 1340 },
  { name: "Tasha Reyes", address: "8 Osprey Cir, Palmetto Cove, FL 32999", sinceDaysAgo: 910, notes: "Friendly but vocal dog — will bark, that's normal." },
  { name: "Douglas Fenwick", address: "450 Estuary Dr, Palmetto Cove, FL 32999", sinceDaysAgo: 2000, status: "inactive", notes: "On hold for remodeling — resume in spring." },
  { name: "Yvonne Castillo", address: "27 Marina Walk, Palmetto Cove, FL 32999", sinceDaysAgo: 600, notes: "Gate code 3315. Please close side gate fully." },
  { name: "Preston Aldridge", address: "611 Sunset Palm Dr, Palmetto Cove, FL 32999", sinceDaysAgo: 1130 },
  { name: "Camille Duvall", address: "132 Egret Cove, Palmetto Cove, FL 32999", sinceDaysAgo: 800, referred_by: "Yvonne Castillo", notes: "Prefers early morning appointments before 9am." },
];

// Deterministic UUID-shaped ids, so a regenerated fixture keeps the same ids
// (stable React keys, stable per-appointment links). `kind` is one hex digit
// per table.
function demoId(kind: number, n: number): string {
  return `00000000-0000-4000-a00${kind.toString(16)}-${n.toString(16).padStart(12, "0")}`;
}

const ID_KIND = { client: 1, employee: 2, service: 3, appointment: 4, assignment: 5, hours: 6, billing: 7, message: 8, series: 9 } as const;

// Paid-state rotation for an ordinary completed job: every one ends PAID
// (so it raises no billing issue), with a realistic mix of methods --
// including the legitimate "paid cash, no invoice" closed state.
const PAID_PATTERNS: { invoiced: boolean; method: PaymentMethod }[] = [
  { invoiced: true, method: "zelle" },
  { invoiced: true, method: "check" },
  { invoiced: false, method: "cash" },
  { invoiced: true, method: "quickbooks_card" },
  { invoiced: true, method: "zelle" },
  { invoiced: true, method: "other" },
];

type Scenario =
  | "normal"
  | "worked_time_review" // forgot to clock out, never corrected
  | "needs_invoicing" // completed, no billing row at all
  | "payment_outstanding" // completed, invoiced, unpaid
  | "failed_message" // completed + paid, but its confirmation email failed
  | "owner_corrected_missing" // no tracking at all; owner entered worked time
  | "owner_corrected_invalid" // sub-minute mis-tap; owner entered worked time
  | "cancelled_same_day"
  | "cancelled_late";

type ApptSpec = {
  client: number;
  service: number;
  start: string; // iso instant
  employees: number[];
  scenario?: Scenario;
  notes?: string | null;
  series?: { id: string; frequency_type: "weekly" | "monthly"; repeat_weeks: number; repeat_months: number | null; invoiceGroup: number };
};

export function generateDemoFixture(now: Date): DemoFixtureBundle {
  const tz = DEMO_TIMEZONE;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // ---- relative-date helpers (all built on lib/timezone + lib/recurrence)
  const dateOf = (dayOffset: number): string => zonedDateValue(addDays(now, dayOffset, tz).toISOString(), tz);
  const at = (dayOffset: number, hhmm: string): string => {
    const r = zonedDateTimeToUTC(dateOf(dayOffset), hhmm, tz);
    if (!r.ok) throw new Error(`demo fixture: ${r.error}`);
    return r.iso;
  };
  const plusMinutes = (iso: string, minutes: number): string => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
  const notAfterNow = (iso: string): string => (new Date(iso).getTime() > nowMs ? nowIso : iso);
  // Nudges a weekend day to the nearest weekday on the same side of today
  // (past stays past, future stays future); today itself is left alone.
  const weekday = (dayOffset: number): number => {
    const dow = toBusinessLocal(addDays(now, dayOffset, tz).toISOString(), tz).getDay();
    if (dayOffset < 0) return dow === 6 ? dayOffset - 1 : dow === 0 ? dayOffset - 2 : dayOffset;
    if (dayOffset > 0) return dow === 6 ? dayOffset + 2 : dow === 0 ? dayOffset + 1 : dayOffset;
    return dayOffset;
  };

  // ---- reference tables
  const employees: Employee[] = EMPLOYEE_SEED.map((e, i) => ({ id: demoId(ID_KIND.employee, i + 1), name: e.name, phone: e.phone, color: e.color, active: true }));
  const services: Service[] = SERVICE_SEED.map((s, i) => ({ id: demoId(ID_KIND.service, i + 1), active: true, ...s }));
  const clients: Client[] = CLIENT_SEED.map((c, i) => ({
    id: demoId(ID_KIND.client, i + 1),
    name: c.name,
    email: `${c.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
    phone: `(407) 555-01${String(20 + i).padStart(2, "0")}`,
    archived_at: null,
    address: c.address,
    client_since: dateOf(-c.sinceDaysAgo),
    referred_by: c.referred_by ?? null,
    status: c.status ?? "active",
    notes: c.notes ?? null,
    preferred_contact_method: c.preferred ?? "",
    auto_email: false,
    auto_sms: false,
  }));

  const appointments: Appointment[] = [];
  const assignments: AppointmentEmployeeAssignment[] = [];
  const employeeHours: DemoEmployeeHours[] = [];
  const completedJobBilling: CompletedJobBilling[] = [];
  const messagesSent: DemoMessageSent[] = [];

  let apptSeq = 0;
  let assignSeq = 0;
  let hoursSeq = 0;
  let billingSeq = 0;
  let invoiceSeq = 2040;
  let paidPatternSeq = 0;
  // series invoice groups: `${seriesId}:${group}` -> shared invoice/method
  const seriesInvoices = new Map<string, { invoice: string; method: PaymentMethod }>();

  const nextInvoice = () => String(++invoiceSeq);

  function addBilling(appt: Appointment, endIso: string, invoice: string | null, paid: boolean, method: PaymentMethod | null) {
    const stamp = notAfterNow(plusMinutes(endIso, 24 * 60));
    completedJobBilling.push({
      id: demoId(ID_KIND.billing, ++billingSeq),
      workspace_id: DEMO_LOCAL_WORKSPACE_ID,
      appointment_id: appt.id,
      client_id: appt.client_id,
      invoice_number: invoice,
      paid,
      payment_method: method,
      created_at: stamp,
      updated_at: stamp,
    });
  }

  function addAppt(spec: ApptSpec): Appointment {
    const scenario = spec.scenario ?? "normal";
    const service = services[spec.service];
    const duration = service.duration_minutes;
    const endIso = plusMinutes(spec.start, duration);
    const startMs = new Date(spec.start).getTime();
    const endMs = new Date(endIso).getTime();
    const employeeIds = spec.employees.map((i) => employees[i].id);
    const cancelled = scenario === "cancelled_same_day" || scenario === "cancelled_late";

    const appt: Appointment = {
      id: demoId(ID_KIND.appointment, ++apptSeq),
      client_id: clients[spec.client].id,
      service_type: service.name,
      scheduled_for: spec.start,
      status: cancelled ? "cancelled" : "scheduled",
      notes: spec.notes ?? null,
      duration_minutes: duration,
      scheduled_end: endIso,
      series_id: spec.series?.id ?? null,
      frequency_type: spec.series?.frequency_type ?? "one_time",
      repeat_weeks: spec.series?.repeat_weeks ?? 1,
      repeat_months: spec.series?.repeat_months ?? null,
      // Read-only compatibility mirror -- same rule as lib/appointmentEmployees.ts's deriveLegacyEmployeeId.
      employee_id: employeeIds.length === 1 ? employeeIds[0] : null,
      actual_started_at: null,
      actual_completed_at: null,
      price_cents: service.default_price_cents ?? null,
      team_color: null,
      cancelled_at: null,
      cancellation_reported_date: null,
      cancellation_reason: null,
    };

    if (scenario === "cancelled_same_day") {
      // "now - 90 minutes" can land on YESTERDAY's calendar date whenever
      // `now` itself is within the first 90 minutes after local midnight --
      // that would make cancelled_at's own zoned date disagree with
      // cancellation_reported_date (= dateOf(0), always today), breaking
      // the "same-day" scenario at exactly that time of day. Clamped to
      // never go earlier than the start of today, so cancelled_at's zoned
      // date is always dateOf(0), same as nowIso's -- the clamp can only
      // ever push the candidate forward (never past `now` itself, since
      // "now" is always >= the start of its own day).
      const todayStart = at(0, "00:00");
      const candidate = plusMinutes(nowIso, -90);
      appt.cancelled_at = notAfterNow(new Date(candidate).getTime() < new Date(todayStart).getTime() ? todayStart : candidate);
      appt.cancellation_reported_date = dateOf(0);
      appt.cancellation_reason = "Client called this morning — tenant move-in was postponed.";
    } else if (scenario === "cancelled_late") {
      // Migration 038's late-report case: the client reported it the day
      // before the visit, but the cancellation was only recorded in the
      // system days after the scheduled date had already passed. Wrapped in
      // notAfterNow for the same reason every other historical-event
      // timestamp in this file is: a future-dated "system record" would be
      // nonsensical if this scenario is ever assigned to a less-distant-past
      // appointment later.
      const apptDayOffset = Math.round((startMs - nowMs) / 86_400_000);
      appt.cancelled_at = notAfterNow(at(apptDayOffset + 7, "16:10"));
      appt.cancellation_reported_date = dateOf(apptDayOffset - 1);
      appt.cancellation_reason = "Client called the day before to cancel; recorded late after the fact.";
    }
    appointments.push(appt);

    const createdAt = notAfterNow(plusMinutes(spec.start, -7 * 24 * 60));
    const elapsed = endMs < nowMs;
    const inProgress = !elapsed && startMs <= nowMs;

    for (const employeeId of employeeIds) {
      let started: string | null = null;
      let completed: string | null = null;
      if (!cancelled) {
        if (scenario === "worked_time_review") {
          started = plusMinutes(spec.start, 4);
        } else if (scenario === "owner_corrected_missing") {
          // never used Start/Complete Job at all
        } else if (scenario === "owner_corrected_invalid") {
          started = plusMinutes(spec.start, 2);
          completed = new Date(new Date(started).getTime() + 30_000).toISOString(); // sub-minute mis-tap
        } else if (elapsed) {
          started = plusMinutes(spec.start, 5);
          completed = plusMinutes(endIso, -5);
        } else if (inProgress) {
          started = notAfterNow(plusMinutes(spec.start, 3));
        }
      }
      assignments.push({
        id: demoId(ID_KIND.assignment, ++assignSeq),
        appointment_id: appt.id,
        employee_id: employeeId,
        actual_started_at: started,
        actual_completed_at: completed,
        job_notes: null,
        created_at: createdAt,
        updated_at: completed ?? started ?? createdAt,
      });

      if (scenario === "owner_corrected_missing" || scenario === "owner_corrected_invalid") {
        const stamp = notAfterNow(plusMinutes(endIso, 20 * 60));
        employeeHours.push({
          id: demoId(ID_KIND.hours, ++hoursSeq),
          appointment_id: appt.id,
          employee_id: employeeId,
          hours_worked: Math.round((duration / 60) * 4) / 4,
          note:
            scenario === "owner_corrected_missing"
              ? "Forgot to use Start Job / Complete Job — confirmed time on site with the client."
              : "Clocked in and out by mistake on arrival — corrected to actual time on site.",
          workspace_id: DEMO_LOCAL_WORKSPACE_ID,
          created_at: stamp,
          updated_at: stamp,
        });
      }
    }

    // Billing: only for jobs that are actually completed for billing
    // purposes (elapsed + tracked, or owner-corrected). Everything not
    // deliberately flagged ends up PAID.
    if (!cancelled && elapsed && scenario !== "worked_time_review" && scenario !== "needs_invoicing" && employeeIds.length > 0) {
      if (scenario === "payment_outstanding") {
        addBilling(appt, endIso, nextInvoice(), false, null);
      } else if (spec.series) {
        const key = `${spec.series.id}:${spec.series.invoiceGroup}`;
        let group = seriesInvoices.get(key);
        if (!group) {
          const methods: PaymentMethod[] = ["zelle", "check", "quickbooks_card"];
          group = { invoice: nextInvoice(), method: methods[seriesInvoices.size % methods.length] };
          seriesInvoices.set(key, group);
        }
        addBilling(appt, endIso, group.invoice, true, group.method);
      } else {
        const p = PAID_PATTERNS[paidPatternSeq++ % PAID_PATTERNS.length];
        addBilling(appt, endIso, p.invoiced ? nextInvoice() : null, true, p.method);
      }
    }
    return appt;
  }

  // ---- recurring series (weekly / biweekly / every-4-weeks / monthly)
  const seriesDefs: { client: number; service: number; baseOffset: number; time: string; employees: number[]; frequency_type: "weekly" | "monthly"; repeat_weeks: number; repeat_months: number | null; from: number; to: number }[] = [
    { client: 0, service: 0, baseOffset: -1, time: "09:00", employees: [0], frequency_type: "weekly", repeat_weeks: 1, repeat_months: null, from: -5, to: 6 },
    { client: 1, service: 2, baseOffset: -2, time: "10:00", employees: [1], frequency_type: "weekly", repeat_weeks: 2, repeat_months: null, from: -4, to: 4 },
    { client: 4, service: 1, baseOffset: -4, time: "13:00", employees: [2], frequency_type: "monthly", repeat_weeks: 1, repeat_months: 1, from: -3, to: 3 },
    { client: 8, service: 3, baseOffset: -6, time: "08:00", employees: [0, 2], frequency_type: "weekly", repeat_weeks: 4, repeat_months: null, from: -3, to: 3 },
  ];
  seriesDefs.forEach((def, sIdx) => {
    const seriesId = demoId(ID_KIND.series, sIdx + 1);
    const anchor = new Date(at(weekday(def.baseOffset), def.time));
    for (let k = def.from; k <= def.to; k++) {
      const start =
        def.frequency_type === "monthly"
          ? addCalendarMonths(anchor, k * (def.repeat_months ?? 1), tz)
          : addDays(anchor, k * 7 * def.repeat_weeks, tz);
      addAppt({
        client: def.client,
        service: def.service,
        start: start.toISOString(),
        employees: def.employees,
        series: {
          id: seriesId,
          frequency_type: def.frequency_type,
          repeat_weeks: def.repeat_weeks,
          repeat_months: def.repeat_months,
          // pairs of consecutive visits share one invoice (same client) --
          // the sibling-sync scenario the billing update route handles.
          invoiceGroup: Math.floor((k - def.from) / 2),
        },
      });
    }
  });

  // ---- one-off appointments: the four Needs Attention triggers, the
  // owner-corrected and cancelled scenarios, and ordinary past/today/future work.
  const o = (client: number, service: number, dayOffset: number, time: string, emps: number[], scenario?: Scenario, notes?: string) =>
    addAppt({ client, service, start: at(dayOffset === 0 ? 0 : weekday(dayOffset), time), employees: emps, scenario, notes });

  o(2, 4, -1, "08:00", [1], "worked_time_review", "Tenant move-out; keys in lockbox.");
  o(3, 2, -2, "13:00", [1], "needs_invoicing");
  o(5, 5, -4, "09:30", [0], "payment_outstanding");
  const failedMsgAppt = o(6, 1, -3, "15:00", [2], "failed_message");
  o(7, 0, -5, "11:00", [0], "owner_corrected_missing");
  o(9, 3, -9, "10:00", [2], "owner_corrected_invalid");
  o(10, 2, -12, "09:00", [1], "cancelled_late");
  const angelaPast = o(11, 4, -15, "08:30", [1, 2]);
  const briannaPast = o(13, 0, -20, "14:00", [0]);
  o(14, 1, -26, "10:30", [2]);
  o(15, 5, -33, "09:00", [0, 1]);
  o(17, 2, -41, "13:30", [1]);
  o(18, 3, -50, "08:00", [2]);
  // today -- tracked/paid if already over, in progress if underway, untouched if upcoming
  o(19, 1, 0, "08:00", [2]);
  o(13, 0, 0, "11:30", [0]);
  o(11, 2, 0, "14:30", [1]);
  // upcoming
  const terrenceTomorrow = o(6, 4, 1, "09:00", [1, 2], undefined, "Unit 2B — full turnover before Friday move-in.");
  o(19, 2, 2, "10:00", [1], "cancelled_same_day");
  o(9, 5, 3, "10:00", [0]);
  const devonFuture = o(2, 1, 5, "13:00", [2]);
  o(14, 0, 8, "08:30", [0]);
  o(17, 3, 10, "09:00", [0, 2]);
  o(10, 4, 13, "08:00", [1]);
  o(15, 1, 16, "14:00", []); // not yet assigned

  // ---- exactly 5 simulated messages_sent rows (nothing was really sent)
  let msgSeq = 0;
  const clientOf = (a: Appointment) => clients.find((c) => c.id === a.client_id)!;
  const addMessage = (appt: Appointment, channel: "email" | "sms", kind: string, providerId: string, createdAt: string, scheduledFor: string | null = null) => {
    const client = clientOf(appt);
    const subject = channel === "email" ? (kind === "reminder_24h" ? "Reminder: your appointment is tomorrow" : kind === "update" ? "Your appointment was updated" : "Your appointment is confirmed") : null;
    messagesSent.push({
      id: demoId(ID_KIND.message, ++msgSeq),
      workspace_id: DEMO_LOCAL_WORKSPACE_ID,
      appointment_id: appt.id,
      channel,
      kind,
      to_value: channel === "email" ? client.email ?? "" : client.phone ?? "",
      body: `Hi ${client.name.split(" ")[0]}, this is Sunshine Property Services about your ${appt.service_type} appointment. (Demo message — not actually sent.)`,
      subject,
      provider_id: providerId,
      scheduled_for: scheduledFor,
      created_at: notAfterNow(createdAt),
      simulated: true,
    });
  };
  addMessage(failedMsgAppt, "email", "confirmation", "failed", plusMinutes(failedMsgAppt.scheduled_for, -6 * 24 * 60));
  addMessage(devonFuture, "sms", "confirmation", DEMO_SIMULATED_PROVIDER_ID, plusMinutes(nowIso, -2 * 24 * 60));
  addMessage(terrenceTomorrow, "email", "reminder_24h", DEMO_SIMULATED_PROVIDER_ID, plusMinutes(terrenceTomorrow.scheduled_for, -24 * 60), terrenceTomorrow.scheduled_for);
  addMessage(angelaPast, "email", "update", "notifications-off", plusMinutes(angelaPast.scheduled_for, -3 * 24 * 60));
  addMessage(briannaPast, "sms", "confirmation", DEMO_SIMULATED_PROVIDER_ID, plusMinutes(briannaPast.scheduled_for, -5 * 24 * 60));

  appointments.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for) || a.id.localeCompare(b.id));

  return {
    sessionInitIso: nowIso,
    clients: [...clients].sort((a, b) => a.name.localeCompare(b.name)),
    appointments,
    employees: [...employees].sort((a, b) => a.name.localeCompare(b.name)),
    services: [...services].sort((a, b) => a.name.localeCompare(b.name)),
    employeeHours,
    assignments,
    completedJobBilling,
    messagesSent,
  };
}
