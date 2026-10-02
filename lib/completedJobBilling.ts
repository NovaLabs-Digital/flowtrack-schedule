// Billing / Completed Jobs (V1) -- pure computation only, no I/O. Mirrors
// lib/payroll.ts's and lib/incomeProjection.ts's existing split: business
// logic lives here and is unit-testable without a database; the API route
// (app/api/billing/completed-jobs/route.ts) and UI component
// (app/components/dashboard/BillingPanel.tsx) stay thin.
//
// This module does NOT invent a third, independent interpretation of
// worked time. isCompletedForBilling below delegates entirely to
// lib/payroll.ts's isAppointmentBillingEligible, which reuses the exact
// same owner-override-first precedence already established for payroll
// (assignmentHasWorkedHours/resolveWorkedMinutes): an assigned employee
// counts as resolved when EITHER their Job Tracking Start/Complete pair is
// valid, OR the owner has saved an appointment_employee_hours correction
// for them on this appointment -- entered precisely because tracking was
// missing or wrong (see AdjustWorkedTimeControl.tsx). That correction never
// fabricates or rewrites the employee's own actual_started_at/
// actual_completed_at.
//
// This is a deliberately different, slightly more permissive rule than
// deriveAppointmentTrackingStatus's own "completed" (which the Dispatch
// panel's status pill uses and is entirely UNCHANGED by this module):
// Dispatch asks "did Job Tracking itself finish," Billing asks "has the
// owner already resolved this employee's work record, one way or another."
// A real completed job -- Job-Tracking-complete OR owner-corrected -- must
// never sit in "Past jobs needing completion review" just because an
// employee forgot to use Start Job / Complete Job and the owner already
// fixed it (see isAppointmentBillingEligible's own doc comment for the
// full reasoning).
import type { Appointment, Client, AppointmentEmployeeAssignment, EmployeeHours } from "@/app/components/dashboard/types";
import { isAppointmentBillingEligible, isEligibleForWorkedHoursWarning, toDateInputValue } from "@/lib/payroll";
import { toBusinessLocal } from "@/lib/timezone";

// Only the assignment fields isAppointmentBillingEligible actually needs --
// matches lib/payroll.ts's own narrowing convention.
type BillingAssignment = Pick<AppointmentEmployeeAssignment, "employee_id" | "actual_started_at" | "actual_completed_at">;

// Only the Appointment fields this module actually reads -- matches
// lib/payroll.ts's own convention of narrowing to Pick<Appointment, ...>
// rather than requiring the full type, so a caller (the API route) only
// needs to select exactly these columns, not every column Appointment has.
export type BillableAppointment = Pick<
  Appointment,
  "id" | "client_id" | "service_type" | "scheduled_for" | "scheduled_end" | "duration_minutes" | "status" | "price_cents"
>;

export type PaymentMethod = "zelle" | "check" | "cash" | "quickbooks_card" | "other";

// Order here is the order shown in the UI's <select>.
export const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "zelle", label: "Zelle" },
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "quickbooks_card", label: "QuickBooks / Card" },
  { value: "other", label: "Other" },
];
const PAYMENT_METHOD_VALUES: readonly string[] = PAYMENT_METHODS.map((m) => m.value);

export function isValidPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && PAYMENT_METHOD_VALUES.includes(value);
}

// The completed_job_billing table row, as the API returns it.
export type CompletedJobBilling = {
  id: string;
  workspace_id: string;
  appointment_id: string;
  invoice_number: string | null;
  paid: boolean;
  payment_method: PaymentMethod | null;
  created_at: string;
  updated_at: string;
};

// Trims a user-typed invoice number into its stored representation. A blank
// (or whitespace-only) input normalizes to null ("no invoice number yet"),
// matching this schema's existing "blank string and null are not stored as
// two different things" convention for an optional free-text/price field
// (see lib/money.ts's parsePriceToCents). Never throws.
export function normalizeInvoiceNumber(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  return trimmed || null;
}

export type BillingFieldsPatch = {
  invoice_number?: string | null;
  paid?: boolean;
  payment_method?: string | null;
};

export type BillingValidation = { ok: true } | { ok: false; error: string };

