"use client";

import { SettingsSection } from "@/app/components/dashboard/types";
import CompanyInfoPanel from "@/app/components/dashboard/CompanyInfoPanel";
import ServicesPanel from "@/app/components/dashboard/ServicesPanel";
import StaffPanel from "@/app/components/dashboard/StaffPanel";
import ArchivedClientsPanel from "@/app/components/dashboard/ArchivedClientsPanel";

export default function SettingsPanel({ section }: { section: SettingsSection }) {
  if (section === "company") return <CompanyInfoPanel />;
  if (section === "services") return <ServicesPanel />;
  if (section === "staff") return <StaffPanel />;
  if (section === "archived") return <ArchivedClientsPanel />;
  return null;
}
