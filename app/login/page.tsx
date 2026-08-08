"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { resolvePostLoginNavigation, type LoginRole } from "@/lib/loginNavigation";
import PasswordInput from "@/app/components/PasswordInput";

type WorkspaceChoice = { selectionId: string; companyName: string };

export default function LoginPage() {
  const router = useRouter();
  const [role, setRole] = useState<LoginRole>("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Set only when a single password matched more than one active employee
  // row for the same normalized email (see app/api/auth/login/route.ts) --
  // renders the workspace picker below in place of the normal form. Never
  // holds a workspace/employee id, only what the login response itself
  // returned: an opaque selectionId per choice and its company name.
  const [workspaceChoices, setWorkspaceChoices] = useState<WorkspaceChoice[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const selectingRef = useRef(false);
  // Phase 5.7D-R10-R2: a synchronous guard, not React state. `loading`
  // (state) only disables the submit button after a re-render commits --
  // two events dispatched within the same tick (a very fast double-click,
  // or an Enter-key press racing a click) can both enter handleSubmit
  // before that re-render happens. A ref is read/written synchronously,
  // with no dependency on the render cycle, so it blocks a second
  // concurrent invocation immediately, guaranteeing at most one in-flight
  // login request no matter how the two triggering events are timed.
  const submittingRef = useRef(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (submittingRef.current) return;

    setError("");

    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }

    submittingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
          ...(role === "employee" ? { role: "employee" } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || "Login failed.");
        return;
      }

      // The password matched more than one active workspace's employee
      // row -- stay on this page and let the employee pick which company
      // to enter, rather than treating this as a normal navigable outcome.
      // Checked before resolvePostLoginNavigation (which has no concept of
      // this in-page step and is not modified to add one -- see that
      // module's own scope).
      if (data?.next === "select_workspace" && Array.isArray(data.choices)) {
        setWorkspaceChoices(data.choices);
        return;
      }

      // Phase 5.7D: a correct owner password now only advances to an MFA
      // step — sft_session is never issued from this request. Employee
      // login is unaffected (data.next is never present on that response).
      //
      // Phase 5.7D-R10-R2: the dispatch decision itself now lives in
      // lib/loginNavigation.ts (a plain, non-JSX module the test runner
      // can import and call directly with real inputs) — this is the
      // single call site that acts on it. See that module for the full
      // allowlist/fail-closed reasoning.
      const decision = resolvePostLoginNavigation(data, role);
      if (decision.type === "fail-closed") {
        setError("Something went wrong finishing sign-in. Please try again.");
        return;
      }
      router.push(decision.path);
      return;
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
      submittingRef.current = false;
    }
  }

  async function handleSelectWorkspace(selectionId: string) {
    if (selectingRef.current) return;
    selectingRef.current = true;
    setSelecting(true);
    setError("");
    try {
      const res = await fetch("/api/auth/employee/select-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || "Unable to complete sign-in. Please log in again.");
        setWorkspaceChoices(null);
        return;
      }
      router.push(data?.redirect || "/schedule");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSelecting(false);
      selectingRef.current = false;
    }
  }

  function switchRole(r: LoginRole) {
    setRole(r);
    setEmail("");
    setPassword("");
    setError("");
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
              <h1 className="mt-4 text-lg font-semibold text-slate-900">Welcome back</h1>
              <p className="mt-1 text-xs text-slate-500">Sign in to Schedule FlowTrack</p>
            </div>

            {workspaceChoices ? (
              // A single password matched more than one active workspace's
              // employee row for this email -- no session exists yet. Each
              // choice carries only an opaque selectionId and a company
              // name (never a workspace/employee id); selecting one is the
              // only way this screen can proceed.
              <div className="space-y-3">
                <p className="text-xs text-slate-500 text-center">
                  This email is used by more than one company. Choose which one to sign in to.
                </p>
                <div className="space-y-2">
                  {workspaceChoices.map((choice) => (
                    <button
                      key={choice.selectionId}
                      type="button"
                      disabled={selecting}
                      onClick={() => handleSelectWorkspace(choice.selectionId)}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-900 text-left hover:bg-slate-50 disabled:opacity-50 transition-colors"
                    >
                      {choice.companyName}
                    </button>
                  ))}
                </div>
                {error && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {error}
                  </div>
                )}
                <button
                  type="button"
                  disabled={selecting}
                  onClick={() => {
                    setWorkspaceChoices(null);
                    setError("");
                  }}
                  className="w-full text-center text-xs text-slate-500 hover:text-slate-700 transition-colors disabled:opacity-50"
                >
                  ← Back to login
                </button>
              </div>
            ) : (
              <>
                {/* Role toggle */}
                <div className="flex bg-slate-100 rounded-xl p-1 mb-6">
                  <button
                    type="button"
                    onClick={() => switchRole("owner")}
                    className={[
                      "flex-1 rounded-lg py-2 text-sm font-medium transition-colors",
                      role === "owner" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
                    ].join(" ")}
                  >
                    Owner
                  </button>
                  <button
                    type="button"
                    onClick={() => switchRole("employee")}
                    className={[
                      "flex-1 rounded-lg py-2 text-sm font-medium transition-colors",
                      role === "employee" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
                    ].join(" ")}
                  >
                    Employee
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder={role === "employee" ? "your@email.com" : "you@company.com"}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Password</label>
                    <PasswordInput
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
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
                    {loading ? "Signing in..." : role === "employee" ? "Sign In as Employee" : "Sign In"}
                  </button>
                </form>
              </>
            )}
          </div>

          <div className="mt-6 text-center text-xs text-slate-500 safe-area-bottom">
            <div>
              New to ScheduleFlowTrack?{" "}
              <Link href="/signup" className="text-blue-600 hover:text-blue-700 font-medium">
                Create an account
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
