import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllPages } from "@/lib/paginate";
import EmployeeSchedule from "@/app/components/schedule/EmployeeSchedule";
import { computePayrollRows, toDateInputValue } from "@/lib/payroll";
import { nowInBusinessTz } from "@/lib/timezone";
import type { Appointment, EmployeeHours } from "@/app/components/dashboard/types";

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

export default async function SchedulePage() {
  const session = await getSession();

  if (session.role !== "employee") {
    redirect("/login");
  }

  const employeeId = session.employeeId;
  const workspaceId = session.workspaceId;

  const { data: employee, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id, name, color, active, phone, position")
    .eq("id", employeeId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (empErr || !employee || !employee.active) {
    redirect("/login");
  }

  // Paginated for the same reason as app/dashboard/page.tsx: an
  // unbounded, long-tenured employee's "scheduled" (non-cancelled) history
  // isn't date-windowed here and can grow past PostgREST's default
  // 1000-row response cap over time (the busiest real employee is already
  // at 200+). fetchAllPages (lib/paginate.ts) keeps paging until a short
  // page confirms there's nothing left, ordered by scheduled_for with `id`
  // as a tiebreaker, and fails closed rather than silently truncating.
  const apptsRes = await fetchAllPages<Appointment>(async (from, to) =>
    supabaseAdmin
      .from("appointments")
      .select("id, client_id, service_type, scheduled_for, scheduled_end, status, notes, duration_minutes, actual_started_at, actual_completed_at, employee_id")
      .eq("employee_id", employeeId)
      .eq("workspace_id", workspaceId)
      .eq("status", "scheduled")
      .order("scheduled_for", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (apptsRes.error) {
    console.error("SCHEDULE_APPOINTMENTS_FETCH_ERROR", apptsRes.error.message);
  }

  const appts = apptsRes.data ?? [];
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
    rangeStart: toDateInputValue(thisWeekStart),
    rangeEnd: toDateInputValue(thisWeekEnd),
  });
  const lastWeek = computePayrollRows({
    appointments: appts,
    employees: employeesForCalc,
    employeeHours,
    rangeStart: toDateInputValue(lastWeekStart),
    rangeEnd: toDateInputValue(lastWeekEnd),
  });

  return (
    <EmployeeSchedule
      employee={{ id: employee.id, name: employee.name, color: employee.color, position: employee.position ?? null }}
      appointments={appts}
      clients={clients}
      serviceColors={services}
      officePhone={officePhone}
      thisWeekHours={thisWeek.rows[0]?.hoursWorked ?? 0}
      lastWeekHours={lastWeek.rows[0]?.hoursWorked ?? 0}
    />
  );
}
