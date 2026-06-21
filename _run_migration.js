const fs = require("fs");
const lines = fs.readFileSync(".env.local", "utf8").split("\n");
const env = {};
lines.forEach((l) => {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i)] = l.slice(i + 1).trim();
});

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function runSQL(label, sql) {
  console.log(`\n=== ${label} ===`);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  // rpc won't work for DDL — use the pg-meta SQL endpoint instead
}

async function execSQL(sql) {
  const res = await fetch(`${SUPABASE_URL}/pg/query`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "x-connection-encrypted": "true",
    },
    body: JSON.stringify({ query: sql }),
  });
  return { status: res.status, body: await res.text() };
}

const STEP1 = `
CREATE TABLE IF NOT EXISTS profiles (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        text NOT NULL,
  company_name text,
  created_at   timestamptz DEFAULT now()
);
COMMENT ON TABLE profiles IS 'One profile per Supabase Auth user. Scopes all business data.';
`;

const STEP2 = `
CREATE TABLE IF NOT EXISTS services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name             text NOT NULL,
  default_duration integer,
  default_price    numeric(10, 2),
  active           boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);
COMMENT ON TABLE services IS 'Service catalog for the business.';
COMMENT ON COLUMN services.default_duration IS 'Duration in minutes.';
`;

const STEP3 = `
CREATE TABLE IF NOT EXISTS message_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name       text NOT NULL,
  subject    text,
  message    text NOT NULL,
  active     boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE message_templates IS 'Reusable communication templates.';
`;

const STEP4 = `
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS address    text;
`;

const STEP5 = `
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS profile_id       uuid REFERENCES profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS service_id       uuid REFERENCES services(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS appointment_date date,
  ADD COLUMN IF NOT EXISTS start_time       time,
  ADD COLUMN IF NOT EXISTS end_time         time,
  ADD COLUMN IF NOT EXISTS price            numeric(10, 2);
`;

const STEP6 = `
CREATE INDEX IF NOT EXISTS idx_clients_profile_id ON clients (profile_id);
CREATE INDEX IF NOT EXISTS idx_services_profile_id ON services (profile_id);
CREATE INDEX IF NOT EXISTS idx_appointments_profile_id ON appointments (profile_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON appointments (client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);
CREATE INDEX IF NOT EXISTS idx_message_templates_profile_id ON message_templates (profile_id);
`;

const STEP7 = `
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE services          ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (id = auth.uid());
DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT WITH CHECK (id = auth.uid());
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "clients_select_own" ON clients;
CREATE POLICY "clients_select_own" ON clients FOR SELECT USING (profile_id = auth.uid());
DROP POLICY IF EXISTS "clients_insert_own" ON clients;
CREATE POLICY "clients_insert_own" ON clients FOR INSERT WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "clients_update_own" ON clients;
CREATE POLICY "clients_update_own" ON clients FOR UPDATE USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "clients_delete_own" ON clients;
CREATE POLICY "clients_delete_own" ON clients FOR DELETE USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "services_select_own" ON services;
CREATE POLICY "services_select_own" ON services FOR SELECT USING (profile_id = auth.uid());
DROP POLICY IF EXISTS "services_insert_own" ON services;
CREATE POLICY "services_insert_own" ON services FOR INSERT WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "services_update_own" ON services;
CREATE POLICY "services_update_own" ON services FOR UPDATE USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "services_delete_own" ON services;
CREATE POLICY "services_delete_own" ON services FOR DELETE USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "appointments_select_own" ON appointments;
CREATE POLICY "appointments_select_own" ON appointments FOR SELECT USING (profile_id = auth.uid());
DROP POLICY IF EXISTS "appointments_insert_own" ON appointments;
CREATE POLICY "appointments_insert_own" ON appointments FOR INSERT WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "appointments_update_own" ON appointments;
CREATE POLICY "appointments_update_own" ON appointments FOR UPDATE USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "appointments_delete_own" ON appointments;
CREATE POLICY "appointments_delete_own" ON appointments FOR DELETE USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "templates_select_own" ON message_templates;
CREATE POLICY "templates_select_own" ON message_templates FOR SELECT USING (profile_id = auth.uid());
DROP POLICY IF EXISTS "templates_insert_own" ON message_templates;
CREATE POLICY "templates_insert_own" ON message_templates FOR INSERT WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "templates_update_own" ON message_templates;
CREATE POLICY "templates_update_own" ON message_templates FOR UPDATE USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());
DROP POLICY IF EXISTS "templates_delete_own" ON message_templates;
CREATE POLICY "templates_delete_own" ON message_templates FOR DELETE USING (profile_id = auth.uid());
`;

const STEP8 = `
CREATE OR REPLACE FUNCTION fts_seed_default_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO services (profile_id, name, default_duration, default_price, active) VALUES
    (NEW.id, 'Regular Cleaning',  120, NULL, true),
    (NEW.id, 'Deep Cleaning',     180, NULL, true),
    (NEW.id, 'Move-Out Cleaning', 240, NULL, true),
    (NEW.id, 'Office Cleaning',   120, NULL, true);

  INSERT INTO message_templates (profile_id, name, subject, message, active) VALUES
    (NEW.id, 'Welcome Message', 'Welcome to {company_name}', 'Hi {client_name}, thank you for choosing {company_name}. We look forward to serving you. If you have any questions, please don''t hesitate to reach out.', true),
    (NEW.id, 'Appointment Confirmation', 'Your appointment is confirmed', 'Hi {client_name}, your appointment is confirmed for {appointment_date} at {appointment_time}. Service: {service_name}. See you then!', true),
    (NEW.id, '24-Hour Reminder', 'Reminder: appointment tomorrow', 'Hi {client_name}, this is a reminder that your appointment with {company_name} is scheduled for tomorrow, {appointment_date} at {appointment_time}.', true),
    (NEW.id, 'Cancellation Notice', 'Your appointment has been cancelled', 'Hi {client_name}, your appointment scheduled for {appointment_date} at {appointment_time} has been cancelled. Please contact us to reschedule.', true),
    (NEW.id, 'Thank You', 'Thank you for your business', 'Hi {client_name}, thank you for choosing {company_name}. We appreciate your business and hope to see you again soon!', true);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fts_on_profile_created ON profiles;
CREATE TRIGGER fts_on_profile_created
  AFTER INSERT ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION fts_seed_default_data();

COMMENT ON FUNCTION fts_seed_default_data IS 'Seeds default services and message templates when a new profile is created.';
`;

const steps = [
  ["STEP 1 — CREATE profiles", STEP1],
  ["STEP 2 — CREATE services", STEP2],
  ["STEP 3 — CREATE message_templates", STEP3],
  ["STEP 4 — ALTER clients", STEP4],
  ["STEP 5 — ALTER appointments", STEP5],
  ["STEP 6 — INDEXES", STEP6],
  ["STEP 7 — RLS + POLICIES", STEP7],
  ["STEP 8 — SEED TRIGGER", STEP8],
];

async function main() {
  for (const [label, sql] of steps) {
    const r = await execSQL(sql);
    if (r.status === 200 || r.status === 201) {
      console.log(`OK: ${label}`);
    } else {
      console.log(`FAIL (${r.status}): ${label}`);
      console.log(r.body);
      console.log("--- STOPPING ---");
      return;
    }
  }
  console.log("\nAll 8 steps completed.");
}

main().catch((e) => console.error("FATAL:", e));
