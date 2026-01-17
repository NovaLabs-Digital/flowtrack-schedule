"use client";

import { useState } from "react";

export default function BookPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    service_type: "Estimate",
    scheduled_for: "",
    notes: "",
  });
  const [status, setStatus] = useState("");

    async function submit() {
  setStatus("Booking...");

  const res = await fetch("/api/appointments/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(form),
  });

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error("BOOK_ERROR", res.status, data);
    setStatus(data?.error || `Request failed (${res.status})`);
    return;
  }

  setStatus("Booked! Confirmation sent.");
}


  return (
    <main className="max-w-xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Book a Service</h1>

      <div className="space-y-3">
        <input className="border p-2 w-full" placeholder="Name"
          value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

        <input className="border p-2 w-full" placeholder="Email"
          value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />

        <input className="border p-2 w-full" placeholder="Phone (+1...)"
          value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />

        <select className="border p-2 w-full"
          value={form.service_type}
          onChange={(e) => setForm({ ...form, service_type: e.target.value })}>
          <option>Estimate</option>
          <option>Install</option>
          <option>Repair</option>
          <option>Consultation</option>
        </select>

        <label className="block text-sm">
          Date & time
          <input className="border p-2 w-full" type="datetime-local"
            onChange={(e) => {
              const iso = e.target.value ? new Date(e.target.value).toISOString() : "";
              setForm({ ...form, scheduled_for: iso });
            }} />
        </label>

        <textarea className="border p-2 w-full" placeholder="Notes (optional)"
          value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />

        <button className="bg-black text-white px-4 py-2 rounded" onClick={submit}>
          Book
        </button>

        {status && <p className="text-sm">{status}</p>}
      </div>
    </main>
  );
}
