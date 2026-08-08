"use client";

import { useState } from "react";
import Link from "next/link";

// Mirrors lib/contactMessage.ts's CONTACT_FIELD_LIMITS (the server-side
// authoritative limits) -- duplicated locally rather than imported, the
// same convention app/signup/page.tsx already uses for MIN_PASSWORD_LENGTH,
// since lib/contactMessage.ts is a "server-only" module and cannot be
// imported from a client component.
const CONTACT_FIELD_LIMITS = {
  name: 100,
  email: 254,
  company: 150,
  subject: 150,
  message: 5000,
} as const;

export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  // Honeypot -- a hidden field real visitors never see or fill; a filled
  // value marks the submission as a bot for the server to silently
  // discard. Never rendered visibly, never required.
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!email.trim()) {
      setError("Please enter your email.");
      return;
    }
    if (!subject.trim()) {
      setError("Please enter a subject.");
      return;
    }
    if (!message.trim()) {
      setError("Please enter a message.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          company: company.trim(),
          subject: subject.trim(),
          message: message.trim(),
          website,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || "Unable to send your message. Please try again.");
        return;
      }

      setSent(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col safe-area-top safe-area-left safe-area-right">
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </Link>
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            ← Back to Home
          </Link>
        </div>
      </nav>

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="text-center mb-6">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-[#0f172a] text-white text-sm font-bold mx-auto">
                FTS
              </div>
              <h1 className="mt-4 text-lg font-semibold text-slate-900">Contact us</h1>
              <p className="mt-1 text-xs text-slate-500">Questions, feedback, or need a hand? We&apos;d love to hear from you.</p>
            </div>

            {sent ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
                Thanks for reaching out — we&apos;ve received your message and will get back to you soon.
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={CONTACT_FIELD_LIMITS.name}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Your name"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={CONTACT_FIELD_LIMITS.email}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="you@company.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Company <span className="text-slate-400">(optional)</span></label>
                  <input
                    type="text"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    maxLength={CONTACT_FIELD_LIMITS.company}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Your company name"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Subject</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    maxLength={CONTACT_FIELD_LIMITS.subject}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="What's this about?"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Message</label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={CONTACT_FIELD_LIMITS.message}
                    rows={5}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                    placeholder="How can we help?"
                  />
                </div>

                {/* Honeypot -- hidden from real visitors via CSS and marked
                    aria-hidden/tabIndex=-1 so assistive tech skips it too;
                    autoComplete="off" so password managers never populate
                    it for a human. Bots that blindly fill every field in
                    the DOM will fill this one. */}
                <div className="hidden" aria-hidden="true">
                  <label htmlFor="website">Website</label>
                  <input
                    type="text"
                    id="website"
                    name="website"
                    tabIndex={-1}
                    autoComplete="off"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                  />
                </div>

                {error && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {loading ? "Sending..." : "Send Message"}
                </button>
              </form>
            )}
          </div>

          <div className="mt-6 text-center text-xs text-slate-500 safe-area-bottom">
            <div className="flex items-center justify-center gap-3">
              <Link href="/terms" className="hover:text-slate-700 transition-colors">
                Terms of Service
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/privacy" className="hover:text-slate-700 transition-colors">
                Privacy Policy
              </Link>
            </div>
            <div className="mt-2">Powered by Nova Labs Digital</div>
          </div>
        </div>
      </div>
    </div>
  );
}
