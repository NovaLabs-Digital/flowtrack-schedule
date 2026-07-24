"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/app/components/dashboard/TopBar";
import LeftBar from "@/app/components/dashboard/LeftBar";
import ScheduleGrid from "@/app/components/dashboard/ScheduleGrid";
import DashboardSettingsArea from "@/app/components/dashboard/DashboardSettingsArea";
import ClientPanel from "@/app/components/dashboard/ClientPanel";
import AppointmentDetailPanel from "@/app/components/dashboard/AppointmentDetailPanel";
import DispatchPanel from "@/app/components/dashboard/DispatchPanel";
import AppointmentModal from "@/app/components/dashboard/AppointmentModal";
import MoveConfirmDialog from "@/app/components/dashboard/MoveConfirmDialog";
import MobileDashboard from "@/app/components/mobile/MobileDashboard";
import OwnerBillingBanner from "@/app/components/dashboard/OwnerBillingBanner";
import useIsMobile, { useMediaQuery } from "@/app/components/dashboard/useIsMobile";
import { DemoExperienceProvider } from "@/app/components/demo-experience/DemoExperienceProvider";
import DemoExperienceOverlay from "@/app/components/demo-experience/DemoExperienceOverlay";
import MobileExperiencePreview from "@/app/components/demo-experience/MobileExperiencePreview";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";
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
import type { EntitlementView } from "@/lib/entitlementView";

type ModalState =
  | { mode: "create"; prefillDate?: string; prefillTime?: string }
  | { mode: "edit"; appointment: Appointment; client: Client };

