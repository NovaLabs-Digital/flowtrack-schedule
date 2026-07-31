import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllPages } from "@/lib/paginate";
import EmployeeSchedule from "@/app/components/schedule/EmployeeSchedule";
import { computePayrollRows, toDateInputValue } from "@/lib/payroll";
import { nowInBusinessTz } from "@/lib/timezone";
import type { Appointment, EmployeeHours, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { fetchEntitlementForWorkspace } from "@/lib/entitlementServer";
import { projectEntitlementForEmployee } from "@/lib/entitlementView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Monday of the week `offsetWeeks` from this week (0 = this week, -1 = last week).
function mondayOfWeek(offsetWeeks: number): Date {
  const d = nowInBusinessTz();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff + offsetWeeks * 7);
  return d;
}

// PostgREST has previously failed outright (oversized query string, not a
// graceful error) on a single .in() call with several hundred UUIDs -- see
// the appointment_employee_hours fix in app/dashboard/page.tsx. Fetching
// this employee's own assigned appointments in bounded chunks avoids that
// failure mode regardless of how large one employee's own assignment
// history grows over time.
const APPOINTMENT_ID_CHUNK_SIZE = 150;

export default async function SchedulePage() {
  const session = await getSession();

  if (session.role !== "employee") {
    redirect("/login");
  }

  const employeeId = session.employeeId;
  const workspaceId = session.workspaceId;

  // Phase 5.6E: resolved BEFORE any employee/appointment/client data query,
  // not after. Approved policy: "Employees lose access when the trial or
  // paid entitlement ends; employees do not receive the owner's read-only
  // grace" -- hasOperationalAccess is false for BOTH canceled_read_only and
  // canceled_locked (and every other restricted reason), so an employee is
  // denied the moment the OWNER's full access ends, not 30 days later. This
  // is a plain boolean check, not a second policy -- the same canonical
  // resolver every server-side capability gate already uses.
  const entitlementResult = await fetchEntitlementForWorkspace(workspaceId);
  if (!entitlementResult.hasOperationalAccess) {
    return (
      <div className="min-h-[100dvh] bg-slate-50 flex items-center justify-center px-6">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center">
          <div className="text-sm font-semibold text-slate-900">Access unavailable</div>
          <div className="mt-2 text-xs text-slate-500 leading-relaxed">
            Your access is currently unavailable. Please contact your business owner for assistance.
          </div>
        </div>
      </div>
    );
  }

  const { data: employee, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id, name, color, active, phone, position")
    .eq("id", employeeId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (empErr || !employee || !employee.active) {
    redirect("/login");
  }

  // Phase 5.7D-R18: appointment_employees (not appointments.employee_id) is
  // the authoritative source for "which jobs are mine" -- a shared
  // appointment with two or more assigned employees would otherwise never
  // appear here at all, since appointments.employee_id is NULL for any
  // appointment with anything other than exactly one assignment (see
  // lib/appointmentEmployees.ts's deriveLegacyEmployeeId). Paginated for
  // the same reason as app/dashboard/page.tsx: an unbounded, long-tenured
  // employee's assignment history isn't date-windowed here and can grow
  // past PostgREST's default 1000-row response cap over time.
  const assignRes = await fetchAllPages<AppointmentEmployeeAssignment>(async (from, to) =>
    supabaseAdmin
      .from("appointment_employees")
      .select("id, appointment_id, employee_id, actual_started_at, actual_completed_at, created_at, updated_at")
      .eq("employee_id", employeeId)
      .eq("workspace_id", workspaceId)
      .order("appointment_id", { ascending: true })
      .range(from, to)
  );
  if (assignRes.error) {
    console.error("SCHEDULE_ASSIGNMENTS_FETCH_ERROR", assignRes.error.message);
  }
  const myAssignments = assignRes.data ?? [];
  const assignmentByApptId = new Map(myAssignments.map((a) => [a.appointment_id, a]));
  const assignedApptIds = myAssignments.map((a) => a.appointment_id);

  let appts: Appointment[] = [];
  let apptsFetchFailed = false;
  for (let i = 0; i < assignedApptIds.length; i += APPOINTMENT_ID_CHUNK_SIZE) {
    const chunk = assignedApptIds.slice(i, i + APPOINTMENT_ID_CHUNK_SIZE);
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, service_type, scheduled_for, scheduled_end, status, notes, duration_minutes, actual_started_at, actual_completed_at, employee_id")
      .in("id", chunk)
      .eq("workspace_id", workspaceId)
      .eq("status", "scheduled");
    if (error) {
      console.error("SCHEDULE_APPOINTMENTS_FETCH_ERROR", error.message);
      apptsFetchFailed = true;
      continue;
    }
    appts.push(...((data ?? []) as Appointment[]));
  }
  if (apptsFetchFailed) appts = [];

  // Each appointment's actual_started_at/actual_completed_at is overwritten
  // here with THIS employee's own assignment timestamps -- never the
  // appointment-level (legacy, frozen as of this phase) columns, and never
  // another assigned employee's. EmployeeSchedule.tsx already treats these
  // two fields purely as "my own job-tracking state" (it seeds its local
  // jobTimes state from them once, then only ever updates from the job
  // route's own response) -- populating them from the correct per-employee
  // source here is the only change needed to make that existing logic
  // correct for a shared, multi-employee appointment.
  appts = appts
    .map((a) => {
      const mine = assignmentByApptId.get(a.id);
      return {
        ...a,
        actual_started_at: mine?.actual_started_at ?? null,
        actual_completed_at: mine?.actual_completed_at ?? null,
      };
    })
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  const clientIds = [...new Set(appts.map((a) => a.client_id))];
  // Client phone is intentionally not selected here — employees call the
  // office (see officePhone below), not the client, by default.
  const clients: Record<string, { name: string; address: string | null }> = {};

  if (clientIds.length > 0) {
    const { data: clientRows } = await supabaseAdmin
      .from("clients")
      .select("id, name, address")
      .eq("workspace_id", workspaceId)
      .in("id", clientIds);

    for (const c of clientRows ?? []) {
      clients[c.id] = { name: c.name, address: c.address };
    }
  }

  const services: Record<string, string> = {};
  try {
    // Employees only ever work for the real business, never the demo
    // experience — is_demo=false is explicit here, not tied to a role
    // check, since this fixes a real bug where real and demo service
    // colors were previously mixed together with no filter at all.
    const { data: svcRows } = await supabaseAdmin
      .from("services")
      .select("name, color")
      .eq("workspace_id", workspaceId)
      .eq("is_demo", false);
    for (const s of svcRows ?? []) {
      if (s.color) services[s.name] = s.color;
    }
  } catch {}

  let officePhone: string | null = null;
  try {
    const { data: companyRow } = await supabaseAdmin
      .from("company_settings")
      .select("phone")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    officePhone = companyRow?.phone ?? null;
  } catch {}

  let employeeHours: EmployeeHours[] = [];
  try {
    const { data: hoursRows } = await supabaseAdmin
      .from("appointment_employee_hours")
      .select("id, appointment_id, employee_id, hours_worked, note, created_at, updated_at")
      .eq("employee_id", employeeId)
      .eq("workspace_id", workspaceId);
    employeeHours = hoursRows ?? [];
  } catch {}

  const thisWeekStart = mondayOfWeek(0);
  const thisWeekEnd = addDays(thisWeekStart, 6);
  const lastWeekStart = mondayOfWeek(-1);
  const lastWeekEnd = addDays(lastWeekStart, 6);

  const employeesForCalc = [{ id: employee.id, name: employee.name, phone: employee.phone ?? null, color: employee.color, active: employee.active }];

  const thisWeek = computePayrollRows({
    appointments: appts,
    employees: employeesForCalc,
    employeeHours,
    assignments: myAssignments,
    rangeStart: toDateInputValue(thisWeekStart),
    rangeEnd: toDateInputValue(thisWeekEnd),
  });
  const lastWeek = computePayrollRows({
    appointments: appts,
    employees: employeesForCalc,
    employeeHours,
    assignments: myAssignments,
    rangeStart: toDateInputValue(lastWeekStart),
    rangeEnd: toDateInputValue(lastWeekEnd),
  });

  // entitlementResult was already resolved at the top of this component,
  // before any query ran -- reaching this point already proves
  // hasOperationalAccess is true. Projected to the employee-only shape (see
  // lib/entitlementView.ts) -- an employee prop never carries
  // recoveryAction, bannerVariant, or any billing-state distinction, only
  // whether job tracking is currently available.
  const entitlement = projectEntitlementForEmployee(entitlementResult);

  return (
    <EmployeeSchedule
      employee={{ id: employee.id, name: employee.name, color: employee.color, position: employee.position ?? null }}
      appointments={appts}
      clients={clients}
      serviceColors={services}
      officePhone={officePhone}
      thisWeekHours={thisWeek.rows[0]?.hoursWorked ?? 0}
      lastWeekHours={lastWeek.rows[0]?.hoursWorked ?? 0}
      entitlement={entitlement}
    />
  );
}
