"use client";

// Browser-local public demo. No session, no cookie, no server data: every
// prop below comes from the in-browser demo store (lib/demoLocal/store.ts),
// and every /api/ request the dashboard makes is answered locally by the demo
// fetch interceptor (lib/demoLocal/fetchInterceptor.ts) -- it never reaches
// the real server. Not covered by middleware.ts's matcher on purpose.
import { useMemo, useSyncExternalStore } from "react";
import DashboardShell from "@/app/components/dashboard/DashboardShell";
import { installDemoFetchInterceptor } from "@/lib/demoLocal/fetchInterceptor";
import { getSnapshot, initStore, subscribe, type DemoFixtureBundle } from "@/lib/demoLocal/store";
import { DEMO_ENTITLEMENT } from "@/lib/demoLocal/fixtures/entitlement";
import { DEMO_TIMEZONE } from "@/lib/demoLocal/fixtures/generate";
import { effectiveBusinessHours } from "@/lib/businessHours";

// UI-only localStorage scoping keys (layout/navigation prefs), never sent to
// any server route -- deliberately distinct from the real DEMO_WORKSPACE_ID.
const LOCAL_DEMO_WORKSPACE_ID = "local-demo";
const LOCAL_DEMO_USER_ID = "local-demo";

// The same defaults app/dashboard/page.tsx falls back to for a workspace with
// no saved company settings (effectiveTimezone(null) / effectiveBusinessHours(null)).
const DEMO_BUSINESS_HOURS = effectiveBusinessHours(null);

// MODULE SCOPE, not a useEffect: React runs a child's mount effects (e.g.
// BillingPanel's initial fetch) BEFORE a parent's, so an effect-based install
// here would race and let early requests escape to the real server. Browser
// only (both are no-ops/meaningless during server rendering); the interceptor
// guards itself against double install, and the flag below keeps a Fast
// Refresh re-evaluation from needlessly re-reading sessionStorage.
declare global {
  var __demoLocalStoreInitialized: boolean | undefined;
}
if (typeof window !== "undefined") {
  installDemoFetchInterceptor();
  if (!globalThis.__demoLocalStoreInitialized) {
    initStore();
    globalThis.__demoLocalStoreInitialized = true;
  }
}

// Server render has no demo data (it lives in this tab's sessionStorage), so
// the server snapshot is null and the dashboard renders only in the browser.
function getServerSnapshot(): DemoFixtureBundle | null {
  return null;
}

export default function DemoPageClient() {
  const snapshot = useSyncExternalStore<DemoFixtureBundle | null>(subscribe, getSnapshot, getServerSnapshot);

  const paidAppointmentIds = useMemo(
    () => (snapshot ? snapshot.completedJobBilling.filter((r) => r.paid).map((r) => r.appointment_id) : []),
    [snapshot]
  );

  if (!snapshot) {
    return <div className="min-h-screen bg-slate-50" />;
  }

  return (
    <DashboardShell
      clients={snapshot.clients}
      appointments={snapshot.appointments}
      services={snapshot.services}
      employees={snapshot.employees}
      employeeHours={snapshot.employeeHours}
      assignments={snapshot.assignments}
      paidAppointmentIds={paidAppointmentIds}
      isTester={true}
      entitlement={DEMO_ENTITLEMENT}
      timezone={DEMO_TIMEZONE}
      businessHours={DEMO_BUSINESS_HOURS}
      workspaceId={LOCAL_DEMO_WORKSPACE_ID}
      userId={LOCAL_DEMO_USER_ID}
      isLocalDemo={true}
    />
  );
}
