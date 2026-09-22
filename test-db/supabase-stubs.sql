-- Minimal stand-ins for what Supabase provides around the `public` schema, so
-- either test-db/baseline.sql (hand-built tables) or an exported production
-- schema (test-db/schema-export.sql -> test-db/production-schema.sql) can be
-- loaded into a plain disposable PostgreSQL. Test-only; never applied anywhere
-- shared. Default privileges are deliberately NOT set here: the baseline sets
-- them before creating its tables, and an exported schema restores the exact
-- privileges (and default privileges) production has.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

-- Tables reference auth.users(id) (profiles); policies may call auth.uid().
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
CREATE FUNCTION auth.jwt() RETURNS JSONB LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;

-- Supabase installs extensions here; the exported header lists which ones
-- production has, so a default such as extensions.uuid_generate_v4() that
-- cannot be restored shows up as a clear restore error, not a silent gap.
CREATE SCHEMA extensions;
