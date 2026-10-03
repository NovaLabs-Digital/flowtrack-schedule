export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { fetchAllPages } from "@/lib/paginate";
import { effectiveTimezone, zonedDateTimeToUTC } from "@/lib/timezone";
import { buildCompletedJobRows, buildReviewNeededRows, type CompletedJobBilling, type BillableAppointment } from "@/lib/completedJobBilling";
import { fetchEmployeeHoursForAppointments } from "@/lib/appointmentEmployees";
import type { AppointmentEmployeeAssignment, Client, EmployeeHours } from "@/app/components/dashboard/types";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Day-only arithmetic on a "YYYY-MM-DD" string -- plain local-calendar math
// (matches lib/payroll.ts's toDateInputValue's own getFullYear/getMonth/
// getDate style), never timezone-aware: this is only used to compute the
// EXCLUSIVE end-of-range boundary date, one calendar day past rangeEnd,
// before that date is itself resolved through zonedDateTimeToUTC below.
function addOneDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// GET /api/billing/completed-jobs?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Date-range-scoped by design (per the approved plan: "dedicated date-
// range-scoped API fetched only when the Billing panel opens," never part
// of the normal dashboard initial payload) -- this route is never called
// without a range, and the range is resolved to real UTC instant bounds
// via the workspace's own timezone before ever querying `appointments`, so
// it can never silently fetch the whole table the way an unscoped query
// would (see fetchAllPages's own doc comment on why that already bit this
// app once, for the unscoped dashboard appointments query).
export async function GET(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;
    const isTester = session.role === "tester";

    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const url = new URL(req.url);
    const rangeStart = url.searchParams.get("start") || "";
    const rangeEnd = url.searchParams.get("end") || "";
    if (!DATE_RE.test(rangeStart) || !DATE_RE.test(rangeEnd)) {
      return json({ error: "start and end must be dates in YYYY-MM-DD format" }, 400);
    }
    if (rangeStart > rangeEnd) {
      return json({ error: "start must not be after end" }, 400);
    }

    // Same source as every other dashboard card's date-range bucketing
    // (app/dashboard/page.tsx) -- the workspace's own saved timezone,
    // safely defaulted when unset, never the server/browser's ambient zone.
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

    const lowerBound = zonedDateTimeToUTC(rangeStart, "00:00", timezone);
    const upperBoundExclusive = zonedDateTimeToUTC(addOneDay(rangeEnd), "00:00", timezone);
    if (!lowerBound.ok || !upperBoundExclusive.ok) {
      return json({ error: "Invalid date range" }, 400);
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

    if (apptIds.length > 0) {
      // employeeHours (appointment_employee_hours): owner-approved
      // worked-time corrections. These can resolve an employee's otherwise-
      // missing Job Tracking for billing purposes -- see
      // lib/completedJobBilling.ts's and lib/payroll.ts's
      // isAppointmentBillingEligible doc comments. Fetched via the same
      // shared helper app/api/appointments/employee-hours/route.ts and
      // manage-recurrence already use, bounded by this route's own date
      // range (apptIds here is never the full all-time appointment list).
      const [assignRes, billingRes, hours] = await Promise.all([
        supabaseAdmin
          .from("appointment_employees")
          .select("id, appointment_id, employee_id, actual_started_at, actual_completed_at, job_notes, created_at, updated_at")
          .eq("workspace_id", workspaceId)
          .in("appointment_id", apptIds),
        supabaseAdmin
          .from("completed_job_billing")
          .select("id, workspace_id, appointment_id, client_id, invoice_number, paid, payment_method, created_at, updated_at")
          .eq("workspace_id", workspaceId)
          .in("appointment_id", apptIds),
        fetchEmployeeHoursForAppointments(apptIds, workspaceId),
      ]);
      if (assignRes.error) throw assignRes.error;
      if (billingRes.error) throw billingRes.error;
      assignments = (assignRes.data ?? []) as AppointmentEmployeeAssignment[];
      billingRows = (billingRes.data ?? []) as CompletedJobBilling[];
      employeeHours = hours;

      const clientIds = [...new Set(appointments.map((a) => a.client_id))];
      const clientsRes = await supabaseAdmin
        .from("clients")
        .select("id, name, email, phone")
        .eq("workspace_id", workspaceId)
        .eq("is_demo", isTester)
        .in("id", clientIds);
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

    const completed = buildCompletedJobRows({
      appointments,
      clients,
      assignmentsByAppointmentId,
      billingByAppointmentId,
      employeeHours,
      rangeStart,
      rangeEnd,
      timezone,
    });
    const reviewNeeded = buildReviewNeededRows({
      appointments,
      clients,
      assignmentsByAppointmentId,
      employeeHours,
      rangeStart,
      rangeEnd,
      timezone,
    });

    return json({ completed, reviewNeeded, timezone });
  } catch (e: any) {
    console.error("BILLING_COMPLETED_JOBS_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
