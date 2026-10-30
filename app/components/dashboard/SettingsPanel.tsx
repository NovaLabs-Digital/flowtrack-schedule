"use client";

import { SettingsSection } from "@/app/components/dashboard/types";
import CompanyInfoPanel from "@/app/components/dashboard/CompanyInfoPanel";
import ServicesPanel from "@/app/components/dashboard/ServicesPanel";
import StaffPanel from "@/app/components/dashboard/StaffPanel";
import ArchivedClientsPanel from "@/app/components/dashboard/ArchivedClientsPanel";
import RecurringSeriesPanel from "@/app/components/dashboard/RecurringSeriesPanel";
import BillingPanel from "@/app/components/dashboard/BillingPanel";

export default function SettingsPanel({
  section,
  canMutateOperationalData,
  isTrialing,
  timezone,
  workspaceId,
  userId,
  billingFocusAppointmentId,
  billingFocusServiceDate,
  onBillingSaved,
  isLocalDemo = false,
}: {
  section: SettingsSection;
  // Phase 5.5E-E1E forwarded this only to ArchivedClientsPanel. Phase
  // 5.5E-E1F forwards the same trusted value to every section here that
  // owns a real mutation control (Company, Services, Staff) -- still just
  // the Phase 5.5B browser-safe projection, never a raw EntitlementResult.
  canMutateOperationalData: boolean;
  // Phase 5.6D: forwarded only to CompanyInfoPanel's Subscription & Plan
  // card, the one place the application-controlled "Cancel Free Trial"
  // action is offered. Same browser-safe EntitlementView projection, never
  // a raw EntitlementResult.
  isTrialing: boolean;
  // Billing / Completed Jobs: forwarded only to BillingPanel -- the
  // workspace's own trusted timezone (see DashboardSettingsArea's own
  // comment on this same prop).
  timezone: string;
  // Billing / Completed Jobs sort-order preference: forwarded only to
  // BillingPanel, for scoping its localStorage key per (user, workspace)
  // -- same values DashboardShell already threads to
  // useDashboardLayoutPrefs. Never sent to any server route.
  workspaceId: string;
  userId: string;
  // Needs Attention deep-link (DashboardShell's NeedsAttentionControl
  // wiring): forwarded only to BillingPanel's own focusAppointmentId/
  // focusServiceDate props, so switching to this section with a specific
  // job in mind actually seeds its date range around that job.
  billingFocusAppointmentId?: string | null;
  billingFocusServiceDate?: string | null;
  // Needs Attention refresh: forwarded only to BillingPanel's own
  // onBillingSaved prop, so a successful invoice/payment save there bumps
  // DashboardShell's needsAttentionRefreshToken -- the sidebar control's
  // issue labels/counts catch up without a full-page reload.
  onBillingSaved?: () => void;
  // Browser-local public demo (app/demo/page.tsx) only: forwarded ONLY to
  // ServicesPanel's own isTester prop (never to StaffPanel/CompanyInfoPanel/
  // etc.) -- ServicesPanel's SOLE use of isTester is revealing its hard
  // "Delete" action (every other panel either has no isTester-gated
  // behavior, like StaffPanel, whose isTester HIDES the Add Employee button
  // -- exactly the opposite of what the demo needs for its own Employees
  // CRUD requirement, so isTester must never reach StaffPanel here). Real
  // owners never pass this (default false), so ServicesPanel's real-owner
  // behavior (Edit/Disable only, matching "a real service is deactivated,
  // never deleted") is completely unchanged.
  isLocalDemo?: boolean;
}) {
  if (section === "company") return <CompanyInfoPanel canMutateOperationalData={canMutateOperationalData} isTrialing={isTrialing} />;
  if (section === "services") return <ServicesPanel canMutateOperationalData={canMutateOperationalData} isTester={isLocalDemo} />;
  if (section === "staff") return <StaffPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "archived") return <ArchivedClientsPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "recurring") return <RecurringSeriesPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "billing") {
    return (
      <BillingPanel
        timezone={timezone}
        canMutateOperationalData={canMutateOperationalData}
        workspaceId={workspaceId}
        userId={userId}
        focusAppointmentId={billingFocusAppointmentId}
        focusServiceDate={billingFocusServiceDate}
        onBillingSaved={onBillingSaved}
      />
    );
  }
  return null;
}
