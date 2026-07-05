-- 012: Owner-controlled toggle for the public /book page. Defaults to
-- false so no business accidentally exposes public booking after deploy.

ALTER TABLE company_settings ADD COLUMN booking_enabled boolean NOT NULL DEFAULT false;
