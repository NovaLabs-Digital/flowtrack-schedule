-- 011: Descriptive staff position/role field (e.g. Owner, Manager, Cleaner,
-- Technician, Helper). Display-only for now — does not affect permissions,
-- auth, notifications, or scheduling logic.

ALTER TABLE employees ADD COLUMN position TEXT;
