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
import MobileDashboard from "@/app/components/mobile/MobileDashboard";
import useIsMobile, { useMediaQuery } from "@/app/components/dashboard/useIsMobile";
import { DemoExperienceProvider, useDemoExperienceContext } from "@/app/components/demo-experience/DemoExperienceProvider";
import DemoExperienceOverlay from "@/app/components/demo-experience/DemoExperienceOverlay";
import {
  Client,
  Appointment,
  Service,
  Employee,
  EmployeeHours,
  ViewMode,
  CenterMode,
  SettingsSection,
} from "@/app/components/dashboard/types";

type ModalState =
  | { mode: "create"; prefillDate?: string; prefillTime?: string }
  | { mode: "edit"; appointment: Appointment; client: Client };

// Milestone 1 scaffold only — a manual trigger to prove the spotlight
// overlay works end to end. Replaced by the real auto-start entry flow in
// a later milestone.
function DemoExperienceTestTrigger() {
  const { start } = useDemoExperienceContext();
  return (
    <button
      type="button"
      onClick={start}
      className="w-full rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700 hover:bg-blue-100 transition-colors"
    >
      Preview Experience Overlay (Milestone 1 test)
    </button>
  );
}

export default function DashboardShell({
  clients,
  appointments,
  services,
  employees,
  employeeHours,
  isTester,
}: {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  isTester: boolean;
}) {
  const isMobile = useIsMobile();
  const isPhoneLandscape = useMediaQuery("(max-height: 440px) and (orientation: landscape)");
  const [viewMode, setViewMode] = useState<ViewMode>("weekdays");
  const [centerMode, setCenterMode] = useState<CenterMode>("schedule");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("company");

  const router = useRouter();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [clientsHidden, setClientsHidden] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<
    { appointment: Appointment; client: Client; scheduledFor: string; scheduledEnd: string | null } | null
  >(null);

  const selectedClient = useMemo(() => {
    if (!selectedClientId) return null;
    return clients.find((c) => c.id === selectedClientId) ?? null;
  }, [selectedClientId, clients]);

  function handleSelectClient(clientId: string) {
    setSelectedClientId(clientId);
    setSelectedApptId(null);
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

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    router.push("/");
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

  // --- MOBILE LAYOUT (Mobile Admin v1 — see app/components/mobile/) ---
  if (isMobile) {
    return (
      <>
        <MobileDashboard
          clients={clients}
          appointments={appointments}
          services={services}
          employees={employees}
          onAdd={handleAdd}
          onEditAppointment={handleEditAppointment}
          onClientUpdated={() => router.refresh()}
          isTester={isTester}
        />
        {modalEl}
      </>
    );
  }

  // --- DESKTOP LAYOUT (unchanged, except the Demo Mode banner/settings restriction for tester sessions) ---
  return (
    <DemoExperienceProvider>
    <div className="h-screen flex flex-col bg-slate-100 text-slate-900 overflow-hidden">
      {isTester && (
        <div className="shrink-0 bg-amber-400 text-amber-950 text-center text-xs font-semibold py-1.5 px-4">
          Demo Mode — All information shown in Demo Mode is fictional and for testing only.
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
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
          ) : isTester ? (
            <div className="flex-1 min-h-0 overflow-auto pt-2">
              <div className="max-w-xl mx-auto space-y-4 pb-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="text-base font-semibold text-slate-900">Demo Mode</div>
                  <div className="mt-2 text-sm text-slate-600">
                    All information shown in Demo Mode is fictional and for testing only.
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Demo Company
                  </div>
                  <div className="mt-1 text-lg font-semibold text-slate-900">
                    Sunshine Property Services
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                    Demo Data
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-2xl font-bold text-slate-900">20</div>
                      <div className="text-xs text-slate-500">Fictional Clients</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-slate-900">3</div>
                      <div className="text-xs text-slate-500">Fictional Employees</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-slate-900">6</div>
                      <div className="text-xs text-slate-500">Fictional Services</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-slate-900">38</div>
                      <div className="text-xs text-slate-500">Fictional Appointments</div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm text-center text-sm text-slate-500">
                  Full settings management is available in owner accounts.
                </div>

                <DemoExperienceTestTrigger />

                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"
                >
                  {signingOut ? "Signing out..." : "Sign Out"}
                </button>
              </div>
            </div>
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
      </div>

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
    {isTester && <DemoExperienceOverlay />}
    </DemoExperienceProvider>
  );
}