// Validates the RESULTING (already-merged) billing state -- not just the
// fields present in one request -- because "paid = true requires a
// payment_method" is a property of the row as a whole, not of any single
// field being edited. The caller (the update route) is responsible for
// merging a partial patch onto the existing row (or onto the "no row yet"
// defaults: paid=false, invoice_number=null, payment_method=null) before
// calling this. Mirrors the database's own
// completed_job_billing_paid_requires_method CHECK constraint exactly, so
// a violation is always caught here first, with a clear message, before
// ever reaching that constraint as a raw database error.
export function validateBillingState(state: { paid: boolean; payment_method: string | null }): BillingValidation {
  if (state.payment_method !== null && !isValidPaymentMethod(state.payment_method)) {
    return { ok: false, error: "Invalid payment method" };
  }
  if (state.paid && !state.payment_method) {
    return { ok: false, error: "Payment method is required once a job is marked Paid." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// "Completed" (billing-eligible) vs. "needs completion review"
// ---------------------------------------------------------------------

// True when every assigned employee's work record is resolved -- see this
// module's own header comment and isAppointmentBillingEligible's doc
// comment (lib/payroll.ts) for the exact owner-override-first rule. A
// zero-assignment appointment is never completed.
export function isCompletedForBilling(
  appointmentId: string,
  assignments: BillingAssignment[],
  employeeHours: EmployeeHours[]
): boolean {
  return isAppointmentBillingEligible(appointmentId, assignments, employeeHours);
}

// True for a past, non-cancelled appointment whose scheduled time has
// already elapsed but that does NOT satisfy isCompletedForBilling above --
// i.e. a job that may well have happened, but has at least one assigned
// employee whose work record is still unresolved (missing assignment
// entirely, or neither a valid tracked duration nor an owner-approved
// correction). These are surfaced to the owner as a secondary "needs
// review" list so a real completed job is never silently invisible just
// because Job Tracking wasn't used and no one has corrected it yet -- but
// they are NEVER counted in the Completed Jobs list or any money total,
// and this function creates no new completion/status concept: it is
// purely "past + not cancelled + not already completed."
export function needsCompletionReview(
  appt: Pick<Appointment, "id" | "status" | "scheduled_for" | "scheduled_end" | "duration_minutes">,
  assignments: BillingAssignment[],
  employeeHours: EmployeeHours[]
): boolean {
  if (appt.status === "cancelled") return false;
  if (!isEligibleForWorkedHoursWarning(appt)) return false;
  return !isCompletedForBilling(appt.id, assignments, employeeHours);
}

// ---------------------------------------------------------------------
// Date-range inclusion
// ---------------------------------------------------------------------

// True when an appointment's WORKSPACE-LOCAL calendar date falls within
// [rangeStart, rangeEnd] (both "YYYY-MM-DD", inclusive) -- same bucketing
// rule as computePayrollRows/computeIncomeProjection, so this report's date
// range agrees with every other date-ranged card in the dashboard.
export function isInDateRange(
  appt: Pick<Appointment, "scheduled_for">,
  rangeStart: string,
  rangeEnd: string,
  timezone: string
): boolean {
  const apptDate = toDateInputValue(toBusinessLocal(appt.scheduled_for, timezone));
  return apptDate >= rangeStart && apptDate <= rangeEnd;
}

// ---------------------------------------------------------------------
// Row shapes for the UI
// ---------------------------------------------------------------------

export type CompletedJobRow = {
  appointmentId: string;
  serviceDate: string; // workspace-local "YYYY-MM-DD", for display/sorting
  scheduledFor: string; // iso instant
  clientId: string;
  clientName: string;
  serviceType: string;
  priceCents: number | null;
  billing: CompletedJobBilling | null; // null = no billing row yet (nothing entered)
};

export type ReviewNeededRow = {
  appointmentId: string;
  serviceDate: string;
  scheduledFor: string;
  clientId: string;
  clientName: string;
  serviceType: string;
};

function clientName(clientId: string, clientsById: Map<string, Client>): string {
  return clientsById.get(clientId)?.name ?? "Unknown client";
}

// Builds the main Billing / Completed Jobs list for one date range: every
// completed (per isCompletedForBilling), non-cancelled appointment in
// range, each joined with its billing row if one exists. Callers must
// already have scoped `appointments`/`assignments`/`billingRows` to the
// authenticated workspace (and demo/real isolation) -- this function
// performs no workspace filtering of its own, exactly like
// computePayrollRows/computeIncomeProjection already assume of their own
// callers.
export function buildCompletedJobRows({
  appointments,
  clients,
  assignmentsByAppointmentId,
  billingByAppointmentId,
  employeeHours,
  rangeStart,
  rangeEnd,
  timezone,
}: {
  appointments: BillableAppointment[];
  clients: Client[];
  assignmentsByAppointmentId: Map<string, AppointmentEmployeeAssignment[]>;
  billingByAppointmentId: Map<string, CompletedJobBilling>;
  // Owner-approved worked-time corrections (appointment_employee_hours) --
  // see this module's own header comment for why these can resolve an
  // employee's otherwise-missing Job Tracking for billing purposes. The
  // whole array, not pre-filtered per appointment, matching
  // computePayrollRows' own convention (lib/payroll.ts).
  employeeHours: EmployeeHours[];
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
}): CompletedJobRow[] {
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const rows: CompletedJobRow[] = [];

  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;
    if (!isInDateRange(appt, rangeStart, rangeEnd, timezone)) continue;

    const assignments = assignmentsByAppointmentId.get(appt.id) ?? [];
    if (!isCompletedForBilling(appt.id, assignments, employeeHours)) continue;

    rows.push({
      appointmentId: appt.id,
      serviceDate: toDateInputValue(toBusinessLocal(appt.scheduled_for, timezone)),
      scheduledFor: appt.scheduled_for,
      clientId: appt.client_id,
      clientName: clientName(appt.client_id, clientsById),
      serviceType: appt.service_type,
      priceCents: appt.price_cents ?? null,
      billing: billingByAppointmentId.get(appt.id) ?? null,
    });
  }

  rows.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  return rows;
}

// Builds the secondary "Past jobs needing completion review" list for the
// same date range -- see needsCompletionReview's own doc comment for
// exactly what qualifies and why these rows are kept separate.
export function buildReviewNeededRows({
  appointments,
  clients,
  assignmentsByAppointmentId,
  employeeHours,
  rangeStart,
  rangeEnd,
  timezone,
}: {
  appointments: BillableAppointment[];
  clients: Client[];
  assignmentsByAppointmentId: Map<string, AppointmentEmployeeAssignment[]>;
  employeeHours: EmployeeHours[];
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
}): ReviewNeededRow[] {
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const rows: ReviewNeededRow[] = [];

  for (const appt of appointments) {
    if (!isInDateRange(appt, rangeStart, rangeEnd, timezone)) continue;
    const assignments = assignmentsByAppointmentId.get(appt.id) ?? [];
    if (!needsCompletionReview(appt, assignments, employeeHours)) continue;

    rows.push({
      appointmentId: appt.id,
      serviceDate: toDateInputValue(toBusinessLocal(appt.scheduled_for, timezone)),
      scheduledFor: appt.scheduled_for,
      clientId: appt.client_id,
      clientName: clientName(appt.client_id, clientsById),
      serviceType: appt.service_type,
    });
  }

  rows.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  return rows;
}

// ---------------------------------------------------------------------
// Status filters (applied client-side over the already date-range-scoped
// list returned by the API -- see BillingPanel.tsx)
// ---------------------------------------------------------------------

export type BillingStatusFilter = "all" | "missing_invoice" | "invoiced_unpaid" | "paid";

export const BILLING_STATUS_FILTERS: { value: BillingStatusFilter; label: string }[] = [
  { value: "all", label: "All Completed" },
  { value: "missing_invoice", label: "Missing Invoice #" },
  { value: "invoiced_unpaid", label: "Invoiced / Unpaid" },
  { value: "paid", label: "Paid" },
];

function hasInvoiceNumber(row: CompletedJobRow): boolean {
  return !!row.billing?.invoice_number;
}
function isPaid(row: CompletedJobRow): boolean {
  return row.billing?.paid === true;
}

// Real production rule (Holly Williams, paid Cash): for a cash job, the
// owner does not always create a QuickBooks invoice at all -- a paid,
// Cash, blank-invoice row is a legitimate FINAL state, not an error or an
// incomplete record (validateBillingState already allows paid=true with
// invoice_number=null; only payment_method is required, and that is
// unchanged by this). Once paid by cash, the job is financially closed for
// this workflow and must not keep showing up asking for an invoice number
// that was never going to exist.
function isCashPaidWithoutInvoice(row: CompletedJobRow): boolean {
  return isPaid(row) && row.billing?.payment_method === "cash" && !hasInvoiceNumber(row);
}

// Client-name search (client-side, applied over the already date-range-
// scoped rows the API returned -- see BillingPanel.tsx). Case-insensitive,
// partial substring match ("hol" matches "Holly Williams", "tam" matches
// both "Tammy Owens" and "Tami Factor"). A blank/whitespace-only query
// matches every row, so the unfiltered case needs no special-casing by
// callers. Deliberately NOT an all-history search -- it never looks beyond
// the rows already loaded for the selected date range; widening the range
// is the owner's existing way to search further back.
export function matchesClientSearch(clientName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return clientName.toLowerCase().includes(q);
}

export function applyBillingStatusFilter(rows: CompletedJobRow[], filter: BillingStatusFilter): CompletedJobRow[] {
  switch (filter) {
    case "missing_invoice":
      // "Missing Invoice #" means an invoice still needs to be created
      // before the job is financially closed -- not merely "invoice_number
      // is null." A paid-Cash job with no invoice is already closed (see
      // isCashPaidWithoutInvoice above) and must be excluded here, even
      // though its invoice_number is genuinely blank.
      return rows.filter((r) => !hasInvoiceNumber(r) && !isCashPaidWithoutInvoice(r));
    case "invoiced_unpaid":
      return rows.filter((r) => hasInvoiceNumber(r) && !isPaid(r));
    case "paid":
      return rows.filter((r) => isPaid(r));
    case "all":
    default:
      return rows;
  }
}

// ---------------------------------------------------------------------
// Summary totals
// ---------------------------------------------------------------------

export type BillingSummary = {
  completedJobs: number;
  completedWorkCents: number;
  invoicedCents: number;
  unpaidCents: number;
};

// Totals are always computed over the FULL (unfiltered-by-status) set of
// completed jobs in the selected date range -- the status filter changes
// which rows are listed, never what the summary totals mean, so a summary
// above a filtered table never silently represents a different range than
// its own filter implies (that filter dropdown is purely a row-visibility
// control). Review-needed rows (lib's own, separate list) are never passed
// into this function and never affect these totals -- see the module doc
// comment and needsCompletionReview's own comment for why.
//
// Price source: appt.price_cents, the same per-appointment snapshot
// lib/incomeProjection.ts already uses -- a missing price contributes $0,
// never a guessed fallback (matches that module's own documented
// convention exactly).
//
// A paid-Cash job with no invoice number (isCashPaidWithoutInvoice above)
// deliberately needs NO special-casing here: completedWorkCents already
// counts every completed job's price unconditionally (Holly's $120
// belongs there regardless of invoicing), and invoicedCents/unpaidCents
// already only add a row that HAS an invoice_number -- a blank-invoice
// cash row was never going to contribute to either of those two, exactly
// as intended. Only applyBillingStatusFilter's "missing_invoice" case
// needed an explicit carve-out, because that filter's whole job is asking
// "does this one still need an invoice," which a closed cash job does not.
export function computeBillingSummary(rows: CompletedJobRow[]): BillingSummary {
  let completedWorkCents = 0;
  let invoicedCents = 0;
  let unpaidCents = 0;

  for (const row of rows) {
    const cents = row.priceCents ?? 0;
    completedWorkCents += cents;
    if (hasInvoiceNumber(row)) {
      invoicedCents += cents;
      if (!isPaid(row)) unpaidCents += cents;
    }
  }

  return { completedJobs: rows.length, completedWorkCents, invoicedCents, unpaidCents };
}
