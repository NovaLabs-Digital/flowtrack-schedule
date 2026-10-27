"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, PanelRightClose, PanelRightOpen } from "lucide-react";
import TopBar from "@/app/components/dashboard/TopBar";
import LeftBar from "@/app/components/dashboard/LeftBar";
import ScheduleGrid from "@/app/components/dashboard/ScheduleGrid";
import ScheduleMonthGrid from "@/app/components/dashboard/ScheduleMonthGrid";
import DashboardSettingsArea from "@/app/components/dashboard/DashboardSettingsArea";
import ClientPanel from "@/app/components/dashboard/ClientPanel";
import AppointmentDetailPanel from "@/app/components/dashboard/AppointmentDetailPanel";
import DispatchPanel from "@/app/components/dashboard/DispatchPanel";
import AppointmentModal from "@/app/components/dashboard/AppointmentModal";
import MoveConfirmDialog from "@/app/components/dashboard/MoveConfirmDialog";
import MobileDashboard from "@/app/components/mobile/MobileDashboard";
import OwnerBillingBanner from "@/app/components/dashboard/OwnerBillingBanner";
import useIsMobile, { useMediaQuery } from "@/app/components/dashboard/useIsMobile";
import ResizeHandle from "@/app/components/dashboard/ResizeHandle";
import {
  useDashboardLayoutPrefs,
  MIN_SCHEDULE_HEIGHT_PCT,
  MAX_SCHEDULE_HEIGHT_PCT,
  MIN_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  LEFT_BAR_WIDTH_PX,
  LEFT_BAR_COLLAPSED_WIDTH_PX,
} from "@/app/components/dashboard/useDashboardLayoutPrefs";
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
  AppointmentEmployeeAssignment,
  ViewMode,
  CenterMode,
  SettingsSection,
} from "@/app/components/dashboard/types";
import type { EntitlementView } from "@/lib/entitlementView";
import { isHistoricalAppointment } from "@/lib/payroll";
import type { BusinessHours } from "@/lib/businessHours";

type ModalState =
  | { mode: "create"; prefillDate?: string; prefillTime?: string }
  | { mode: "edit"; appointment: Appointment; client: Client };

