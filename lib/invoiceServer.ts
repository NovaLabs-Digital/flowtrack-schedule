// Server-side helpers shared by the invoice routes (app/api/invoices/**) and
// the direct-payment route. Every read is scoped to the caller's workspace;
// a tester session only ever reaches demo appointments (same guard as the
// Billing update route).
import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAssignments, fetchEmployeeHoursForAppointments } from "@/lib/appointmentEmployees";
import { isCompletedForBilling } from "@/lib/completedJobBilling";
import { effectiveTimezone } from "@/lib/timezone";
import { INVOICE_VIEW_COLUMNS, toInvoiceView, type InvoiceView } from "@/lib/invoices";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnedAppointment = {
  id: string;
  client_id: string;
  status: string;
  is_demo: boolean;
  service_type: string;
  scheduled_for: string;
  price_cents: number | null;
};

// The appointment, only if it belongs to this workspace (and, for a tester,
// is demo data). null = treat as not found.
export async function loadOwnedAppointment(workspaceId: string, appointmentId: string, isTester: boolean): Promise<OwnedAppointment | null> {
  if (!UUID_RE.test(appointmentId)) return null;
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id, client_id, status, is_demo, service_type, scheduled_for, price_cents")
    .eq("id", appointmentId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  const appt = data as OwnedAppointment | null;
  if (!appt) return null;
  if (isTester && !appt.is_demo) return null;
  return appt;
}

// Same completed-job rule as Billing (owner worked-time corrections count).
export async function isBillableJob(appt: OwnedAppointment, workspaceId: string): Promise<boolean> {
  if (appt.status === "cancelled") return false;
  const [assignments, hours] = await Promise.all([
    fetchAssignments(appt.id, workspaceId),
    fetchEmployeeHoursForAppointments([appt.id], workspaceId),
  ]);
  return isCompletedForBilling(appt.id, assignments, hours);
}

// The invoice (never its PDF bytes), only if it belongs to this workspace and
// its job is reachable by this session.
export async function loadInvoiceView(workspaceId: string, invoiceId: string, isTester: boolean): Promise<InvoiceView | null> {
  if (!UUID_RE.test(invoiceId)) return null;
  const { data, error } = await supabaseAdmin
    .from("invoices")
    .select(INVOICE_VIEW_COLUMNS)
    .eq("id", invoiceId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const view = toInvoiceView(data as unknown as Record<string, unknown>);
  if (isTester && !(await loadOwnedAppointment(workspaceId, view.appointment_id, true))) return null;
  return view;
}

export async function loadBillingState(workspaceId: string, appointmentId: string) {
  const { data, error } = await supabaseAdmin
    .from("completed_job_billing")
    .select("invoice_number, paid, payment_method, no_invoice_required")
    .eq("workspace_id", workspaceId)
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (error) throw error;
  return (data as { invoice_number: string | null; paid: boolean; payment_method: string | null; no_invoice_required: boolean } | null) ?? null;
}

export async function loadCompanySettings(workspaceId: string) {
  const { data, error } = await supabaseAdmin
    .from("company_settings")
    .select("company_name, address, city, state, zip, phone, email, timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    company_name: string | null; address: string | null; city: string | null; state: string | null;
    zip: string | null; phone: string | null; email: string | null; timezone: string | null;
  } | null;
  return { company: row, timezone: effectiveTimezone(row?.timezone) };
}

// bytea through PostgREST arrives as "\x<hex>"; through node-postgres as a
// Buffer.
export function byteaToBuffer(value: unknown): Buffer | null {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  return null;
}
