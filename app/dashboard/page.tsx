import { supabaseAdmin } from "@/lib/supabaseAdmin";
import DashboardShell from "@/app/components/dashboard/DashboardShell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let clientFields = "id, name, email, phone, archived_at, address, client_since, referred_by, status, notes, preferred_contact_method, auto_email, auto_sms";
  let clientsRes = await supabaseAdmin
    .from("clients")
    .select(clientFields)
    .order("name", { ascending: true });

  if (clientsRes.error) {
    clientFields = "id, name, email, phone";
    clientsRes = await supabaseAdmin
      .from("clients")
      .select(clientFields)
      .order("name", { ascending: true });
  }

  const clients = clientsRes.data as any[] | null;
  const clientsErr = clientsRes.error;

  let apptFields = "id, client_id, service_type, scheduled_for, status, notes, duration_minutes, scheduled_end, series_id, frequency_type, repeat_weeks, employee_id";
  let apptsRes = await supabaseAdmin
    .from("appointments")
    .select(apptFields)
    .order("scheduled_for", { ascending: true });

  if (apptsRes.error) {
    apptFields = "id, client_id, service_type, scheduled_for, status, notes";
    apptsRes = await supabaseAdmin
      .from("appointments")
      .select(apptFields)
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
      .order("name", { ascending: true });
    if (!empRes.error) employees = empRes.data ?? [];
  } catch {
    // employees table may not exist yet
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
    />
  );
}
