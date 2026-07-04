"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function CancelPageInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || "";
  const [status, setStatus] = useState("");

  async function doCancel() {
    setStatus("Cancelling...");
    const res = await fetch("/api/appointments/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!res.ok) return setStatus(data?.error || "Failed");
    setStatus("Cancelled. A confirmation message was sent.");
  }

  return (
    <main className="max-w-xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Cancel Appointment</h1>
      {!token ? (
        <p>Missing token.</p>
      ) : (
        <>
          <p>Click confirm to cancel your appointment.</p>
          <button className="bg-black text-white px-4 py-2 rounded" onClick={doCancel}>
            Confirm Cancel
          </button>
          {status && <p className="text-sm">{status}</p>}
        </>
      )}
    </main>
  );
}

export default function CancelPage() {
  return (
    <Suspense fallback={null}>
      <CancelPageInner />
    </Suspense>
  );
}
