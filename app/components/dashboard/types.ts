export type Client = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type Appointment = {
  id: string;
  client_id: string;
  service_type: string;
  scheduled_for: string;
  status: "scheduled" | "cancelled";
  notes: string | null;
  duration_minutes?: number | null;
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
  | "future";
