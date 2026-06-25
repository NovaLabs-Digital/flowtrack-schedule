import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import EmployeeSchedule from "@/app/components/schedule/EmployeeSchedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  const cookieStore = await cookies();
  const session = cookieStore.get("sft_session");
  const value = session?.value ?? "";

  if (!value.startsWith("employee:")) {
    redirect("/login");
  }

  const employeeId = value.replace("employee:", "");

  const { data: employee, error: empErr } = await supabaseAdmin
    .from("employees")
    .select("id, name, color, active")
    .eq("id", employeeId)
    .maybeSingle();

  if (empErr || !employee || !employee.active) {
    redirect("/login");
  }

  const { data: appointments } = await supabaseAdmin
    .from("appointments")
    .select("id, client_id, service_type, scheduled_for, scheduled_end, status, notes, duration_minutes, actual_started_at, actual_completed_at")
    .eq("employee_id", employeeId)
    .eq("status", "scheduled")
    .order("scheduled_for", { ascending: true });

  const clientIds = [...new Set((appointments ?? []).map((a: any) => a.client_id))];
  let clients: Record<string, { name: string; address: string | null; phone: string | null }> = {};

  if (clientIds.length > 0) {
    const { data: clientRows } = await supabaseAdmin
      .from("clients")
      .select("id, name, address, phone")
      .in("id", clientIds);

    for (const c of clientRows ?? []) {
      clients[c.id] = { name: c.name, address: c.address, phone: c.phone };
    }
  }

  let services: Record<string, string> = {};
  try {
    const { data: svcRows } = await supabaseAdmin
      .from("services")
      .select("name, color");
    for (const s of svcRows ?? []) {
      if (s.color) services[s.name] = s.color;
    }
  } catch {}

  return (
    <EmployeeSchedule
      employee={{ id: employee.id, name: employee.name, color: employee.color }}
      appointments={appointments ?? []}
      clients={clients}
      serviceColors={services}
    />
  );
}
