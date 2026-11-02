"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import RecoveryCodesNotice from "@/app/components/RecoveryCodesNotice";

export default function MfaChallengePage() {
  return (
    <Suspense fallback={null}>
      <MfaChallengeForm />
    </Suspense>
  );
}

function MfaChallengeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const factorIds = (searchParams.get("factors") || "").split(",").filter(Boolean);
  const multipleFactors = factorIds.length > 1;
  // Migration 045: ?purpose= marks a Sign-in Security change (turning
  // two-step off, new recovery codes) rather than signing in; ?recover=1
  // means a recovery code is required (no authenticator is set up).
  const securityChange = searchParams.get("purpose") !== null;
  const recoverOnly = searchParams.get("recover") === "1";
  const [mode, setMode] = useState<"code" | "recovery">(recoverOnly ? "recovery" : "code");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState<{ codes: string[]; destination: string } | null>(null);

  const [selectedFactorId, setSelectedFactorId] = useState(factorIds[0] || "");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setVerifying(true);
    try {
      const res = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          trustDevice,
          ...(selectedFactorId ? { factorId: selectedFactorId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Invalid code. Please try again.");
        return;
      }
      if (Array.isArray(data.recoveryCodes)) {
        setDone({ codes: data.recoveryCodes, destination: data.redirect || "/dashboard" });
        return;
      }
      router.push(data.redirect || "/dashboard");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  // A Settings change abandoned here is cancelled (releasing its lock), not
  // left to expire.
  async function cancelChange() {
    await fetch("/api/auth/security", { method: "DELETE" }).catch(() => {});
    window.location.assign("/dashboard");
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setVerifying(true);
    try {
      const res = await fetch("/api/auth/mfa/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: recoveryCode.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "That recovery code or password isn't correct.");
        return;
      }
      router.push("/mfa/enroll");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col safe-area-top safe-area-left safe-area-right">
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-2.5">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
            FTS
          </div>
          <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
        </div>
      </nav>

      <div className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            {done ? (
              <RecoveryCodesNotice codes={done.codes} destination={done.destination} />
            ) : mode === "recovery" ? (
              <form onSubmit={handleRecover} className="space-y-4">
                <div className="text-center mb-2">
                  <h1 className="text-lg font-semibold text-slate-900">Use a recovery code</h1>
                  <p className="mt-1 text-xs text-slate-500">
                    Enter one of your saved recovery codes and your password. Your old authenticator will be removed and
                    you&apos;ll set up a new one.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Recovery code</label>
                  <input
                    type="text"
                    autoComplete="off"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-center font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    maxLength={24}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
                <button
                  type="submit"
                  disabled={verifying}
                  className="w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {verifying ? "Checking..." : "Continue"}
                </button>
                {!recoverOnly && (
                  <button type="button" onClick={() => { setMode("code"); setError(""); }} className="w-full text-xs font-medium text-blue-600 hover:text-blue-700">
                    Use my authenticator instead
                  </button>
                )}
              </form>
            ) : (
            <>
            <div className="text-center mb-6">
              <h1 className="text-lg font-semibold text-slate-900">{securityChange ? "Confirm it's you" : "Enter your code"}</h1>
              <p className="mt-1 text-xs text-slate-500">Open your authenticator app for the current six-digit code.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {multipleFactors && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Authenticator</label>
                  <select
                    value={selectedFactorId}
                    onChange={(e) => setSelectedFactorId(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    {factorIds.map((id, i) => (
                      <option key={id} value={id}>
                        Authenticator {i + 1}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Six-digit code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="000000"
                  maxLength={6}
                />
              </div>

              {!securityChange && (
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
                  <span>Keep me signed in on this device for 30 days</span>
                </label>
              )}

              {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={verifying}
                className="w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
              >
                {verifying ? "Verifying..." : "Verify"}
              </button>
              {!securityChange && (
                <button type="button" onClick={() => { setMode("recovery"); setError(""); }} className="w-full text-xs font-medium text-blue-600 hover:text-blue-700">
                  Lost your authenticator? Use a recovery code
                </button>
              )}
            </form>
            </>
            )}
          </div>
          <div className="mt-6 text-center text-xs text-slate-500">
            {securityChange ? (
              <button type="button" onClick={cancelChange} className="hover:text-slate-700 transition-colors">
                Cancel
              </button>
            ) : (
              <Link href="/login" className="hover:text-slate-700 transition-colors">
                Back to sign in
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
