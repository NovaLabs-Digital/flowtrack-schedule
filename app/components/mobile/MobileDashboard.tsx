"use client";

import { Client, Appointment, Service, Employee } from "@/app/components/dashboard/types";

type Props = {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  onAdd: () => void;
  onEditAppointment: (apptId: string) => void;
  onClientUpdated: () => void;
};

// Milestone 1 scaffolding for Mobile Admin v1 — proves the mobile/desktop
// split renders this component with real data flowing through. Screens 1-4
// from the approved mockup are built incrementally in later milestones.
export default function MobileDashboard({
  clients,
  appointments,
  services,
  employees,
}: Props) {
  return (
    <div className="h-[100dvh] flex flex-col items-center justify-center bg-slate-100 text-slate-900 px-6 text-center gap-2">
      <div className="text-lg font-semibold">Mobile Admin v1</div>
      <div className="text-sm text-slate-500">
        {appointments.length} appointments · {clients.length} clients · {employees.length} employees · {services.length} services
      </div>
      <div className="text-xs text-slate-400">Milestone 1 scaffolding — screens built in following milestones.</div>
    </div>
  );
}
