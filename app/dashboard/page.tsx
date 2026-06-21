import { supabaseAdmin } from "@/lib/supabaseAdmin";
import DashboardShell from "@/app/components/dashboard/DashboardShell";

export const runtime = "nodejs";

export default async function DashboardPage() {
  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from("clients")
    .select("id, name, email, phone")
    .order("name", { ascending: true });

  const { data: appointments, error: apptsErr } = await supabaseAdmin
    .from("appointments")
    .select("id, client_id, service_type, scheduled_for, status, notes")
    .order("scheduled_for", { ascending: true });

  let services: any[] = [];
  try {
    const svcRes = await supabaseAdmin
      .from("services")
      .select("id, name, description, duration_minutes, active")
      .eq("active", true)
      .order("name", { ascending: true });
    if (!svcRes.error) services = svcRes.data ?? [];
  } catch {
    // services table may not exist yet
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
    />
  );
}
