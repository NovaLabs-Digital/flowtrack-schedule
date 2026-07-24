"use client";

import { useState } from "react";
import { Client, Appointment, Service, Employee } from "@/app/components/dashboard/types";
import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";
import MobileAppointmentCard from "@/app/components/mobile/MobileAppointmentCard";
import MobileAppointmentDetail from "@/app/components/mobile/MobileAppointmentDetail";
import MobileClientDrawer from "@/app/components/mobile/MobileClientDrawer";
import MobileClientsList from "@/app/components/mobile/MobileClientsList";
import MobileSettings from "@/app/components/mobile/MobileSettings";
import MobileBottomNav, { MobileTabKey } from "@/app/components/mobile/MobileBottomNav";
import MobileSchedule from "@/app/components/mobile/MobileSchedule";
import OwnerBillingBanner, { OwnerBillingBannerProps } from "@/app/components/dashboard/OwnerBillingBanner";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";

// Phase 5.5E-E1C: this control's own restricted notice, distinct from every
// other component's -- see TopBar.tsx for the matching desktop constant and
// the reason each of these ids must be unique.
const RESTRICTED_NOTICE_ID = "mobile-dashboard-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

type Props = {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  onAdd: () => void;
  onEditAppointment: (apptId: string) => void;
  onClientUpdated: () => void;
  isTester: boolean;
  // Phase 5.5D: the same two Phase 5.5B browser-safe fields OwnerBillingBanner
  // takes on desktop -- never the full EntitlementView, never a raw result.
  bannerVariant: OwnerBillingBannerProps["bannerVariant"];
  recoveryAction: OwnerBillingBannerProps["recoveryAction"];
  // Phase 5.5E-E1C: threaded to the "+ Add Appointment" control below --
  // still just the Phase 5.5B browser-safe projection, never a raw
  // EntitlementResult.
  canMutateOperationalData: boolean;
};

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function scheduledMinutes(appt: Appointment, services: Service[]): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins;
  }
  if (appt.duration_minutes) return appt.duration_minutes;
  const svc = services.find((s) => s.name === appt.service_type);
  return svc?.duration_minutes ?? 60;
}

