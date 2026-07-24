"use client";

import { SettingsSection } from "@/app/components/dashboard/types";
import CompanyInfoPanel from "@/app/components/dashboard/CompanyInfoPanel";
import ServicesPanel from "@/app/components/dashboard/ServicesPanel";
import StaffPanel from "@/app/components/dashboard/StaffPanel";
import ArchivedClientsPanel from "@/app/components/dashboard/ArchivedClientsPanel";

export default function SettingsPanel({
  section,
  canMutateOperationalData,
}: {
  section: SettingsSection;
  // Phase 5.5E-E1E: forwarded only to ArchivedClientsPanel, the one section
  // here with an owner mutation control (Restore) -- Company/Services/Staff
  // are untouched, out of this phase's scope.
  canMutateOperationalData: boolean;
}) {
  if (section === "company") return <CompanyInfoPanel />;
  if (section === "services") return <ServicesPanel />;
  if (section === "staff") return <StaffPanel />;
  if (section === "archived") return <ArchivedClientsPanel canMutateOperationalData={canMutateOperationalData} />;
  return null;
}
