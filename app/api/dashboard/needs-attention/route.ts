export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { fetchAllPages } from "@/lib/paginate";
import { effectiveTimezone, zonedDateTimeToUTC, nowInBusinessTz } from "@/lib/timezone";
import { toDateInputValue } from "@/lib/payroll";
import { fetchEmployeeHoursForAppointments } from "@/lib/appointmentEmployees";
import { countUnresolvedFailedMessageGroupsByAppointment, type MessageAttemptRow } from "@/lib/messageStatus";
import { buildNeedsAttentionEntries, NEEDS_ATTENTION_LOOKBACK_DAYS, type NeedsAttentionEntry } from "@/lib/needsAttention";
import type { BillableAppointment, CompletedJobBilling } from "@/lib/completedJobBilling";
import type { AppointmentEmployeeAssignment, Client, EmployeeHours } from "@/app/components/dashboard/types";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Bounded/paginated response (see lib/needsAttention.ts's own header on the
// 60-day lookback): the lookback window alone does not bound how many
// distinct appointments can have an issue in a busy workspace, so the
// JSON payload itself is paged -- same DEFAULT/MAX shape as
// app/api/appointments/messages/route.ts. totalCount is always the full
// distinct-appointment count across every page, never just the current
// page's length, so the collapsed button's "Needs attention · N" label is
// never silently wrong just because only the first page has loaded.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Day-only arithmetic on a workspace-local Date -- same plain local-
// calendar math as app/api/billing/completed-jobs/route.ts's own addOneDay,
// generalized to N days (positive or negative) since this route needs to
// step BACKWARD from "today" by NEEDS_ATTENTION_LOOKBACK_DAYS, not forward
// by one.
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// GET /api/dashboard/needs-attention
//
// "Needs attention" (desktop sidebar control + mobile equivalent): a
// single bounded, workspace-scoped aggregation of three EXISTING
// actionable-item rules -- see lib/needsAttention.ts's own header comment
// for exactly which ones and why no new eligibility/status logic is
// invented here. Bounded to the last NEEDS_ATTENTION_LOOKBACK_DAYS days
// (never all-time history) for the same reason app/api/billing/completed-
// jobs/route.ts is date-range-scoped rather than unscoped -- see
// fetchAllPages' own doc comment on the prior incident an unbounded query
// already caused in this app. rangeStart/rangeEnd are always returned
// alongside the entries so the caller can disclose the real scope to the
// owner, rather than silently hiding older unresolved work.
export async function GET(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;
    const isTester = session.role === "tester";

    // Same read-only gate as /api/billing/completed-jobs and
    // /api/appointments/messages -- this route only ever aggregates
    // existing-data views, it mutates nothing.
    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIMIT) : DEFAULT_LIMIT;
    const offsetParam = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;
    // Destination-permission gate (server-side, authoritative): needs-
    // invoicing's only action opens Settings -> Billing, which a tester/
    // demo session can never reach (owner-only) and which has no mobile
    // destination at all (MobileSettings is a placeholder) -- the issue is
    // never generated for either case, rather than generated and hidden by
    // the client. "surface=mobile" is the mobile client's own request, not
    // an inference from role/device -- an owner viewing a resized/mobile-
    // width browser window still gets the full desktop payload.
    const isMobileSurface = url.searchParams.get("surface") === "mobile";
    const includeInvoicing = !isTester && !isMobileSurface;

    let timezone = effectiveTimezone(null);
    try {
      const { data: companyRow } = await supabaseAdmin
        .from("company_settings")
        .select("timezone")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      timezone = effectiveTimezone((companyRow as { timezone?: string | null } | null)?.timezone);
    } catch {
      // company_settings row/column may not exist yet -- fall back safely.
    }

    const todayLocal = nowInBusinessTz(timezone);
    todayLocal.setHours(0, 0, 0, 0);
    const rangeEnd = toDateInputValue(todayLocal);
    const rangeStart = toDateInputValue(addDays(todayLocal, -NEEDS_ATTENTION_LOOKBACK_DAYS));

    const lowerBound = zonedDateTimeToUTC(rangeStart, "00:00", timezone);
    const upperBoundExclusive = zonedDateTimeToUTC(toDateInputValue(addDays(todayLocal, 1)), "00:00", timezone);
    if (!lowerBound.ok || !upperBoundExclusive.ok) {
      return json({ error: "Invalid date range" }, 500);
    }

    const apptFields = "id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes, status, price_cents";
    const apptsRes = await fetchAllPages<BillableAppointment>(async (from, to) =>
      supabaseAdmin
        .from("appointments")
        .select(apptFields)
        .eq("workspace_id", workspaceId)
        .eq("is_demo", isTester)
        .gte("scheduled_for", lowerBound.iso)
        .lt("scheduled_for", upperBoundExclusive.iso)
        .order("scheduled_for", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (apptsRes.error) throw apptsRes.error;
    const appointments = (apptsRes.data ?? []) as BillableAppointment[];
    const apptIds = appointments.map((a) => a.id);

    let assignments: AppointmentEmployeeAssignment[] = [];
    let clients: Client[] = [];
    let billingRows: CompletedJobBilling[] = [];
    let employeeHours: EmployeeHours[] = [];
    let failedMessageCounts = new Map<string, number>();

    if (apptIds.length > 0) {
      // Every one of these is keyed off apptIds -- itself already bounded by
      // the 60-day window, but in a busy, long-tenured workspace apptIds
      // can still hold more IDs than fit in one PostgREST response (default
      // 1000 rows), and each of these tables can have several rows per
      // appointment (employees assigned, messages sent). An unbounded
      // single .in() query here would silently truncate rather than error
      // -- same prior incident fetchAllPages's own doc comment describes
      // for the unscoped dashboard appointments query -- so each is fetched
      // in fixed-size batches, ordered by its own `id` as a deterministic
      // tiebreaker (required by fetchAllPages' own contract: pages must
      // come back in a stable order or they can skip/overlap rows).
      const [assignRes, billingRes, hours, messagesRes] = await Promise.all([
        fetchAllPages<AppointmentEmployeeAssignment>(async (from, to) =>
          supabaseAdmin
            .from("appointment_employees")
            .select("id, appointment_id, employee_id, actual_started_at, actual_completed_at, job_notes, created_at, updated_at")
            .eq("workspace_id", workspaceId)
            .in("appointment_id", apptIds)
            .order("id", { ascending: true })
            .range(from, to)
        ),
        fetchAllPages<CompletedJobBilling>(async (from, to) =>
          supabaseAdmin
            .from("completed_job_billing")
            .select("id, workspace_id, appointment_id, client_id, invoice_number, paid, payment_method, created_at, updated_at")
            .eq("workspace_id", workspaceId)
            .in("appointment_id", apptIds)
            .order("id", { ascending: true })
            .range(from, to)
        ),
        fetchEmployeeHoursForAppointments(apptIds, workspaceId),
        // Only non-content, non-recipient columns -- never body/to_value/
        // subject (see lib/messageStatus.ts's own header on why this app
        // can never truthfully show "delivered" anyway). kind/scheduled_for/
        // created_at/id are routing/ordering metadata only, needed to group
        // retries of the exact same attempt (see
        // countUnresolvedFailedMessageGroupsByAppointment) -- this route
        // still never learns what was sent or to whom; that detail stays
        // behind the appointment-scoped Message History route, reached
        // only after the owner navigates to a specific appointment.
        fetchAllPages<MessageAttemptRow>(async (from, to) =>
          supabaseAdmin
            .from("messages_sent")
            .select("id, appointment_id, channel, kind, scheduled_for, provider_id, created_at")
            .eq("workspace_id", workspaceId)
            .in("appointment_id", apptIds)
            .order("id", { ascending: true })
            .range(from, to)
        ),
      ]);
      if (assignRes.error) throw assignRes.error;
      if (billingRes.error) throw billingRes.error;
      if (messagesRes.error) throw messagesRes.error;
      assignments = (assignRes.data ?? []) as AppointmentEmployeeAssignment[];
      billingRows = (billingRes.data ?? []) as CompletedJobBilling[];
      employeeHours = hours;

      failedMessageCounts = countUnresolvedFailedMessageGroupsByAppointment(messagesRes.data ?? []);

      const clientIds = [...new Set(appointments.map((a) => a.client_id))];
      const clientsRes = await fetchAllPages<Client>(async (from, to) =>
        supabaseAdmin
          .from("clients")
          .select("id, name, email, phone")
          .eq("workspace_id", workspaceId)
          .eq("is_demo", isTester)
          .in("id", clientIds)
          .order("id", { ascending: true })
          .range(from, to)
      );
      if (clientsRes.error) throw clientsRes.error;
      clients = (clientsRes.data ?? []) as Client[];
    }

    const assignmentsByAppointmentId = new Map<string, AppointmentEmployeeAssignment[]>();
    for (const a of assignments) {
      const list = assignmentsByAppointmentId.get(a.appointment_id);
      if (list) list.push(a);
      else assignmentsByAppointmentId.set(a.appointment_id, [a]);
    }
    const billingByAppointmentId = new Map(billingRows.map((b) => [b.appointment_id, b]));

    const allEntries: NeedsAttentionEntry[] = buildNeedsAttentionEntries({
      appointments,
      clients,
      assignmentsByAppointmentId,
      billingByAppointmentId,
      employeeHours,
      failedMessageCountsByAppointmentId: failedMessageCounts,
      rangeStart,
      rangeEnd,
      timezone,
      includeInvoicing,
    });

    // The 60-day lookback bounds the DATE range, not the ROW count -- a
    // busy workspace can still have far more distinct appointments with an
    // issue than belongs in one response. Paginated here, over the
    // already-built (and already deduplicated/grouped) in-memory list;
    // totalCount is the full count before slicing, independent of the page
    // returned, so the collapsed button's own count is always accurate
    // even before every page has been loaded.
    const totalCount = allEntries.length;
    const entries = allEntries.slice(offset, offset + limit);
    const hasMore = offset + entries.length < totalCount;

    return json({ entries, totalCount, hasMore, rangeStart, rangeEnd, timezone });
  } catch (e: any) {
    console.error("NEEDS_ATTENTION_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
