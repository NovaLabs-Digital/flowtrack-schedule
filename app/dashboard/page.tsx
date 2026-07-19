import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession } from "@/lib/session";
import DashboardShell from "@/app/components/dashboard/DashboardShell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  // middleware.ts already redirects anything but owner/tester away from
  // /dashboard — this is defense-in-depth (and lets workspaceId narrow
  // cleanly below) rather than the primary gate.
  if (session.role !== "owner" && session.role !== "tester") {
    redirect("/login");
  }
  const isTester = session.role === "tester";
  const workspaceId = session.workspaceId;

  let clientFields = "id, name, email, phone, archived_at, address, client_since, referred_by, status, notes, preferred_contact_method, auto_email, auto_sms";
  let clientsRes = await supabaseAdmin
    .from("clients")
    .select(clientFields)
    .eq("workspace_id", workspaceId)
    .eq("is_demo", isTester)
    .order("name", { ascending: true });

  if (clientsRes.error) {
    clientFields = "id, name, email, phone";
    clientsRes = await supabaseAdmin
      .from("clients")
      .select(clientFields)
      .eq("workspace_id", workspaceId)
      .eq("is_demo", isTester)
      .order("name", { ascending: true });
  }

  const clients = clientsRes.data as any[] | null;
  const clientsErr = clientsRes.error;

  let apptFields = "id, client_id, service_type, scheduled_for, status, notes, duration_minutes, scheduled_end, series_id, frequency_type, repeat_weeks, employee_id, actual_started_at, actual_completed_at";
  let apptsRes = await supabaseAdmin
    .from("appointments")
    .select(apptFields)
    .eq("workspace_id", workspaceId)
    .eq("is_demo", isTester)
    .order("scheduled_for", { ascending: true });

  if (apptsRes.error) {
    apptFields = "id, client_id, service_type, scheduled_for, status, notes";
    apptsRes = await supabaseAdmin
      .from("appointments")
      .select(apptFields)
      .eq("workspace_id", workspaceId)
      .eq("is_demo", isTester)
      .order("scheduled_for", { ascending: true });
  }

  const appointments = apptsRes.data as any[] | null;
  const apptsErr = apptsRes.error;

  let services: any[] = [];
  try {
    const svcRes = await supabaseAdmin
      .from("services")
      .select("id, name, description, duration_minutes, active, color")
      .eq("active", true)
      .eq("workspace_id", workspaceId)
      .eq("is_demo", isTester)
      .order("name", { ascending: true });
    if (!svcRes.error) services = svcRes.data ?? [];
  } catch {
    // services table may not exist yet
  }

  let employees: any[] = [];
  try {
    const empRes = await supabaseAdmin
      .from("employees")
      .select("id, name, phone, color, active")
      .eq("workspace_id", workspaceId)
      .eq("is_demo", isTester)
      .order("name", { ascending: true });
    if (!empRes.error) employees = empRes.data ?? [];
  } catch {
    // employees table may not exist yet
  }

  let employeeHours: any[] = [];
  try {
    const apptIds = (appointments ?? []).map((a) => a.id);
    if (apptIds.length > 0) {
      const hoursRes = await supabaseAdmin
        .from("appointment_employee_hours")
        .select("id, appointment_id, employee_id, hours_worked, note, created_at, updated_at")
        .eq("workspace_id", workspaceId)
        .in("appointment_id", apptIds);
      if (!hoursRes.error) employeeHours = hoursRes.data ?? [];
    }
  } catch {
    // appointment_employee_hours table may not exist yet
  }

  if (clientsErr || apptsErr) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="rounded-2xl border bg-white p-6 shadow-sm text-center">
          <div className="text-sm font-semibold text-red-600">Failed to load data</div>
          <div className="mt-2 text-xs text-slate-500">
            {clientsErr?.message || apptsErr?.message}
          </div>
        </div>
      </div>
    );
  }

  return (
    <DashboardShell
      clients={clients ?? []}
      appointments={appointments ?? []}
      services={services ?? []}
      employees={employees ?? []}
      employeeHours={employeeHours}
      isTester={isTester}
    />
  );
}
