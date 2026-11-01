"use client";

// Guided Demo Session page: the real Schedule FlowTrack dashboard on a
// fictional dataset shared by the host and one visitor (milestone 1: shared
// data and server-enforced permissions; each person navigates on their own).
// The host can always edit; the guest watches until the host allows guest
// control, and edits alongside the host until it is stopped.
//
// Both participants follow ONE shared screen (lib/demoSession/sharedView.ts,
// app/components/dashboard/sharedScreen.ts): calendar mode and date,
// selection, Settings section, the open dialog or edit form and its draft,
// and the calendar's scroll position -- plus each other's labelled cursor.
// The session bar stays each person's own.
//
// The demo fetch interceptor is installed in session mode at MODULE SCOPE,
// for the same reason as app/demo/DemoPageClient.tsx (child effects run
// before parent effects, so an effect-based install could let early
// requests escape): reads are answered from the synced dataset, data changes
// go to the session server, and any other /api/ call fails closed. Pages
// that lead here use full page loads, never client-side navigation, so this
// tab never carries another page's interceptor.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { EditBaseProvider } from "@/app/components/dashboard/editBase";
import { SharedScreenProvider, type SharedScreen } from "@/app/components/dashboard/sharedScreen";
import SharedCursor, { CURSOR_ROOT_ANCHOR, useCursorReporter } from "@/app/components/demo-session/SharedCursors";
import useIsMobile from "@/app/components/dashboard/useIsMobile";
import { businessDayKey } from "@/lib/timezone";
import type { SessionCursor } from "@/lib/demoSession/client";
import DashboardShell from "@/app/components/dashboard/DashboardShell";
import SessionControlBar, { type PendingAction } from "@/app/components/demo-session/SessionControlBar";
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

