"use client";

// At-a-glance health check for the business — every value here is a real
// signal (provider credentials configured, actual DB counts), never a
// placeholder. Capped at four items on purpose: this is a health check, not
// a growing checklist.
type Props = {
  emailConfigured: boolean;
  smsConfigured: boolean;
  bookingEnabled: boolean;
  activeStaff: number;
  totalStaff: number;
};

function Chip({ good, label, sub }: { good: boolean; label: string; sub: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm">
      <span
        className={[
          "w-2 h-2 rounded-full shrink-0",
          good ? "bg-emerald-500" : "bg-amber-500",
        ].join(" ")}
      />
      <div className="min-w-0">
        <div className="text-xs font-semibold text-slate-900 truncate">{label}</div>
        <div className="text-[11px] text-slate-500 truncate">{sub}</div>
      </div>
    </div>
  );
}

export default function CompanyStatusStrip({ emailConfigured, smsConfigured, bookingEnabled, activeStaff, totalStaff }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      <Chip
        good={emailConfigured}
        label={emailConfigured ? "Email connected" : "Email not connected"}
        sub={emailConfigured ? "Confirmations can send" : "Confirmations won't send"}
      />
      <Chip
        good={smsConfigured}
        label={smsConfigured ? "SMS connected" : "SMS not connected"}
        sub={smsConfigured ? "Reminders can send" : "Reminders won't send"}
      />
      <Chip
        good={bookingEnabled}
        label={bookingEnabled ? "Public booking on" : "Public booking off"}
        sub={bookingEnabled ? "Clients can self-book" : "Booking page is hidden"}
      />
      <Chip
        good={totalStaff === 0 || activeStaff === totalStaff}
        label={`${activeStaff} of ${totalStaff} staff active`}
        sub={activeStaff === totalStaff ? "All staff active" : `${totalStaff - activeStaff} inactive`}
      />
    </div>
  );
}
