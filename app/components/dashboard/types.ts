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
};

export type Service = {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  active: boolean;
};

export type ViewMode = "day" | "weekdays" | "week";
export type CenterMode = "schedule" | "settings";
export type SettingsSection =
  | "company"
  | "services"
  | "staff"
  | "preferences"
  | "colors"
  | "darkmode"
  | "future"
  | "archived";
