-- 013: Demo/tester data isolation. Tags rows belonging to the fictional
-- "Sunshine Property Services" demo dataset so tester sessions only ever
-- see/create/edit demo rows, never the real business's data.

ALTER TABLE clients      ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE employees    ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE services     ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_clients_is_demo      ON clients(is_demo);
CREATE INDEX IF NOT EXISTS idx_appointments_is_demo ON appointments(is_demo);
CREATE INDEX IF NOT EXISTS idx_employees_is_demo    ON employees(is_demo);
CREATE INDEX IF NOT EXISTS idx_services_is_demo     ON services(is_demo);
