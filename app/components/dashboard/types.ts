export type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  archived_at?: string | null;
  address?: string | null;
  client_since?: string | null;
  referred_by?: string | null;
  status?: string | null;
  notes?: string | null;
  preferred_contact_method?: string | null;
  auto_email?: boolean | null;
  auto_sms?: boolean | null;
};

export type Appointment = {
  id: string;
  client_id: string;
  service_type: string;
  scheduled_for: string;
  status: "scheduled" | "cancelled";
  notes: string | null;
  duration_minutes?: number | null;
  scheduled_end?: string | null;
  series_id?: string | null;
  frequency_type?: string | null;
  repeat_weeks?: number | null;
  // Phase 2 (Monthly Recurring Appointments): the repeat interval in
  // months for a monthly series (migrations/023) -- null for every
  // non-monthly appointment, mirroring repeat_weeks' role for a weekly
  // series. A monthly series never uses repeat_weeks, and a weekly series
  // never uses this field.
  repeat_months?: number | null;
  // Phase 5.7D-R18: read-only compatibility mirror, not the authoritative
  // assignment -- null whenever zero or two-or-more employees are
  // assigned (see AppointmentEmployeeAssignment below and
  // lib/appointmentEmployees.ts's deriveLegacyEmployeeId). No application
  // logic reads this field to decide "who is assigned" as of this phase.
  employee_id?: string | null;
  // Phase 5.7D-R18: frozen historical data as of this phase -- Job
  // Tracking Start/Complete no longer writes to these two fields at all
  // (see app/api/appointments/job/route.ts). Per-employee tracking lives
  // on AppointmentEmployeeAssignment.actual_started_at/actual_completed_at
  // below instead.
  actual_started_at?: string | null;
  actual_completed_at?: string | null;
  // Phase 5.7D-R17: an independent price snapshot taken at create/edit time
  // (see migrations/020) -- never recomputed from the service's current
  // default price. null means no price was ever set for this appointment.
  price_cents?: number | null;
  // Phase 5.7D-R19: the shared card accent color for an appointment with
  // two or more assigned employees (see migrations/022 and
  // lib/teamColor.ts). null means no explicit selection -- ignored
  // entirely at 0 or 1 assignments, and resolved to a deterministic
  // fallback (the first-assigned employee's own color) at 2+ assignments.
  // Never read directly; always go through lib/teamColor.ts's
  // resolveTeamAccentColor.
  team_color?: string | null;
};

export type Service = {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  active: boolean;
  color: string;
  // Phase 5.7D-R17: optional default price in integer cents (migrations/020).
  // null means no default price has been set -- distinct from a real $0.00.
  default_price_cents?: number | null;
};

export type Employee = {
  id: string;
  name: string;
  phone: string | null;
  color: string;
  active: boolean;
  position?: string | null;
};

export type EmployeeHours = {
  id: string;
  appointment_id: string;
  employee_id: string | null;
  hours_worked: number;
  note: string | null;
  created_at: string;
  updated_at: string;
};

// Phase 5.7D-R18: one row per employee assigned to an appointment
// (migrations/021). appointments.employee_id remains as a read-only
// compatibility mirror (see lib/appointmentEmployees.ts's
// deriveLegacyEmployeeId) but this table is the authoritative source for
// "who is assigned" and for per-employee Job Tracking timestamps --
// actual_started_at/actual_completed_at here, NOT on Appointment, are what
// each assigned employee's own Start/Complete actions read and write.
export type AppointmentEmployeeAssignment = {
  id: string;
  appointment_id: string;
  employee_id: string;
  actual_started_at: string | null;
  actual_completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MobileTab = "schedule" | "clients" | "settings" | "map";
export type ViewMode = "day" | "weekdays" | "week";
export type CenterMode = "schedule" | "settings";
export type SettingsSection = "company" | "services" | "staff" | "archived";