export default function DashboardShell({
  clients,
  appointments,
  services,
  employees,
  employeeHours,
  assignments,
  paidAppointmentIds,
  isTester,
  entitlement,
  timezone,
  businessHours,
  workspaceId,
  userId,
}: {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  // Phase 5.7D-R18: every appointment_employees row for the workspace --
  // the authoritative "who is assigned" source, threaded through to every
  // component that needs to know an appointment's assigned employee(s) or
  // per-employee Job Tracking state (ScheduleGrid, DispatchPanel,
  // AppointmentModal, AppointmentDetailPanel, MobileDashboard).
  assignments: AppointmentEmployeeAssignment[];
  // Calendar Paid Indicator: every appointment_id with a PAID
  // completed_job_billing row in this workspace (see app/dashboard/
  // page.tsx's own comment on this query) -- forwarded only to
  // ScheduleGrid, which renders the small green "$" badge. Not the full
  // Billing report; never touched by BillingPanel's own dedicated
  // date-range API.
  paidAppointmentIds: string[];
  isTester: boolean;
  // Phase 5.5D: consumed by OwnerBillingBanner (desktop below, and passed
  // through to MobileDashboard for the mobile layout) -- only its
  // bannerVariant/recoveryAction fields are ever read there. Phase 5.5E-E1A
  // threaded entitlement.canMutateOperationalData through to AppointmentModal
  // (below); Phase 5.5E-E1B threaded the same value through to
  // AppointmentDetailPanel, ScheduleGrid, and MoveConfirmDialog; Phase
  // 5.5E-E1C threaded it through to TopBar and MobileDashboard's appointment-
  // entry controls; Phase 5.5E-E1D threaded it through to
  // MobileAppointmentDetail; Phase 5.5E-E1E threaded it through to ClientPanel
  // and (via DashboardSettingsArea/SettingsPanel) ArchivedClientsPanel; Phase
  // 5.5E-E1F threaded it through to CompanyInfoPanel/ServicesPanel/StaffPanel.
  // Phase 5.5E-E1G threads entitlement.canUseJobTracking (a different field
  // on this same trusted projection, deliberately not canMutateOperationalData
  // -- see DispatchPanel.tsx) through to DispatchPanel's owner manual
  // worked-hours correction, matching the same capability its server route
  // already enforces. Still just the Phase 5.5B browser-safe projection,
  // never a raw EntitlementResult. canSendNotifications remains unconsumed
  // by any owner UI control.
  entitlement: EntitlementView;
  // Phase 5C: the workspace's own trusted timezone, resolved server-side
  // (app/dashboard/page.tsx, via lib/timezone.ts's effectiveTimezone) and
  // threaded through to every scheduling/display consumer below -- never
  // re-derived from the browser/device's own ambient timezone.
  timezone: string;
  // Resolved server-side (app/dashboard/page.tsx, via
  // lib/businessHours.ts's effectiveBusinessHours) and threaded through to
  // ScheduleGrid only -- Month view (ScheduleMonthGrid) has no hourly axis
  // and does not consume this. The single source of truth for the grid's
  // visible hour range; no second, independent schedule range exists.
  businessHours: BusinessHours;
  // Resizable desktop panel layout: the server-assigned workspace id
  // (never request-derived -- see app/dashboard/page.tsx), used only to
  // scope the saved panel-size preference in localStorage so a tester's
  // fixed demo workspace and a real workspace never share or leak each
  // other's saved sizes on the same browser. Never sent to any server
  // route and never used for data access -- every query that matters is
  // already scoped server-side before this component ever renders.
  workspaceId: string;
  // Paired with workspaceId to scope the same saved layout preference per
  // individual person, not just per tenant -- an owner's real authUserId,
  // or the literal "tester" for demo sessions (see app/dashboard/page.tsx).
  // Same UI-only, never-sent-to-a-server-route rule as workspaceId above.
  userId: string;
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
  // Phase 3: months relative to the current calendar month, for Month view
  // only -- deliberately a separate counter from weekOffset (see TopBar's
  // handlePrev/handleNext), never mixed into the same week-based
  // arithmetic. Switching views never resets or synchronizes either
  // counter against the other (see onChangeView below), matching the
  // approved "no complicated cross-view state synchronization" scope.
  const [monthOffset, setMonthOffset] = useState(0);
  const [clientsHidden, setClientsHidden] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<
    { appointment: Appointment; client: Client; scheduledFor: string; scheduledEnd: string | null } | null
  >(null);

  // Resizable desktop panel layout -- see useDashboardLayoutPrefs.ts for
  // clamping, persistence, and viewport-reclamp behavior. scheduleColumnRef
  // measures the live pixel height of the column holding the schedule
  // grid and the lower details panel, so a vertical drag can be converted
  // into a percentage delta of whatever height is actually available.
  const {
    scheduleHeightPct,
    setScheduleHeightPct,
    sidebarWidthPx,
    setSidebarWidthPx,
    leftCollapsed,
    toggleLeftCollapsed,
    rightCollapsed,
    toggleRightCollapsed,
    resetLayout,
  } = useDashboardLayoutPrefs(workspaceId, userId);
  const scheduleColumnRef = useRef<HTMLDivElement | null>(null);

  function handleScheduleDividerDelta(deltaPx: number) {
    const containerHeight = scheduleColumnRef.current?.clientHeight;
    if (!containerHeight) return;
    const deltaPct = (deltaPx / containerHeight) * 100;
    setScheduleHeightPct((prev) => prev + deltaPct);
  }

  function handleSidebarDividerDelta(deltaPx: number) {
    // Inverted relative to the schedule divider: dragging the sidebar
    // divider right (positive deltaPx) widens main content, which means
    // SHRINKING the controlled value (sidebarWidthPx) -- see
    // ResizeHandle.ts's own onDelta doc comment.
    setSidebarWidthPx((prev) => prev - deltaPx);
  }

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

  // Phase 5.7D-R18: every assignment row for the currently selected
  // appointment, and the resolved Employee objects for them -- replaces the
  // pre-R18 single selectedApptEmployee (appointments.employee_id could
  // only ever represent zero or one employee).
  const selectedApptAssignments = useMemo(() => {
    if (!selectedApptId) return [];
    return assignments.filter((a) => a.appointment_id === selectedApptId);
  }, [selectedApptId, assignments]);

  const selectedApptEmployees = useMemo(() => {
    const byId: Record<string, Employee> = {};
    for (const e of employees) byId[e.id] = e;
    return selectedApptAssignments
      .map((a) => byId[a.employee_id])
      .filter((e): e is Employee => !!e);
  }, [selectedApptAssignments, employees]);

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
    // Historical-record protection (founder decision): a past, completed,
    // or already-cancelled appointment opens for review only -- every
    // "edit" entry point in this app (Past Services rows, the schedule
    // grid's double-click, Month view, this panel's own Edit button,
    // mobile) converges on this one function, so redirecting here to the
    // read-only selection path is what makes the rule apply everywhere at
    // once, rather than needing to be re-applied at each call site. The
    // server independently enforces the same rule (lib/payroll.ts's
    // isHistoricalAppointment, reused verbatim by every mutation route), so
    // this redirect is UI clarity, not the only protection.
    if (isHistoricalAppointment(appt, assignments.filter((a) => a.appointment_id === apptId))) {
      selectAppointment(apptId);
      return;
    }
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
    // Phase 3: harmless no-op outside Month view (monthOffset only affects
    // ScheduleMonthGrid's rendering) -- resetting it unconditionally here,
    // alongside weekOffset, is what makes "Today" correctly return to the
    // current calendar month whenever Month view is active, without any
    // viewMode branching.
    setMonthOffset(0);
  }

  function handleAdd() {
    // Defense-in-depth: the sole shared callback behind both TopBar's
    // desktop "Add Appointment" and MobileDashboard's "+ Add Appointment"
    // (each also guards locally before calling this) -- guarding it here
    // too means create-mode modal state can never open via either entry
    // control, or a stale/programmatic call, while restricted. The
    // ScheduleGrid empty-cell click path (handleCellClick) is a separate
    // function, deliberately not gated here -- it remains out of scope for
    // this phase and stays protected only by AppointmentModal's own E-E1A
    // submit-time guard, exactly as before.
    if (!entitlement.canMutateOperationalData) return;
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
      onHoursSaved={handleHoursSaved}
      assignments={assignments}
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
      canUseJobTracking={entitlement.canUseJobTracking}
      timezone={timezone}
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
          assignments={assignments}
          employeeHours={employeeHoursState}
          onAdd={handleAdd}
          onEditAppointment={handleEditAppointment}
          onClientUpdated={() => router.refresh()}
          isTester={isTester}
          bannerVariant={entitlement.bannerVariant}
          recoveryAction={entitlement.recoveryAction}
          finalAccessDate={entitlement.finalAccessDate}
          readOnlyEndsAt={entitlement.readOnlyEndsAt}
          canMutateOperationalData={entitlement.canMutateOperationalData}
          timezone={timezone}
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
      <OwnerBillingBanner
        bannerVariant={entitlement.bannerVariant}
        recoveryAction={entitlement.recoveryAction}
        finalAccessDate={entitlement.finalAccessDate}
        readOnlyEndsAt={entitlement.readOnlyEndsAt}
        timezone={timezone}
      />
      <div className="flex-1 min-h-0 flex">
      {/* Left bar — full height, never moves. Collapses to a narrow icon
          strip (LeftBar.tsx owns its own collapsed rendering and toggle
          button); width here is the only thing DashboardShell controls. */}
      <aside
        className="shrink-0 p-2 pr-0"
        style={{ width: leftCollapsed ? LEFT_BAR_COLLAPSED_WIDTH_PX : LEFT_BAR_WIDTH_PX }}
      >
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
          collapsed={leftCollapsed}
          onToggleCollapsed={toggleLeftCollapsed}
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
          monthOffset={monthOffset}
          onMonthChange={setMonthOffset}
          viewMode={viewMode}
          canMutateOperationalData={entitlement.canMutateOperationalData}
        />

        <div ref={scheduleColumnRef} className="flex-1 min-h-0 flex flex-col px-2 pb-2">
          {centerMode === "schedule" ? (
            <>
              {/* Schedule grid — scheduleHeightPct of available height
                  (default 68%, user-resizable via the divider below).
                  Phase 3: Month view swaps in the dedicated
                  ScheduleMonthGrid overview here; Day/Weekdays/Week
                  continue to render through the existing hourly
                  ScheduleGrid, completely unchanged. Everything else on
                  this page (left bar, top bar, dispatch panel, client/
                  appointment detail area below) is identical regardless of
                  which one renders. */}
              <div
                data-tour="schedule-grid"
                className="min-h-0 pb-2"
                style={{ flexGrow: 0, flexShrink: 1, flexBasis: `${scheduleHeightPct}%`, minHeight: 220 }}
              >
                {viewMode === "month" ? (
                  <ScheduleMonthGrid
                    appointments={appointments}
                    clients={clients}
                    employees={employees}
                    assignments={assignments}
                    selectedClientId={selectedClientId}
                    selectedAppointmentId={selectedApptId}
                    onSelectAppointment={handleSelectAppointment}
                    onEditAppointment={handleEditAppointment}
                    monthOffset={monthOffset}
                    timezone={timezone}
                  />
                ) : (
                  <ScheduleGrid
                    viewMode={viewMode}
                    clients={clients}
                    appointments={appointments}
                    services={services}
                    employees={employees}
                    employeeHours={employeeHoursState}
                    assignments={assignments}
                    selectedClientId={selectedClientId}
                    selectedAppointmentId={selectedApptId}
                    onSelectAppointment={handleSelectAppointment}
                    onEditAppointment={handleEditAppointment}
                    onCellClick={handleCellClick}
                    onDropAppointment={handleDropAppointment}
                    weekOffset={weekOffset}
                    canMutateOperationalData={entitlement.canMutateOperationalData}
                    timezone={timezone}
                    businessHours={businessHours}
                    paidAppointmentIds={paidAppointmentIds}
                  />
                )}
              </div>

              {/* Draggable divider: up enlarges the details panel below,
                  down enlarges the calendar above. The reset button
                  restores both this split and the sidebar width below to
                  their default proportions in one action. */}
              <div className="relative shrink-0">
                <ResizeHandle
                  orientation="horizontal"
                  ariaLabel="Resize calendar and details panel"
                  valueNow={scheduleHeightPct}
                  valueMin={MIN_SCHEDULE_HEIGHT_PCT}
                  valueMax={MAX_SCHEDULE_HEIGHT_PCT}
                  valueText={`Calendar ${Math.round(scheduleHeightPct)}% of available height`}
                  onDelta={handleScheduleDividerDelta}
                  onJumpToMin={() => setScheduleHeightPct(MIN_SCHEDULE_HEIGHT_PCT)}
                  onJumpToMax={() => setScheduleHeightPct(MAX_SCHEDULE_HEIGHT_PCT)}
                />
                <button
                  type="button"
                  onClick={resetLayout}
                  title="Reset layout"
                  aria-label="Reset panel layout to default sizes"
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-md p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 transition-colors"
                >
                  <RotateCcw aria-hidden="true" size={12} />
                </button>
              </div>

              {/* Client workspace — fills the remaining height below the
                  schedule grid and divider. */}
              <div className="min-h-0 overflow-auto" style={{ flex: "1 1 0%", minHeight: 160 }}>
                {selectedAppt ? (
                  <AppointmentDetailPanel
                    appointment={selectedAppt}
                    client={clients.find((c) => c.id === selectedAppt.client_id) ?? null}
                    employees={selectedApptEmployees}
                    services={services}
                    assignments={selectedApptAssignments}
                    employeeHours={employeeHoursState}
                    onEdit={() => handleEditAppointment(selectedAppt.id)}
                    onCancelled={handleAppointmentCancelled}
                    canMutateOperationalData={entitlement.canMutateOperationalData}
                    timezone={timezone}
                  />
                ) : (
                  <ClientPanel
                    client={selectedClient}
                    appointments={appointments}
                    onClientUpdated={() => router.refresh()}
                    canMutateOperationalData={entitlement.canMutateOperationalData}
                    timezone={timezone}
                    onEditAppointment={handleEditAppointment}
                  />
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
              canMutateOperationalData={entitlement.canMutateOperationalData}
              isTrialing={entitlement.isTrialing}
              timezone={timezone}
              workspaceId={workspaceId}
              userId={userId}
            />
          )}
        </div>
      </div>

      {/* Right dispatch panel — hidden on phone landscape. Collapsible:
          when collapsed, neither the draggable divider nor the panel
          itself renders, only a slim reopen strip. Draggable divider when
          expanded: left widens the sidebar, right widens main content. */}
      {!isPhoneLandscape && (
        rightCollapsed ? (
          <div className="shrink-0 w-9 p-2 pl-0 flex flex-col items-center">
            <button
              type="button"
              onClick={toggleRightCollapsed}
              title="Show dispatch panel"
              aria-label="Show dispatch panel"
              aria-expanded={false}
              className="flex items-center justify-center rounded-lg border border-slate-300 bg-white p-1.5 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 transition-colors"
            >
              <PanelRightOpen aria-hidden="true" size={16} />
            </button>
          </div>
        ) : (
          <>
            <div className="relative shrink-0 self-stretch">
              <ResizeHandle
                orientation="vertical"
                ariaLabel="Resize main content and dispatch sidebar"
                valueNow={sidebarWidthPx}
                valueMin={MIN_SIDEBAR_WIDTH_PX}
                valueMax={MAX_SIDEBAR_WIDTH_PX}
                valueText={`Sidebar ${Math.round(sidebarWidthPx)} pixels wide`}
                onDelta={handleSidebarDividerDelta}
                onJumpToMin={() => setSidebarWidthPx(MIN_SIDEBAR_WIDTH_PX)}
                onJumpToMax={() => setSidebarWidthPx(MAX_SIDEBAR_WIDTH_PX)}
              />
              <button
                type="button"
                onClick={toggleRightCollapsed}
                title="Collapse dispatch panel"
                aria-label="Collapse dispatch panel"
                aria-expanded={true}
                className="absolute left-1/2 top-2 -translate-x-1/2 flex items-center justify-center rounded-md p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 transition-colors"
              >
                <PanelRightClose aria-hidden="true" size={12} />
              </button>
            </div>
            <aside data-tour="dispatch-sidebar" className="shrink-0 p-2 pl-0" style={{ width: sidebarWidthPx }}>
            <DispatchPanel
              appointments={appointments}
              clients={clients}
              employees={employees}
              employeeHours={employeeHoursState}
              assignments={assignments}
              selectedAppointmentId={selectedApptId}
              onHoursSaved={handleHoursSaved}
              canUseJobTracking={entitlement.canUseJobTracking}
              timezone={timezone}
            />
            </aside>
          </>
        )
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
          timezone={timezone}
        />
      )}
    </div>
    {isTester && <MobileExperiencePreview />}
    {isTester && <DemoExperienceOverlay />}
    </DemoExperienceProvider>
  );
}
