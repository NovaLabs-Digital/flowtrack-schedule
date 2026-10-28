// "Needs attention" (desktop sidebar control + mobile equivalent):
// aggregates three kinds of actionable items across a bounded recent
// window, each backed by an EXISTING authoritative rule already used
// elsewhere in this app -- this module invents no new eligibility/status
// logic of its own, only the grouping/labeling needed to surface them
// together in one place.
//
//   1. Worked-time review: buildReviewNeededRows (needsCompletionReview)
//      below, from lib/completedJobBilling.ts -- the EXACT same "Past jobs
//      needing completion review" list already shown under Billing /
//      Completed Jobs. An appointment whose owner correction already
//      resolves every assigned employee's work is NEVER included here,
//      because it is already excluded there (isAppointmentBillingEligible,
//      lib/payroll.ts).
//   2. Billing: buildCompletedJobRows + the SAME applyBillingStatusFilter
//      the Billing panel's own status dropdown uses, applied twice for two
//      DISTINCT, mutually-exclusive statuses -- never merged into one
//      issue, since they call for different owner actions (create an
//      invoice vs. follow up on payment):
//        - "missing_invoice" -> "Needs invoice number."
//        - "invoiced_unpaid" -> "Payment outstanding."
//      Mutual exclusivity is structural, not re-decided here:
//      applyBillingStatusFilter's own "missing_invoice" case requires
//      !hasInvoiceNumber(r), and "invoiced_unpaid" requires
//      hasInvoiceNumber(r) -- a row can never satisfy both at once. A
//      row marked paid satisfies neither ("invoiced_unpaid" also requires
//      !isPaid(r)), so a paid job shows no billing issue at all. A
//      paid-Cash job with no invoice (a legitimate closed state -- see
//      isCashPaidWithoutInvoice's own doc comment) is correctly excluded
//      from "missing_invoice" by that same filter, not re-decided here.
//      "Payment outstanding" means unpaid according to this workspace's own
//      saved billing records -- never a due-date/overdue inference (no such
//      rule exists yet) and never anything derived from an external payment
//      service.
//   3. Failed messages: the caller (the API route) classifies each
//      messages_sent row via lib/messageStatus.ts's
//      countUnresolvedFailedMessageGroupsByAppointment, which itself only
//      ever uses classifyMessageStatus's existing "failed" sentinel -- an
//      appointment with NO message row at all is never flagged; failure is
//      never inferred from absence. A failed attempt followed by a later
//      accepted retry for the exact same appointment/channel/kind/
//      occurrence is resolved and excluded by that same helper, not
//      re-decided here either.
import {
  buildReviewNeededRows,
  buildCompletedJobRows,
  applyBillingStatusFilter,
  type BillableAppointment,
  type CompletedJobBilling,
} from "@/lib/completedJobBilling";
import { toDateInputValue } from "@/lib/payroll";
import { toBusinessLocal } from "@/lib/timezone";
import type { Client, AppointmentEmployeeAssignment, EmployeeHours } from "@/app/components/dashboard/types";

// How far back "Needs attention" looks for past unresolved work -- a
// deliberately BOUNDED window, not all-time history (which would mean an
// ever-growing, unbounded query and render as a workspace accumulates
// years of appointments). An item older than this is not silently hidden:
// the API route returns rangeStart/rangeEnd alongside the entries, and the
// UI displays that span explicitly, so the owner always knows the real
// scope of what's shown and can still find older unresolved work through
// Billing / Completed Jobs (whose own date range is not bounded this way).
export const NEEDS_ATTENTION_LOOKBACK_DAYS = 60;

export type NeedsAttentionIssueKind = "worked_time_review" | "needs_invoicing" | "payment_outstanding" | "failed_message";

export type NeedsAttentionIssue = {
  kind: NeedsAttentionIssueKind;
  label: string;
};

export type NeedsAttentionEntry = {
  appointmentId: string;
  clientName: string;
  serviceType: string;
  serviceDate: string; // workspace-local "YYYY-MM-DD", for display
  scheduledFor: string; // iso instant -- the real sort key
  issues: NeedsAttentionIssue[];
};

// Only "missing_invoice" rows ever reach this (see the module header) --
// every such row has no invoice_number by that filter's own definition, so
// there is exactly one label, never a billing-row-dependent branch.
const NEEDS_INVOICE_LABEL = "Needs invoice number";
// Only "invoiced_unpaid" rows ever reach this -- every such row already has
// an invoice_number and is not paid, so this is also a single fixed label,
// never a row-dependent branch. Deliberately NOT "Overdue": this app has no
// established due-date rule for completed jobs, so the label states only
// what SFT's own saved records actually show (invoiced, unpaid), never an
// inferred urgency it can't honestly back up.
const NEEDS_PAYMENT_LABEL = "Payment outstanding";

function failedMessageLabel(count: number): string {
  return count === 1 ? "1 failed message" : `${count} failed messages`;
}

