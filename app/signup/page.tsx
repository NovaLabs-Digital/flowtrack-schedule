"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PasswordInput from "@/app/components/PasswordInput";

const MIN_PASSWORD_LENGTH = 12;

export default function SignupPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkEmailMessage, setCheckEmailMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!companyName.trim()) {
      setError("Please enter your company name.");
      return;
    }
    if (!email.trim()) {
      setError("Please enter your email.");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    // Client-side confirm-password check only — the server never receives
    // or validates a confirmPassword field.
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (!termsAccepted) {
      setError("You must accept the Terms of Service and Privacy Policy.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: companyName.trim(),
          email: email.trim().toLowerCase(),
          password,
          termsAccepted: true,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || "Unable to create your account. Please try again.");
        return;
      }

      if (data.next === "check_email") {
        setCheckEmailMessage("Check your email for a link to verify your account and continue setup.");
        return;
      }
      if (data.next === "enroll") {
        router.push("/mfa/enroll");
        return;
      }
      if (data.next === "challenge") {
        const query = data.factorIds && data.factorIds.length > 1 ? `?factors=${data.factorIds.join(",")}` : "";
        router.push(`/mfa/challenge${query}`);
        return;
      }
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
              <h1 className="mt-4 text-lg font-semibold text-slate-900">Create your account</h1>
              <p className="mt-1 text-xs text-slate-500">Set up ScheduleFlowTrack for your business</p>
            </div>

            {checkEmailMessage ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
                {checkEmailMessage}
              </div>
            ) : (
              <>
                {/* Two-step verification explanation — shown before account
                    creation, per the approved beginner-friendly MFA copy. */}
                <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50 px-3 py-3 text-xs text-blue-900 leading-relaxed">
                  ScheduleFlowTrack uses two-step verification for business owners. After verifying your email,
                  you&apos;ll scan a QR code with an authenticator app. Have your phone nearby—setup takes about
                  one minute. On a trusted private device, you can stay signed in for 30 days.
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Company Name</label>
                    <input
                      type="text"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Your company name"
                    />
                  </div>
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
                    <PasswordInput
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Confirm Password</label>
                    <PasswordInput
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Re-enter your password"
                    />
                  </div>

                  <label className="flex items-start gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      onChange={(e) => setTermsAccepted(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      I agree to the{" "}
                      <Link href="/terms" className="text-blue-600 hover:text-blue-700">
                        Terms of Service
                      </Link>{" "}
                      and{" "}
                      <Link href="/privacy" className="text-blue-600 hover:text-blue-700">
                        Privacy Policy
                      </Link>
                      .
                    </span>
                  </label>

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
                    {loading ? "Creating account..." : "Create Account"}
                  </button>
                </form>
              </>
            )}
          </div>

          <div className="mt-6 text-center text-xs text-slate-500 safe-area-bottom">
            <div>
              Already have an account?{" "}
              <Link href="/login" className="text-blue-600 hover:text-blue-700 font-medium">
                Sign in
              </Link>
            </div>
            <div className="mt-3 flex items-center justify-center gap-3">
              <Link href="/terms" className="hover:text-slate-700 transition-colors">
                Terms of Service
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/privacy" className="hover:text-slate-700 transition-colors">
                Privacy Policy
              </Link>
              <span aria-hidden="true">·</span>
              <Link href="/contact" className="hover:text-slate-700 transition-colors">
                Contact Us
              </Link>
            </div>
            <div className="mt-2">Powered by Nova Labs Digital</div>
          </div>
        </div>
      </div>
    </div>
  );
}