export default function DashboardShell({
  clients,
  appointments,
  services,
  employees,
  employeeHours,
  isTester,
  entitlement,
}: {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  isTester: boolean;
  // Phase 5.5D: consumed by OwnerBillingBanner (desktop below, and passed
  // through to MobileDashboard for the mobile layout) -- only its
  // bannerVariant/recoveryAction fields are ever read there. Phase 5.5E-E1A
  // threaded entitlement.canMutateOperationalData through to AppointmentModal
  // (below); Phase 5.5E-E1B threads the same value through to
  // AppointmentDetailPanel, ScheduleGrid, and MoveConfirmDialog -- still just
  // the Phase 5.5B browser-safe projection, never a raw EntitlementResult.
  // The remaining capability booleans are present on this type but not yet
  // consumed by any other owner control -- later E-E phases apply those.
  entitlement: EntitlementView;
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

  // Mirrors the employeeHours prop, but can also be updated the instant a
  // manual-hours save succeeds — every other mutation in this component
  // relies solely on router.refresh() re-fetching fresh server props, which
  // works but isn't instantaneous. The warning triangle, missing-hours
  // count, and weekly total all read from this one state array (via
  // lib/payroll.ts's shared hasWorkedHours/needsWorkedHoursAttention
  // predicate), so updating it immediately here is what makes all three
  // update immediately together, without waiting on the refresh round trip.
  const [employeeHoursState, setEmployeeHoursState] = useState<EmployeeHours[]>(employeeHours);
  useEffect(() => {
    setEmployeeHoursState(employeeHours);
  }, [employeeHours]);

  function handleHoursSaved(entry: EmployeeHours) {
    setEmployeeHoursState((prev) => {
      const idx = prev.findIndex((h) => h.appointment_id === entry.appointment_id && h.employee_id === entry.employee_id);
      if (idx === -1) return [...prev, entry];
      const next = [...prev];
      next[idx] = entry;
      return next;
    });
    router.refresh();
  }

  const selectedClient = useMemo(() => {
    if (!selectedClientId) return null;
    return clients.find((c) => c.id === selectedClientId) ?? null;
  }, [selectedClientId, clients]);

  const selectedAppt = useMemo(() => {
    if (!selectedApptId) return null;
    return appointments.find((a) => a.id === selectedApptId) ?? null;
  }, [selectedApptId, appointments]);

  const selectedApptEmployee = useMemo(() => {
    if (!selectedAppt?.employee_id) return null;
    return employees.find((e) => e.id === selectedAppt.employee_id) ?? null;
  }, [selectedAppt, employees]);

  function handleSelectClient(clientId: string) {
    setSelectedClientId(clientId);
    setSelectedApptId(null);
    notifyDemoAction("open-client");
  }

  function selectAppointment(apptId: string) {
    setSelectedApptId(apptId);
    const appt = appointments.find((a) => a.id === apptId);
    if (!appt) return;
    setSelectedClientId(appt.client_id);
    notifyDemoAction("select-appointment");
  }

  function handleAppointmentCancelled() {
    setSelectedApptId(null);
    router.refresh();
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
      employeeHours={employeeHoursState}
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
      canMutateOperationalData={entitlement.canMutateOperationalData}
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
          bannerVariant={entitlement.bannerVariant}
          recoveryAction={entitlement.recoveryAction}
        />
        {modalEl}
      </>
    );
  }

  // --- DESKTOP LAYOUT (unchanged, except the Demo Mode banner/settings restriction for tester sessions) ---
  return (
    <DemoExperienceProvider autoStart={isTester}>
    <div className="h-screen flex flex-col bg-slate-100 text-slate-900 overflow-hidden">
      {isTester && (
        <div className="shrink-0 bg-amber-400 text-amber-950 text-center text-xs font-semibold py-1.5 px-4">
          Demo Mode — All information shown in Demo Mode is fictional and for testing only.
        </div>
      )}
      <OwnerBillingBanner bannerVariant={entitlement.bannerVariant} recoveryAction={entitlement.recoveryAction} />
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
              <div data-tour="schedule-grid" className="min-h-0 pb-2" style={{ flex: "68 1 0%" }}>
                <ScheduleGrid
                  viewMode={viewMode}
                  clients={clients}
                  appointments={appointments}
                  services={services}
                  employees={employees}
                  employeeHours={employeeHoursState}
                  selectedClientId={selectedClientId}
                  selectedAppointmentId={selectedApptId}
                  onSelectAppointment={handleSelectAppointment}
                  onEditAppointment={handleEditAppointment}
                  onCellClick={handleCellClick}
                  onDropAppointment={handleDropAppointment}
                  weekOffset={weekOffset}
                  canMutateOperationalData={entitlement.canMutateOperationalData}
                />
              </div>

              {/* Client workspace — 32% of available height */}
              <div className="min-h-0 overflow-auto" style={{ flex: "32 1 0%" }}>
                {selectedAppt ? (
                  <AppointmentDetailPanel
                    appointment={selectedAppt}
                    client={clients.find((c) => c.id === selectedAppt.client_id) ?? null}
                    employee={selectedApptEmployee}
                    services={services}
                    onEdit={() => handleEditAppointment(selectedAppt.id)}
                    onCancelled={handleAppointmentCancelled}
                    canMutateOperationalData={entitlement.canMutateOperationalData}
                  />
                ) : (
                  <ClientPanel client={selectedClient} appointments={appointments} onClientUpdated={() => router.refresh()} />
                )}
              </div>
            </>
          ) : (
            <DashboardSettingsArea
              isTester={isTester}
              settingsSection={settingsSection}
              onSettingsSelect={setSettingsSection}
              onBack={() => setCenterMode("schedule")}
              onSignOut={handleSignOut}
              signingOut={signingOut}
            />
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
            employeeHours={employeeHoursState}
            selectedAppointmentId={selectedApptId}
            onHoursSaved={handleHoursSaved}
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
          canMutateOperationalData={entitlement.canMutateOperationalData}
        />
      )}
    </div>
    {isTester && <MobileExperiencePreview />}
    {isTester && <DemoExperienceOverlay />}
    </DemoExperienceProvider>
  );
}