const SERVER_STATE: DemoSessionState = { status: "connecting", session: null, dataset: null, offline: false, view: null };
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
  const [pending, setPending] = useState<PendingAction | null>(null);
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

  // Edit forms read the version on screen when an edit begins (editBase.ts).
  const editSource = useMemo(() => (ctx ? { currentVersion: ctx.client.currentVersion } : null), [ctx]);

  // The shared screen this page provides to the dashboard.
  const today = businessDayKey(DEMO_TIMEZONE);
  const controller = state.session?.controller;
  const guestName = state.session?.visitor_display_name || "Your guest";
  const sharedScreen = useMemo<SharedScreen | null>(() => {
    if (!ctx || !state.session) return null;
    return {
      role: ctx.role,
      view: state.view,
      canAct: ctx.role === "host" || controller === "visitor",
      today,
      otherName: ctx.role === "host" ? guestName : "The host",
      dispatch: ctx.client.dispatchView,
      serverNavVersion: ctx.client.serverNavVersion,
      currentVersion: ctx.client.currentVersion,
    };
  }, [ctx, state.view, state.session, controller, today, guestName]);

  // Desktop only: below 768px the dashboard switches to its phone layout,
  // which can't show the shared screen.
  const isMobile = useIsMobile();

  // Labelled cursors: the host's is always shared; the guest's only while
  // guest control is allowed (the server enforces this too).
  const shareCursor = !!ctx && state.status === "live" && !isMobile && (ctx.role === "host" || controller === "visitor");
  useCursorReporter(shareCursor, (cursor: SessionCursor | null) => ctx?.client.setCursor(cursor));
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
  if (isMobile) {
    return (
      <Notice
        title="Please widen your window"
        body="Guided Demo Sessions need a window at least 768 pixels wide, so both people see the same screen."
      />
    );
  }

  const session = state.session;
  // The host is never blocked. The guest cannot touch the dashboard at all
  // while watching; the bar (Leave) stays usable.
  const watchingMessage = ctx.role === "visitor" && session.controller !== "visitor" ? WATCHING_MESSAGE : null;

  // Every host action shows that it is in progress on its own button, and
  // always ends in a visible result: the new state, or a message saying it
  // failed (including when the server never answers -- see REQUEST_TIMEOUT_MS).
  async function run(kind: PendingAction, action: () => Promise<{ status: number; data: Record<string, any> | null }>, failure: string) {
    setPending(kind);
    setMessage(null);
    try {
      const result = await action();
      if (result.status >= 400 && result.data?.outcome !== "ended") {
        setMessage(result.data?.outcome === "visitor_unavailable" ? "Your visitor isn't connected right now." : `${failure} Please try again.`);
      }
      return result;
    } catch (e) {
      setMessage(e instanceof Error && e.name === "AbortError" ? `${failure} The server didn't answer. Please try again.` : `${failure} Please check your connection and try again.`);
      return null;
    } finally {
      setPending(null);
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
    <SharedScreenProvider value={sharedScreen!}>
    <RestrictedWordingProvider wording={watchingMessage}>
    <div data-tour={CURSOR_ROOT_ANCHOR} className="h-screen">
    <EditBaseProvider source={editSource!}>
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
        entitlement={watchingMessage ? WATCH_ENTITLEMENT : DEMO_ENTITLEMENT}
        timezone={DEMO_TIMEZONE}
        businessHours={BUSINESS_HOURS}
        workspaceId={SESSION_PREFS_ID}
        userId={`${SESSION_PREFS_ID}-${ctx.role}`}
        onSignOut={leave}
        watchingMessage={watchingMessage}
        sessionBar={
          <SessionControlBar
            role={ctx.role}
            session={session}
            offline={state.offline}
            inviteUrl={inviteUrl}
            pending={pending}
            message={message}
            onAllowGuestControl={() => void run("allow", ctx.client.allowGuestControl, "Couldn't allow guest control.")}
            onStopGuestControl={() => void run("stop", ctx.client.stopGuestControl, "Couldn't stop guest control.")}
            onNewInvite={async () => {
              const result = await run("invite", ctx.client.newInvite, "Couldn't create a new link.");
              const url = result?.data?.inviteUrl;
              if (typeof url === "string") {
                setInviteUrl(url);
                try { window.sessionStorage.setItem(inviteStorageKey(ctx.sessionId), url); } catch { /* not stored */ }
              }
            }}
            onEndSession={() => void run("end", ctx.client.endSession, "Couldn't end the session.")}
            onLeave={leave}
            pendingRequest={pendingRequest(state.view, ctx.role, ctx.role === "host" ? guestName : "The host", (decision) => {
              const id = state.view?.pending?.id;
              if (id) void ctx.client.dispatchView({ type: "resolve", pendingId: id, decision });
            })}
          />
        }
      />
    </EditBaseProvider>
    </div>
    </RestrictedWordingProvider>
    <SharedCursor
      cursor={((ctx.role === "host" ? session.visitor_cursor : session.host_cursor) ?? null) as SessionCursor | null}
      label={ctx.role === "host" ? guestName : "Host"}
      color={ctx.role === "host" ? "#7c3aed" : "#0f766e"}
    />
    </SharedScreenProvider>
  );
}

// A navigation waiting on someone's unsaved input, explained the same way on
// both screens, with the choices this person has.
function pendingRequest(
  view: DemoSessionState["view"],
  role: DemoRole,
  other: string,
  resolve: (decision: "keep" | "discard" | "continue_keep_draft") => void
) {
  const p = view?.pending;
  if (!p) return null;
  const ownerIsMe = view?.editor?.role === role;
  const iAsked = p.by === role;
  const form = view?.editor?.label || "an open form";
  const want = p.label || "move on";
  if (ownerIsMe) {
    return {
      text: `${iAsked ? "You asked" : `${other} wants`} to ${want}, but you have unsaved changes in ${form}.`,
      actions: [
        { label: "Keep editing", onClick: () => resolve("keep") },
        { label: "Discard my changes and continue", onClick: () => resolve("discard") },
      ],
    };
  }
  const actions = [] as Array<{ label: string; onClick: () => void }>;
  if (iAsked) actions.push({ label: "Cancel my request", onClick: () => resolve("keep") });
  if (role === "host") actions.push({ label: `Continue and keep ${other}'s draft`, onClick: () => resolve("continue_keep_draft") });
  return {
    text: `${iAsked ? "You asked" : `${other} asked`} to ${want}. ${other} has unsaved changes in ${form}; waiting for them to save or discard.`,
    actions,
  };
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
