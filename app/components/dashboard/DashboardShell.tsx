"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/app/components/dashboard/TopBar";
import LeftBar from "@/app/components/dashboard/LeftBar";
import ScheduleGrid from "@/app/components/dashboard/ScheduleGrid";
import SettingsSidebar from "@/app/components/dashboard/SettingsSidebar";
import SettingsPanel from "@/app/components/dashboard/SettingsPanel";
import ClientPanel from "@/app/components/dashboard/ClientPanel";
import DispatchPanel from "@/app/components/dashboard/DispatchPanel";
import AppointmentModal from "@/app/components/dashboard/AppointmentModal";
import MoveConfirmDialog from "@/app/components/dashboard/MoveConfirmDialog";
import useIsMobile, { useMediaQuery } from "@/app/components/dashboard/useIsMobile";
import {
  Client,
  Appointment,
  Service,
  Employee,
  EmployeeHours,
  MobileTab,
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
  employees,
  employeeHours,
}: {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
}) {
  const isMobile = useIsMobile();
  const isPhoneLandscape = useMediaQuery("(max-height: 440px) and (orientation: landscape)");
  const [viewMode, setViewMode] = useState<ViewMode>("weekdays");
  const [centerMode, setCenterMode] = useState<CenterMode>("schedule");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("company");
  const [mobileTab, setMobileTab] = useState<MobileTab>("schedule");

  const router = useRouter();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [clientsHidden, setClientsHidden] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<
    { appointment: Appointment; client: Client; scheduledFor: string; scheduledEnd: string | null } | null
  >(null);

  const effectiveViewMode = isMobile && viewMode !== "day" ? "day" : viewMode;

  const selectedClient = useMemo(() => {
    if (!selectedClientId) return null;
    return clients.find((c) => c.id === selectedClientId) ?? null;
  }, [selectedClientId, clients]);

  function handleSelectClient(clientId: string) {
    setSelectedClientId(clientId);
    setSelectedApptId(null);
    if (isMobile) setMobileTab("schedule");
  }

  function selectAppointment(apptId: string) {
    setSelectedApptId(apptId);
    const appt = appointments.find((a) => a.id === apptId);
    if (!appt) return;
    setSelectedClientId(appt.client_id);
  }

  function editAppointment(apptId: string) {
    const appt = appointments.find((a) => a.id === apptId);
    if (!appt) return;
    setSelectedApptId(apptId);
    setSelectedClientId(appt.client_id);
    const client = clients.find((c) => c.id === appt.client_id);
    if (client) {
      setModal({ mode: "edit", appointment: appt, client });
    }
  }

  function handleSelectAppointment(apptId: string) {
    if (isMobile) {
      editAppointment(apptId);
    } else {
      selectAppointment(apptId);
    }
  }

  function handleEditAppointment(apptId: string) {
    editAppointment(apptId);
  }

  function handleGoToday() {
    setCenterMode("schedule");
    if (isMobile) setMobileTab("schedule");
    setSelectedApptId(null);
    setWeekOffset(0);
  }

  function handleAdd() {
    setModal({ mode: "create" });
  }

  function handleCellClick(date: Date, hour: number, minute: number) {
    setSelectedApptId(null);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(hour).padStart(2, "0");
    const min = String(minute).padStart(2, "0");
    setModal({ mode: "create", prefillDate: `${y}-${m}-${d}`, prefillTime: `${h}:${min}` });
  }

  function handleModalSaved() {
    setModal(null);
    router.refresh();
  }

  function handleDropAppointment(appointmentId: string, scheduledFor: string, scheduledEnd: string | null) {
    const appointment = appointments.find((a) => a.id === appointmentId);
    if (!appointment) return;
    const client = clients.find((c) => c.id === appointment.client_id);
    if (!client) return;
    setPendingMove({ appointment, client, scheduledFor, scheduledEnd });
  }

  function handleMoved() {
    setPendingMove(null);
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

  const modalEl = modal && (
    <AppointmentModal
      onClose={() => setModal(null)}
      onSaved={handleModalSaved}
      clients={clients}
      appointments={appointments}
      services={services}
      employees={employees}
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
  );

  // --- MOBILE LAYOUT ---
  if (isMobile) {
    return (
      <div className="h-[100dvh] flex flex-col bg-slate-100 text-slate-900 overflow-hidden">
        {/* Mobile top bar */}
        <TopBar
          onGoToday={handleGoToday}
          onAdd={handleAdd}
          weekOffset={weekOffset}
          onWeekChange={setWeekOffset}
          isMobile
          viewMode={effectiveViewMode}
          onChangeView={setViewMode}
        />

        {/* Mobile content area */}
        <div className="flex-1 min-h-0 overflow-auto">
          {mobileTab === "schedule" && (
            <div className="h-full p-2">
              <ScheduleGrid
                viewMode={effectiveViewMode}
                clients={clients}
                appointments={appointments}
                services={services}
                employees={employees}
                employeeHours={employeeHours}
                selectedClientId={selectedClientId}
                selectedAppointmentId={selectedApptId}
                onSelectAppointment={handleSelectAppointment}
                onCellClick={handleCellClick}
                weekOffset={weekOffset}
              />
            </div>
          )}

          {mobileTab === "clients" && (
            <div className="h-full flex flex-col">
              {/* Client list */}
              <div className="border-b bg-white">
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Clients ({clients.filter((c) => !c.archived_at).length})
                </div>
                <div className="max-h-[35vh] overflow-auto">
                  {clients.filter((c) => !c.archived_at).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => { setSelectedClientId(c.id); setSelectedApptId(null); }}
                      className={[
                        "w-full px-4 py-3 text-left text-sm border-b border-slate-100 transition-colors",
                        c.id === selectedClientId ? "bg-blue-50 text-blue-900 font-medium" : "text-slate-700",
                      ].join(" ")}
                    >
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {c.phone || c.email || "No contact info"}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {/* Selected client details */}
              <div className="flex-1 min-h-0 overflow-auto">
                <ClientPanel client={selectedClient} appointments={appointments} onClientUpdated={() => router.refresh()} />
              </div>
            </div>
          )}

          {mobileTab === "settings" && (
            <div className="h-full flex flex-col">
              {/* Settings nav as horizontal scroll */}
              <div className="bg-white border-b overflow-x-auto shrink-0">
                <div className="flex px-2 py-2 gap-1 min-w-max">
                  {(
                    [
                      { key: "company", label: "Company" },
                      { key: "services", label: "Services" },
                      { key: "staff", label: "Staff" },
                      { key: "archived", label: "Archived" },
                      { key: "preferences", label: "Prefs" },
                    ] as { key: SettingsSection; label: string }[]
                  ).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setSettingsSection(key)}
                      className={[
                        "rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors",
                        settingsSection === key
                          ? "bg-slate-900 text-white font-medium"
                          : "text-slate-600 hover:bg-slate-100",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-auto p-2">
                <SettingsPanel section={settingsSection} />
              </div>
            </div>
          )}

        </div>

        {/* Floating add button on schedule tab */}
        {mobileTab === "schedule" && (
          <button
            onClick={handleAdd}
            className="fixed bottom-20 right-4 w-14 h-14 rounded-full bg-slate-900 text-white text-2xl shadow-lg flex items-center justify-center z-40 active:bg-slate-700"
          >
            +
          </button>
        )}

        {/* Bottom tab bar */}
        <nav className="shrink-0 bg-white border-t border-slate-200 safe-area-bottom">
          <div className="grid grid-cols-3 h-14">
            {(
              [
                { key: "schedule", label: "Schedule", icon: "📅" },
                { key: "clients", label: "Clients", icon: "👥" },
                { key: "settings", label: "Settings", icon: "⚙" },
              ] as { key: MobileTab; label: string; icon: string }[]
            ).map(({ key, label, icon }) => (
              <button
                key={key}
                onClick={() => setMobileTab(key)}
                className={[
                  "flex flex-col items-center justify-center gap-0.5 text-xs transition-colors",
                  mobileTab === key ? "text-blue-600 font-medium" : "text-slate-400",
                ].join(" ")}
              >
                <span className="text-lg leading-none">{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </nav>

        {modalEl}
      </div>
    );
  }

  // --- DESKTOP LAYOUT (unchanged) ---
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
                  employees={employees}
                  employeeHours={employeeHours}
                  selectedClientId={selectedClientId}
                  selectedAppointmentId={selectedApptId}
                  onSelectAppointment={handleSelectAppointment}
                  onEditAppointment={handleEditAppointment}
                  onCellClick={handleCellClick}
                  onDropAppointment={handleDropAppointment}
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

      {/* Right dispatch panel — hidden on phone landscape */}
      {!isPhoneLandscape && (
        <aside className="shrink-0 w-[380px] p-2 pl-0">
          <DispatchPanel
            appointments={appointments}
            clients={clients}
            employees={employees}
            employeeHours={employeeHours}
            selectedAppointmentId={selectedApptId}
            onHoursSaved={() => router.refresh()}
          />
        </aside>
      )}

      {modalEl}
      {pendingMove && (
        <MoveConfirmDialog
          appointment={pendingMove.appointment}
          client={pendingMove.client}
          scheduledFor={pendingMove.scheduledFor}
          scheduledEnd={pendingMove.scheduledEnd}
          onClose={() => setPendingMove(null)}
          onMoved={handleMoved}
        />
      )}
    </div>
  );
}