// Mobile Admin v1 — full approved mockup: Today screen (Screen 1),
// Appointment Detail (Screen 2), Client Quick Look drawer (Screen 3),
// persistent bottom navigation (Screen 4) with Schedule (Agenda List),
// Clients, and Settings tabs. Settings is a minimal placeholder for v1
// (see MobileSettings.tsx).
export default function MobileDashboard({
  clients,
  appointments,
  services,
  employees,
  onAdd,
  onEditAppointment,
  onClientUpdated,
  isTester,
  bannerVariant,
  recoveryAction,
  canMutateOperationalData,
}: Props) {
  const [activeTab, setActiveTab] = useState<MobileTabKey>("today");
  const [dayOffset, setDayOffset] = useState(0);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);
  const [clientDrawerId, setClientDrawerId] = useState<string | null>(null);

  // When this runs inside the Interactive Business Experience's live mobile
  // preview (an iframe), let the parent window know a tab was opened — the
  // demo-experience bus lives in a separate JS realm per frame, so a plain
  // module-level subscription can't cross the boundary; postMessage can.
  function handleTabChange(tab: MobileTabKey) {
    setActiveTab(tab);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "sft-mobile-tab-changed", tab }, window.location.origin);
    }
  }

  const today = nowInBusinessTz();
  const selectedDate = addDays(today, dayOffset);
  const isToday = sameDay(selectedDate, today);

  const clientById: Record<string, Client> = {};
  for (const c of clients) clientById[c.id] = c;
  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;
  const serviceColorByName: Record<string, string> = {};
  for (const s of services) if (s.color) serviceColorByName[s.name] = s.color;

  const dayAppts = appointments
    .filter((a) => a.status !== "cancelled" && sameDay(toBusinessLocal(a.scheduled_for), selectedDate))
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  const strip = [-2, -1, 0, 1, 2].map((i) => addDays(selectedDate, i));

  const selectedAppt = selectedApptId ? appointments.find((a) => a.id === selectedApptId) ?? null : null;
  const drawerClient = clientDrawerId ? clientById[clientDrawerId] ?? null : null;

  return (
    <div className="h-[100dvh] flex flex-col bg-slate-100 text-slate-900 overflow-hidden safe-area-top">
      {isTester && (
        <div className="shrink-0 bg-amber-400 text-amber-950 text-center text-[11px] font-semibold py-1 px-3">
          Demo Mode — fictional data, for testing only.
        </div>
      )}
      <OwnerBillingBanner bannerVariant={bannerVariant} recoveryAction={recoveryAction} />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {selectedAppt ? (
          <MobileAppointmentDetail
            appointment={selectedAppt}
            client={clientById[selectedAppt.client_id] ?? null}
            employee={selectedAppt.employee_id ? employeeById[selectedAppt.employee_id] ?? null : null}
            durationMinutes={scheduledMinutes(selectedAppt, services)}
            onBack={() => setSelectedApptId(null)}
            onEdit={() => onEditAppointment(selectedAppt.id)}
            onCancelled={() => {
              setSelectedApptId(null);
              onClientUpdated();
            }}
            onViewClient={() => setClientDrawerId(selectedAppt.client_id)}
          />
        ) : (
          <>
            {activeTab === "today" && (
              <>
                {/* Top bar */}
                <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center bg-blue-600 text-white text-xs font-bold">
                        FTS
                      </div>
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-900 truncate">
                          {isToday ? "Today" : selectedDate.toLocaleDateString(undefined, { weekday: "long" })}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 text-slate-400">
                      <button type="button" className="w-8 h-8 flex items-center justify-center" title="Search (coming soon)">
                        🔍
                      </button>
                      <button type="button" className="w-8 h-8 flex items-center justify-center" title="Notifications (coming soon)">
                        🔔
                      </button>
                    </div>
                  </div>
                </div>

                {/* Day strip */}
                <div className="shrink-0 bg-white border-b border-slate-200 px-2 py-2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDayOffset((o) => o - 1)}
                    className="w-8 h-8 shrink-0 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-lg"
                    aria-label="Previous day"
                  >
                    ‹
                  </button>
                  <div className="flex-1 grid grid-cols-5 gap-1">
                    {strip.map((d, i) => {
                      const selected = sameDay(d, selectedDate);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setDayOffset(dayOffset + (i - 2))}
                          className="flex flex-col items-center gap-0.5 py-1 rounded-lg"
                        >
                          <span className="text-[10px] font-medium text-slate-400 uppercase">
                            {d.toLocaleDateString(undefined, { weekday: "short" })}
                          </span>
                          <span
                            className={[
                              "w-7 h-7 flex items-center justify-center rounded-full text-sm font-medium",
                              selected ? "bg-slate-900 text-white" : "text-slate-700",
                            ].join(" ")}
                          >
                            {d.getDate()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDayOffset((o) => o + 1)}
                    className="w-8 h-8 shrink-0 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-lg"
                    aria-label="Next day"
                  >
                    ›
                  </button>
                </div>

                {/* Count header */}
                <div className="shrink-0 px-4 py-2.5 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                  </span>
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-600">
                    {dayAppts.length} appointment{dayAppts.length !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* Appointment list */}
                <div className="flex-1 min-h-0 overflow-auto px-4 pb-4 space-y-2">
                  {dayAppts.length === 0 ? (
                    <div className="text-center py-16">
                      <div className="text-3xl text-slate-300 mb-3">📅</div>
                      <div className="text-sm text-slate-500">No appointments {isToday ? "today" : "on this day"}</div>
                    </div>
                  ) : (
                    dayAppts.map((a) => (
                      <MobileAppointmentCard
                        key={a.id}
                        appointment={a}
                        client={clientById[a.client_id] ?? null}
                        employee={a.employee_id ? employeeById[a.employee_id] ?? null : null}
                        serviceColor={serviceColorByName[a.service_type] ?? null}
                        durationMinutes={scheduledMinutes(a, services)}
                        onTap={() => setSelectedApptId(a.id)}
                      />
                    ))
                  )}
                </div>

                {/* Add Appointment */}
                <div className="shrink-0 px-4 pb-3 pt-1">
                  {!canMutateOperationalData && (
                    <div
                      id={RESTRICTED_NOTICE_ID}
                      className="mb-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                    >
                      {RESTRICTED_WORDING}
                    </div>
                  )}
                  <CapabilityGatedButton
                    type="button"
                    allowed={canMutateOperationalData}
                    onClick={onAdd}
                    ariaDescribedBy={RESTRICTED_NOTICE_ID}
                    className="w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white active:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    + Add Appointment
                  </CapabilityGatedButton>
                </div>
              </>
            )}

            {activeTab === "schedule" && (
              <MobileSchedule
                appointments={appointments}
                clientById={clientById}
                employeeById={employeeById}
                serviceColorByName={serviceColorByName}
                getDurationMinutes={(a) => scheduledMinutes(a, services)}
                onSelectAppointment={setSelectedApptId}
              />
            )}

            {activeTab === "clients" && (
              <MobileClientsList clients={clients} onSelectClient={setClientDrawerId} />
            )}

            {activeTab === "settings" && <MobileSettings isTester={isTester} />}
          </>
        )}
      </div>

      <MobileBottomNav active={activeTab} onChange={handleTabChange} />

      {drawerClient && (
        <MobileClientDrawer
          client={drawerClient}
          appointments={appointments}
          onClose={() => setClientDrawerId(null)}
        />
      )}
    </div>
  );
}
