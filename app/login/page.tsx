"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }

    setLoading(true);
    // Auth will be wired to Supabase Auth later.
    // For now, allow access to the dashboard for demos.
    setTimeout(() => {
      router.push("/dashboard");
    }, 500);
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Nav */}
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </Link>
          <Link
            href="/"
            className="text-xs text-slate-500 hover:text-slate-700 transition-colors"
          >
            &#8592; Back to Home
          </Link>
        </div>
      </nav>

      {/* Login card */}
      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="text-center mb-6">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-[#0f172a] text-white text-sm font-bold mx-auto">
                FTS
              </div>
              <h1 className="mt-4 text-lg font-semibold text-slate-900">Welcome back</h1>
              <p className="mt-1 text-xs text-slate-500">Sign in to Schedule FlowTrack</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="you@company.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Enter your password"
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
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <div className="mt-6 text-center">
              <Link
                href="/dashboard"
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                Continue to Dashboard &#8594;
              </Link>
            </div>
          </div>

          <div className="mt-6 text-center text-xs text-slate-500">
            Powered by Nova Labs Digital
          </div>
        </div>
      </div>
    </div>
  );
}
