import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession } from "@/lib/session";
import BookingForm from "@/app/components/book/BookingForm";

export const dynamic = "force-dynamic";

export default async function BookPage() {
  const [session, settingsRes, servicesRes] = await Promise.all([
    getSession(),
    supabaseAdmin.from("company_settings").select("booking_enabled, company_name").limit(1).maybeSingle(),
    supabaseAdmin
      .from("services")
      .select("name, description, duration_minutes")
      .eq("is_demo", false)
      .eq("active", true)
      .order("name", { ascending: true }),
  ]);

  const bookingEnabled = Boolean(settingsRes.data?.booking_enabled);
  const companyName = settingsRes.data?.company_name || "";
  const isOwnerPreview = session.role === "owner";

  if (!bookingEnabled && !isOwnerPreview) {
    return (
      <main className="max-w-xl mx-auto px-4 py-16">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">Online Booking Unavailable</h1>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            {companyName ? `${companyName} isn't` : "We aren't"} accepting online bookings right now. Please
            contact us directly to schedule your appointment.
          </p>
        </div>
      </main>
    );
  }

  return (
    <>
      {!bookingEnabled && isOwnerPreview && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs text-center py-2 px-4">
          Public booking is currently OFF — customers can&apos;t see this page. You&apos;re previewing it as the owner.
        </div>
      )}
      <BookingForm services={servicesRes.data ?? []} companyName={companyName} />
    </>
  );
}