export function buildNeedsAttentionEntries({
  appointments,
  clients,
  assignmentsByAppointmentId,
  billingByAppointmentId,
  employeeHours,
  failedMessageCountsByAppointmentId,
  rangeStart,
  rangeEnd,
  timezone,
  includeInvoicing = true,
}: {
  // The full appointment set already scoped to [rangeStart, rangeEnd] --
  // deliberately NOT pre-filtered to only billing-eligible or review-
  // needed ones, since a failed-message issue (item 3) can apply to any
  // appointment regardless of its billing/tracking state.
  appointments: BillableAppointment[];
  clients: Client[];
  assignmentsByAppointmentId: Map<string, AppointmentEmployeeAssignment[]>;
  billingByAppointmentId: Map<string, CompletedJobBilling>;
  employeeHours: EmployeeHours[];
  failedMessageCountsByAppointmentId: Map<string, number>;
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  // Destination-permission control, decided by the caller: gates BOTH
  // billing-destination issues (needs_invoicing AND payment_outstanding),
  // since each one's only action is "open Settings -> Billing," which is
  // owner-only (DashboardSettingsArea gates Billing behind !isTester) and
  // does not exist at all on mobile (MobileSettings is a placeholder).
  // Rather than surface an issue whose only action lands on a placeholder
  // or doesn't exist, the caller (the API route) sets this to false for any
  // session/surface that cannot act on either -- neither issue is ever
  // generated in the first place, not merely hidden after the fact.
  includeInvoicing?: boolean;
}): NeedsAttentionEntry[] {
  const byAppointmentId = new Map<string, NeedsAttentionEntry>();
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const apptById = new Map(appointments.map((a) => [a.id, a]));

  function entryFor(appt: BillableAppointment): NeedsAttentionEntry {
    const existing = byAppointmentId.get(appt.id);
    if (existing) return existing;
    const created: NeedsAttentionEntry = {
      appointmentId: appt.id,
      clientName: clientsById.get(appt.client_id)?.name ?? "Unknown client",
      serviceType: appt.service_type,
      serviceDate: toDateInputValue(toBusinessLocal(appt.scheduled_for, timezone)),
      scheduledFor: appt.scheduled_for,
      issues: [],
    };
    byAppointmentId.set(appt.id, created);
    return created;
  }

  // 1. Worked-time review -- reuses buildReviewNeededRows verbatim; this
  // function's own cancelled/eligibility/billing-resolved checks decide
  // membership, not anything re-derived here.
  const reviewRows = buildReviewNeededRows({
    appointments, clients, assignmentsByAppointmentId, employeeHours, rangeStart, rangeEnd, timezone,
  });
  for (const row of reviewRows) {
    const appt = apptById.get(row.appointmentId);
    if (!appt) continue;
    entryFor(appt).issues.push({ kind: "worked_time_review", label: "Worked time needs review" });
  }

  // 2. Billing (needs invoicing / payment outstanding) -- reuses
  // buildCompletedJobRows + the same applyBillingStatusFilter the Billing
  // panel's own status dropdown uses, called once per status (see the
  // module header for why the two are structurally mutually exclusive and
  // never merged into one issue). Both skipped entirely when the caller has
  // no permitted destination to offer for either (includeInvoicing: false)
  // -- not merely filtered after the fact.
  if (includeInvoicing) {
    const completedRows = buildCompletedJobRows({
      appointments, clients, assignmentsByAppointmentId, billingByAppointmentId, employeeHours, rangeStart, rangeEnd, timezone,
    });
    const needsInvoicingRows = applyBillingStatusFilter(completedRows, "missing_invoice");
    for (const row of needsInvoicingRows) {
      const appt = apptById.get(row.appointmentId);
      if (!appt) continue;
      entryFor(appt).issues.push({ kind: "needs_invoicing", label: NEEDS_INVOICE_LABEL });
    }
    const paymentOutstandingRows = applyBillingStatusFilter(completedRows, "invoiced_unpaid");
    for (const row of paymentOutstandingRows) {
      const appt = apptById.get(row.appointmentId);
      if (!appt) continue;
      entryFor(appt).issues.push({ kind: "payment_outstanding", label: NEEDS_PAYMENT_LABEL });
    }
  }

  // 3. Failed messages -- the caller has already classified these via
  // classifyMessageStatus and counted them per appointment; this function
  // only groups them onto the same per-appointment entry as issues 1/2.
  for (const [appointmentId, count] of failedMessageCountsByAppointmentId) {
    const appt = apptById.get(appointmentId);
    if (!appt) continue; // only appointments within the already-scoped range are considered
    if (count <= 0) continue;
    entryFor(appt).issues.push({ kind: "failed_message", label: failedMessageLabel(count) });
  }

  // Oldest scheduledFor first, matching this app's other review-style
  // lists (buildReviewNeededRows/buildCompletedJobRows) -- the longest-
  // unresolved item surfaces first, not buried under newer ones.
  // appointmentId is a tiebreaker, not a business ordering: two
  // appointments can share the exact same scheduledFor (different
  // employees/services at the same instant), and the caller pages this
  // list across separate HTTP requests that each independently re-fetch
  // and re-sort -- without a deterministic tiebreaker, those appointments'
  // relative order (and therefore which page each lands on) could differ
  // between requests, duplicating or dropping an entry across pages.
  return [...byAppointmentId.values()].sort(
    (a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.appointmentId.localeCompare(b.appointmentId)
  );
}
