"use client";

import { useEffect, useState } from "react";
import SettingsCard from "@/app/components/dashboard/SettingsCard";

// Settings > Sign-in Security (migration 045), on desktop (inside the
// Company section's cards) and mobile Settings. Real owners only -- never
// rendered in a demo. Every change re-asks for the password, then continues
// on the existing verification screens; see app/api/auth/security/route.ts.

type Status = { status: "on" | "off" | "needs_setup"; codesUnused: number; codesTotal: number };
type Action = "enable" | "disable" | "codes";

const ACTION_LABEL: Record<Action, string> = {
  enable: "Turn on two-step sign-in",
  disable: "Turn off two-step sign-in",
  codes: "Create new recovery codes",
};

export default function SignInSecurityCard() {
  return (
    <SettingsCard id="sign-in-security-card" title="Sign-in Security" helper="How you sign in to your owner account. Your employees' sign-in doesn't change.">
      <SignInSecurityControls />
    </SettingsCard>
  );
}

export function SignInSecurityControls() {
  const [state, setState] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/security", { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (r.ok && (data.status === "on" || data.status === "off" || data.status === "needs_setup")) setState(data);
        else setLoadError(data?.error || "Sign-in Security is temporarily unavailable.");
      })
      .catch(() => setLoadError("Network error. Please try again."));
  }, []);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!action) return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      const factors = Array.isArray(data.factorIds) && data.factorIds.length > 0 ? `&factors=${data.factorIds.join(",")}` : "";
      window.location.assign(data.next === "enroll" ? "/mfa/enroll?purpose=enable" : `/mfa/challenge?purpose=${action}${factors}`);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <div className="text-xs text-rose-700" role="alert">{loadError}</div>;
  if (!state) return <div className="text-xs text-slate-500">Loading...</div>;

  const pill =
    state.status === "on"
      ? { text: "On", cls: "text-emerald-700 bg-emerald-50" }
      : state.status === "off"
        ? { text: "Off", cls: "text-slate-600 bg-slate-100" }
        : { text: "Setup at next sign-in", cls: "text-amber-700 bg-amber-50" };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-slate-900">Two-step sign-in</div>
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${pill.cls}`}>{pill.text}</span>
      </div>
      <p className="text-xs text-slate-600">
        {state.status === "on" && "Signing in asks for your password and a code from your authenticator app."}
        {state.status === "off" &&
          "Signing in asks for your password only, and you'll be asked to sign in again at least every 12 hours. Two-step sign-in keeps your business safe if your password is ever stolen."}
        {state.status === "needs_setup" && "You'll set up your authenticator app the next time you sign in."}
      </p>
      {state.status === "on" && (
        <p className="text-xs text-slate-600">
          {state.codesTotal === 0
            ? "You don't have recovery codes yet. Create them so you can get back in if you lose your phone."
            : `Recovery codes: ${state.codesUnused} of ${state.codesTotal} unused.`}
        </p>
      )}

      {action ? (
        <form onSubmit={start} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-900">{ACTION_LABEL[action]}</div>
          {action === "disable" && (
            <p className="text-xs text-rose-800">
              Without two-step sign-in, your password alone is enough to sign in. You&apos;ll need a code from your
              authenticator app to confirm. Your recovery codes will stop working, other devices will be signed out, and
              we&apos;ll email you.
            </p>
          )}
          {action === "codes" && (
            <p className="text-xs text-slate-600">Your current recovery codes will stop working, and other devices will be signed out.</p>
          )}
          {action === "enable" && (
            <p className="text-xs text-slate-600">You&apos;ll set up an authenticator app and save recovery codes. Other devices will be signed out.</p>
          )}
          <div>
            <label htmlFor="sign-in-security-password" className="block text-xs font-medium text-slate-600 mb-1">
              Your password
            </label>
            <input
              id="sign-in-security-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !password}
              className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {busy ? "Checking..." : "Continue"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAction(null);
                setPassword("");
                setError("");
              }}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {state.status === "off" && (
            <button type="button" onClick={() => setAction("enable")} className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors">
              Turn on
            </button>
          )}
          {state.status === "on" && (
            <>
              <button type="button" onClick={() => setAction("codes")} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
                New recovery codes
              </button>
              <button type="button" onClick={() => setAction("disable")} className="rounded-xl border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 transition-colors">
                Turn off
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
