"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/app/components/dashboard/TopBar";
import LeftBar from "@/app/components/dashboard/LeftBar";
import ScheduleGrid from "@/app/components/dashboard/ScheduleGrid";
import SettingsSidebar from "@/app/components/dashboard/SettingsSidebar";
import SettingsPanel from "@/app/components/dashboard/SettingsPanel";
import ClientPanel from "@/app/components/dashboard/ClientPanel";
import MapPanel from "@/app/components/dashboard/MapPanel";
import AppointmentModal from "@/app/components/dashboard/AppointmentModal";
import {
  Client,
  Appointment,
  Service,
  ViewMode,
  CenterMode,
  SettingsSection,
} from "@/app/components/dashboard/types";

type ModalState =
  | { mode: "create"; prefillDate?: string; prefillTime?: string }
  | { mode: "edit"; appointment: Appointment; client: Client };

export default function DashboardShell({
  clients,
  appointments,
  services,
}: {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("weekdays");
  const [centerMode, setCenterMode] = useState<CenterMode>("schedule");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("company");

  const router = useRouter();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [clientsHidden, setClientsHidden] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);

  const selectedClient = useMemo(() => {
    if (!selectedClientId) return null;
    return clients.find((c) => c.id === selectedClientId) ?? null;
  }, [selectedClientId, clients]);

  function handleSelectClient(clientId: string) {
    setSelectedClientId(clientId);
    setSelectedApptId(null);
  }

  function handleSelectAppointment(apptId: string) {
    setSelectedApptId(apptId);
    const appt = appointments.find((a) => a.id === apptId);
    if (!appt) return;
    setSelectedClientId(appt.client_id);
    const client = clients.find((c) => c.id === appt.client_id);
    if (client) {
      setModal({ mode: "edit", appointment: appt, client });
    }
  }

  function handleGoToday() {
    setCenterMode("schedule");
    setSelectedApptId(null);
    setWeekOffset(0);
  }

  function handleAdd() {
    setModal({ mode: "create" });
  }

  function handleCellClick(date: Date, hour: number) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(hour).padStart(2, "0");
    setModal({ mode: "create", prefillDate: `${y}-${m}-${d}`, prefillTime: `${h}:00` });
  }

  function handleModalSaved() {
    setModal(null);
    router.refresh();
  }

  function handleToggleSettings() {
    if (centerMode === "settings") {
      setCenterMode("schedule");
    } else {
      setCenterMode("settings");
      setSettingsSection("company");
    }
  }

  return (
    <div className="h-screen flex bg-slate-100 text-slate-900 overflow-hidden">
      {/* Left bar — full height, never moves */}
      <aside className="shrink-0 w-[230px] p-2 pr-0">
        <LeftBar
          viewMode={viewMode}
          onChangeView={(m) => {
            setViewMode(m);
            setCenterMode("schedule");
          }}
          centerMode={centerMode}
          onToggleSettings={handleToggleSettings}
          clients={clients}
          clientsHidden={clientsHidden}
          onToggleClientsHidden={() => setClientsHidden((v) => !v)}
          selectedClientId={selectedClientId}
          onSelectClient={handleSelectClient}
        />
      </aside>

      {/* Center content area */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Top bar with navigation and actions */}
        <TopBar
          onGoToday={handleGoToday}
          onAdd={handleAdd}
          weekOffset={weekOffset}
          onWeekChange={setWeekOffset}
        />

        <div className="flex-1 min-h-0 flex flex-col px-2 pb-2">
          {centerMode === "schedule" ? (
            <>
              {/* Schedule grid — 68% of available height */}
              <div className="min-h-0 pb-2" style={{ flex: "68 1 0%" }}>
                <ScheduleGrid
                  viewMode={viewMode}
                  clients={clients}
                  appointments={appointments}
                  services={services}
                  selectedClientId={selectedClientId}
                  selectedAppointmentId={selectedApptId}
                  onSelectAppointment={handleSelectAppointment}
                  onCellClick={handleCellClick}
                  weekOffset={weekOffset}
                />
              </div>

              {/* Client workspace — 32% of available height */}
              <div className="min-h-0 overflow-auto" style={{ flex: "32 1 0%" }}>
                <ClientPanel client={selectedClient} appointments={appointments} onClientUpdated={() => router.refresh()} />
              </div>
            </>
          ) : (
            <div className="flex gap-3 flex-1 min-h-0 pt-2">
              <aside className="shrink-0 w-[200px]">
                <SettingsSidebar
                  activeSection={settingsSection}
                  onSelect={setSettingsSection}
                  onBack={() => setCenterMode("schedule")}
                />
              </aside>
              <main className="flex-1 min-w-0 max-w-3xl">
                <SettingsPanel section={settingsSection} />
              </main>
            </div>
          )}
        </div>
      </div>

      {/* Right map panel — always visible, never moves */}
      <aside className="shrink-0 w-[380px] p-2 pl-0">
        <MapPanel />
      </aside>

      {modal && (
        <AppointmentModal
          onClose={() => setModal(null)}
          onSaved={handleModalSaved}
          clients={clients}
          services={services}
          editing={
            modal.mode === "edit"
              ? { appointment: modal.appointment, client: modal.client }
              : undefined
          }
          prefill={
            modal.mode === "create" && (modal.prefillDate || modal.prefillTime)
              ? { date: modal.prefillDate ?? "", time: modal.prefillTime ?? "" }
              : undefined
          }
        />
      )}
    </div>
  );
}
