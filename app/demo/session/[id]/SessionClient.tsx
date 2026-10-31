"use client";

// Guided Demo Session page: the real Schedule FlowTrack dashboard on a
// fictional dataset shared by the host and one visitor (milestone 1: shared
// data and server-enforced control; each person navigates on their own).
//
// The demo fetch interceptor is installed in session mode at MODULE SCOPE,
// for the same reason as app/demo/DemoPageClient.tsx (child effects run
// before parent effects, so an effect-based install could let early
// requests escape): reads are answered from the synced dataset, data changes
// go to the session server, and any other /api/ call fails closed. Pages
// that lead here use full page loads, never client-side navigation, so this
// tab never carries another page's interceptor.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import DashboardShell from "@/app/components/dashboard/DashboardShell";
import SessionControlBar from "@/app/components/demo-session/SessionControlBar";
import { RestrictedWordingProvider } from "@/app/components/dashboard/restrictedWording";
import { installDemoFetchInterceptor } from "@/lib/demoLocal/fetchInterceptor";
import { DEMO_ENTITLEMENT } from "@/lib/demoLocal/fixtures/entitlement";
import { DEMO_TIMEZONE } from "@/lib/demoLocal/fixtures/generate";
import { effectiveBusinessHours } from "@/lib/businessHours";
import { createDemoSessionClient, inviteStorageKey, WATCHING_MESSAGE, type DemoRole, type DemoSessionClient, type DemoSessionState } from "@/lib/demoSession/client";
import type { EntitlementView } from "@/lib/entitlementView";

const SESSION_PATH = /^\/demo\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const BUSINESS_HOURS = effectiveBusinessHours(null);
// UI-only localStorage scoping keys for layout/navigation preferences.
const SESSION_PREFS_ID = "guided-demo-session";
// While watching, the real components' existing restricted mode disables
// every change control (with the session's own wording, see
// RestrictedWordingProvider below); the server refuses changes regardless.
const WATCH_ENTITLEMENT: EntitlementView = Object.freeze({ ...DEMO_ENTITLEMENT, canMutateOperationalData: false }) as EntitlementView;

declare global {
  var __guidedDemoSession: { client: DemoSessionClient; role: DemoRole; sessionId: string } | undefined;
}

if (typeof window !== "undefined" && !globalThis.__guidedDemoSession) {
  const match = window.location.pathname.match(SESSION_PATH);
  if (match) {
    const role: DemoRole = new URLSearchParams(window.location.search).get("as") === "host" ? "host" : "visitor";
    const client = createDemoSessionClient({ sessionId: match[1], role });
    installDemoFetchInterceptor({ store: client.store, forwardMutation: client.forwardMutation });
    globalThis.__guidedDemoSession = { client, role, sessionId: match[1] };
  }
}

const SERVER_STATE: DemoSessionState = { status: "connecting", session: null, dataset: null, offline: false };
const noopSubscribe = () => () => {};

const getHydrated = () => true;
const getNotHydrated = () => false;

