"use client";

import { useMemo, useState } from "react";
import TopBar from "@/components/dashboard/TopBar";
import LeftBar, { ViewMode, CenterMode, SettingsSection } from "@/components/dashboard/LeftBar";
import ScheduleGrid, { FakeAppointment } from "@/components/dashboard/ScheduleGrid";
import SettingsPanel from "@/components/dashboard/SettingsPanel";
import { FakeClient } from "@/components/dashboard/types";

const FAKE_CLIENTS: FakeClient[] = [
  {
    id: "c1",
    name: "Alberto W Oliveira",
    address: "1526 Victory Palm, Edgewater, FL",
    email: "alberto@example.com",
    phone: "386-264-1920",
    status: "Active",
    comms: { autoEmail: false, autoSms: false },
    dob: "1989-05-12",
    clientSince: "2022-03-10",
    note: "Prefers text after 5pm. Has gate code.",
    foundUs: "Referral",
  },
  {
    id: "c2",
    name: "Maria Sanchez",
    address: "901 Ocean Ave, New Smyrna Beach, FL",
    email: "maria@example.com",
    phone: "407-555-0198",
    status: "Active",
    comms: { autoEmail: true, autoSms: true },
    dob: "1991-09-02",
    clientSince: "2023-08-21",
    note: "Landlord contact. Keep receipts.",
    foundUs: "Google",
  },
  {
    id: "c3",
    name: "Tom Landry",
    address: "44 Pine St, Edgewater, FL",
    email: "tom@example.com",
    phone: "321-555-0144",
    status: "Inactive",
    comms: { autoEmail: false, autoSms: false },
    dob: "1978-01-19",
    clientSince: "2020-11-05",
    note: "Do not schedule weekends.",
    foundUs: "Website",
  },
];

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(base: Date, days: number) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

const FAKE_APPOINTMENTS: FakeAppointment[] = [
  {
    id: "a1",
    clientId: "c1",
    title: "Estimate • Bathroom",
    date: addDays(startOfToday(), 0),
    startHour: 10,
    durationMins: 60,
    status: "Planned",
  },
  {
    id: "a2",
    clientId: "c2",
    title: "Job • Tile demo",
    date: addDays(startOfToday(), 1),
    startHour: 13,
    durationMins: 120,
    status: "Confirmed",
  },
  {
    id: "a3",
    clientId: "c3",
    title: "Follow-up • Quote",
    date: addDays(startOfToday(), 2),
    startHour: 9,
    durationMins: 30,
    status: "Canceled",
  },
];

export default function DashboardPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("weekdays"); // day | weekdays | week
  const [centerMode, setCenterMode] = useState<CenterMode>("schedule"); // schedule | settings
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("company");

  const [clientsHidden, setClientsHidden] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);

  const selectedClient = useMemo(() => {
    if (!selectedClientId) return null;
    return FAKE_CLIENTS.find((c) => c.id === selectedClientId) ?? null;
  }, [selectedClientId]);

  const selectedAppt = useMemo(() => {
    if (!selectedApptId) return null;
    return FAKE_APPOINTMENTS.find((a) => a.id === selectedApptId) ?? null;
  }, [selectedApptId]);

  function handleSelectClient(clientId: string) {
    setSelectedClientId(clientId);
    setSelectedApptId(null);
    // Keep schedule visible unless user is already in settings
  }

  function handleSelectAppointment(apptId: string) {
    setSelectedApptId(apptId);
    const appt = FAKE_APPOINTMENTS.find((a) => a.id === apptId);
    if (appt) setSelectedClientId(appt.clientId);
  }

  function handleGoToday() {
    // skeleton: just clears selection; real version will scroll/center today
    setCenterMode("schedule");
    setSelectedApptId(null);
  }

  function handleAdd() {
    // skeleton only
    alert("v1: Add appointment (coming next). Layout is locked ✅");
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <TopBar
        client={selectedClient}
        onGoToday={handleGoToday}
        onAdd={handleAdd}
        // Card #3 is intentionally empty for now
      />

      <div className="mx-auto max-w-[1400px] px-4 pb-6">
        <div className="mt-4 grid grid-cols-12 gap-4">
          {/* Left Vertical Bar */}
          <div className="col-span-12 md:col-span-3 lg:col-span-2">
            <LeftBar
              viewMode={viewMode}
              onChangeView={(m) => {
                setViewMode(m);
                setCenterMode("schedule");
              }}
              centerMode={centerMode}
              onOpenSettings={(section) => {
                setCenterMode("settings");
                setSettingsSection(section);
              }}
              clients={FAKE_CLIENTS}
              clientsHidden={clientsHidden}
              onToggleClientsHidden={() => setClientsHidden((v) => !v)}
              selectedClientId={selectedClientId}
              onSelectClient={handleSelectClient}
            />
          </div>

          {/* Center Workspace */}
          <div className="col-span-12 md:col-span-9 lg:col-span-10">
            {centerMode === "schedule" ? (
              <ScheduleGrid
                viewMode={viewMode}
                clients={FAKE_CLIENTS}
                appointments={FAKE_APPOINTMENTS}
                selectedClientId={selectedClientId}
                selectedAppointmentId={selectedApptId}
                onSelectAppointment={handleSelectAppointment}
              />
            ) : (
              <SettingsPanel section={settingsSection} />
            )}
          </div>
        </div>

        {/* Debug strip (optional, remove later) */}
        <div className="mt-4 text-xs text-slate-500">
          <span className="mr-4">Mode: {centerMode}</span>
          <span className="mr-4">View: {viewMode}</span>
          <span className="mr-4">Selected client: {selectedClient?.name ?? "none"}</span>
          <span>Selected appt: {selectedAppt?.title ?? "none"}</span>
        </div>
      </div>
    </div>
  );
}
