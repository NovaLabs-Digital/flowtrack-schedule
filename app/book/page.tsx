import { supabaseAdmin } from "@/lib/supabaseAdmin";
import BookingForm from "@/app/components/book/BookingForm";

export const dynamic = "force-dynamic";

export default async function BookPage() {
  const { data: settings } = await supabaseAdmin
    .from("company_settings")
    .select("booking_enabled")
    .limit(1)
    .maybeSingle();

  if (!settings?.booking_enabled) {
    return (
      <main className="max-w-xl mx-auto p-6">
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm text-slate-600">
            Online booking is currently unavailable. Please contact the business directly to schedule.
          </p>
        </div>
      </main>
    );
  }

  return <BookingForm />;
}
