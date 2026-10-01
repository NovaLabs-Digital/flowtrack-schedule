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
}) {
  if (section === "company") return <CompanyInfoPanel canMutateOperationalData={canMutateOperationalData} isTrialing={isTrialing} />;
  if (section === "services") return <ServicesPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "staff") return <StaffPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "archived") return <ArchivedClientsPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "recurring") return <RecurringSeriesPanel canMutateOperationalData={canMutateOperationalData} />;
  if (section === "billing") return <BillingPanel timezone={timezone} canMutateOperationalData={canMutateOperationalData} />;
  return null;
}