export default function SessionClient() {
  // The session lives only in the browser: the server render and the first
  // (hydrating) browser render must both be the same placeholder.
  const hydrated = useSyncExternalStore(noopSubscribe, getHydrated, getNotHydrated);
  const ctx = hydrated ? globalThis.__guidedDemoSession : undefined;
  const state = useSyncExternalStore(
    ctx ? ctx.client.subscribe : noopSubscribe,
    ctx ? ctx.client.getState : () => SERVER_STATE,
    () => SERVER_STATE
  );
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx) return;
    ctx.client.start();
    try {
      const saved = window.sessionStorage.getItem(inviteStorageKey(ctx.sessionId));
      // Syncs with browser storage (an external system) once on mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setInviteUrl(saved);
    } catch {
      // storage unavailable: the host can issue a new link from the bar
    }
    return () => ctx.client.stop();
  }, [ctx]);

  const dataset = state.dataset;
  const paidAppointmentIds = useMemo(
    () => (dataset ? dataset.completedJobBilling.filter((r) => r.paid).map((r) => r.appointment_id) : []),
    [dataset]
  );

  if (!hydrated) return <div className="min-h-screen bg-slate-50" aria-busy="true" />;
  if (!ctx) return <Notice title="Session not found" body="Check the link and try again." />;
  if (state.status === "unauthorized") {
    return (
      <Notice
        title="This session isn't available here"
        body={ctx.role === "host"
          ? "Sign in as the session host, then open the session again."
          : "Ask the host for a new invitation link."}
      />
    );
  }
  if (state.status === "ended") {
    return (
      <Notice
        title="This Guided Demo Session has ended"
        body={state.session?.end_reason === "expired" ? "Sessions last up to two hours." : "Thanks for joining."}
        link={ctx.role === "host" ? { href: "/demo/host", label: "Start a new session" } : { href: "/", label: "Back to ScheduleFlowTrack" }}
      />
    );
  }
  if (!dataset || !state.session) return <div className="min-h-screen bg-slate-50" aria-busy="true" />;

  const session = state.session;
  const iControl = session.controller === ctx.role;

  async function run(action: () => Promise<{ status: number; data: Record<string, any> | null }>, failure: string) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      if (result.status >= 400 && result.data?.outcome !== "ended") {
        setMessage(result.data?.outcome === "visitor_unavailable" ? "Your visitor isn't connected right now." : failure);
      }
      return result;
    } catch {
      setMessage(failure);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function leave() {
    if (ctx!.role === "visitor") {
      void ctx!.client.leave().finally(() => window.location.assign("/"));
    } else {
      window.location.assign("/demo/host");
    }
  }

  return (
    // While watching, every disabled change control explains the session
    // (not the account/billing wording the real app uses).
    <RestrictedWordingProvider wording={iControl ? null : WATCHING_MESSAGE}>
      <DashboardShell
        clients={dataset.clients}
        appointments={dataset.appointments}
        services={dataset.services}
        employees={dataset.employees}
        employeeHours={dataset.employeeHours}
        assignments={dataset.assignments}
        paidAppointmentIds={paidAppointmentIds}
        isTester={true}
        isLocalDemo={true}
        guidedSession={true}
        entitlement={iControl ? DEMO_ENTITLEMENT : WATCH_ENTITLEMENT}
        timezone={DEMO_TIMEZONE}
        businessHours={BUSINESS_HOURS}
        workspaceId={SESSION_PREFS_ID}
        userId={`${SESSION_PREFS_ID}-${ctx.role}`}
        onSignOut={leave}
        sessionBar={
          <SessionControlBar
            role={ctx.role}
            session={session}
            offline={state.offline}
            inviteUrl={inviteUrl}
            busy={busy}
            message={message}
            onGiveControl={() => void run(ctx.client.giveControl, "Couldn't give control. Please try again.")}
            onTakeBackControl={() => void run(ctx.client.takeBackControl, "Couldn't take back control. Please try again.")}
            onNewInvite={async () => {
              const result = await run(ctx.client.newInvite, "Couldn't create a new link.");
              const url = result?.data?.inviteUrl;
              if (typeof url === "string") {
                setInviteUrl(url);
                try { window.sessionStorage.setItem(inviteStorageKey(ctx.sessionId), url); } catch { /* not stored */ }
              }
            }}
            onEndSession={() => void run(ctx.client.endSession, "Couldn't end the session. Please try again.")}
            onLeave={leave}
          />
        }
      />
    </RestrictedWordingProvider>
  );
}

function Notice({ title, body, link }: { title: string; body: string; link?: { href: string; label: string } }) {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm text-center">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">{body}</p>
        {link && (
          <a href={link.href} className="mt-4 inline-block rounded-lg bg-[#0f172a] px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
            {link.label}
          </a>
        )}
      </div>
    </main>
  );
}
