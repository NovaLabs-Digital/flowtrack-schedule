import { supabaseAdmin } from "@/lib/supabaseAdmin";
export const runtime = "nodejs";

export default async function AdminAppointmentsPage() {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id, service_type, scheduled_for, status, clients(name, email, phone)")
    .order("scheduled_for", { ascending: true })
    .limit(200);

  if (error) {
    return (
      <main className="max-w-5xl mx-auto p-6">
        <h1 className="text-2xl font-semibold">Appointments</h1>
        <p className="text-red-600 mt-4">Error: {error.message}</p>
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Appointments</h1>

      <div className="border rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="p-2 text-left">When</th>
              <th className="p-2 text-left">Client</th>
              <th className="p-2 text-left">Service</th>
              <th className="p-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).map((a: any) => (
              <tr key={a.id} className="border-b">
                <td className="p-2">{new Date(a.scheduled_for).toLocaleString()}</td>
                <td className="p-2">
                  <div className="font-medium">{a.clients?.name}</div>
                  <div className="opacity-70">{a.clients?.email || a.clients?.phone}</div>
                </td>
                <td className="p-2">{a.service_type}</td>
                <td className="p-2">{a.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
