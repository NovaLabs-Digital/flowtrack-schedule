"use client";

import { useRef, useState } from "react";
import Link from "next/link";

export default function LiveSessionRequestPage() {
  const [purpose, setPurpose] = useState("Product demo");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const inputClass = "mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? "").trim();
    const name = field("name");
    const email = field("email");
    if (!name || !email) { setError("Please enter your name and email."); return; }
    sending.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, email: email.toLowerCase(), company: "",
          subject: "Live session request: " + purpose,
          message: ["Request: " + purpose, "Preferred time and timezone: " + (field("preferredTime") || "Flexible"), "Message: " + (field("message") || "Please contact me to arrange a live session.")].join("\n\n"),
          website: field("website"),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setError(data.error || "We couldn't send your request. Please try again."); return; }
      setSent(true);
    } catch {
      setError("We couldn't send your request. Check your connection and try again.");
    } finally { sending.current = false; setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0f172a] text-xs text-white">FTS</span>
            <span className="text-sm">Schedule FlowTrack</span>
          </Link>
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-700">Back to Home</Link>
        </div>
      </nav>
      <main className="mx-auto max-w-lg px-6 py-12 sm:py-16">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight">Request a Live Session</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">See Schedule FlowTrack with us or get help using it. Send a request and we&apos;ll contact you to arrange a time.</p>
          {sent ? (
            <div role="status" className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-medium">Request received.</p>
              <p className="mt-1">We&apos;ll contact you to arrange your live session.</p>
              <Link href="/demo" className="mt-4 inline-block font-medium text-blue-700 underline">Explore the demo while you wait</Link>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-6 space-y-4">
              <div>
                <label htmlFor="session-name" className="text-sm font-medium">Name</label>
                <input id="session-name" name="name" autoComplete="name" required maxLength={100} className={inputClass} />
              </div>
              <div>
                <label htmlFor="session-email" className="text-sm font-medium">Email</label>
                <input id="session-email" name="email" type="email" autoComplete="email" required maxLength={254} className={inputClass} />
              </div>
              <div>
                <label htmlFor="session-purpose" className="text-sm font-medium">How can we help?</label>
                <select id="session-purpose" value={purpose} onChange={e => setPurpose(e.target.value)} className={inputClass}>
                  <option>Product demo</option>
                  <option>Support</option>
                </select>
              </div>
              <div>
                <label htmlFor="session-time" className="text-sm font-medium">Preferred time <span className="font-normal text-slate-500">(optional)</span></label>
                <input id="session-time" name="preferredTime" placeholder="e.g. Tuesday afternoon, Eastern Time" maxLength={200} className={inputClass} />
              </div>
              <div>
                <label htmlFor="session-message" className="text-sm font-medium">Message <span className="font-normal text-slate-500">(optional)</span></label>
                <textarea id="session-message" name="message" rows={4} maxLength={4000} placeholder="What would you like to see or get help with?" className={inputClass} />
              </div>
              <div className="hidden" aria-hidden="true">
                <label htmlFor="session-website">Website</label>
                <input id="session-website" name="website" tabIndex={-1} autoComplete="off" />
              </div>
              {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
              <button type="submit" disabled={loading} className="w-full rounded-xl bg-[#0f172a] px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">{loading ? "Sending..." : "Request a Live Session"}</button>
              <p className="text-center text-xs text-slate-500">Sessions are arranged by appointment.</p>
              <p className="text-center text-xs text-slate-500">By submitting, you agree we may contact you about this request. <Link href="/privacy" className="underline">Privacy policy</Link></p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
