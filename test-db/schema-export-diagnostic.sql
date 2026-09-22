-- DIAGNOSTIC for test-db/schema-export.sql -- run this ONCE in the Supabase SQL Editor.
--
-- READ-ONLY: reads only system catalogs (never a business table), writes nothing,
-- creates nothing. The transaction is switched to read-only first. The report
-- comes back as the text of an ERROR titled "EXPORTER DIAGNOSTIC REPORT": that is
-- the intended output (an error is the one way a script with no writes can return
-- text after catching failures). Copy the whole message and send it back.
--
-- What it runs, each step in its own protected block so one failure cannot hide
-- the rest (every step's text is the exporter's own text, not a rewrite):
--   C1..C4  the COMPLETE exporter, four variants: C1 original as first sent, C2 =
--           C1 with the CTE forced to MATERIALIZED, C3 = C1 with the sequence
--           section's regclass cast replaced, C4 = the current hardened exporter.
--   A01..   every UNION branch of the original exporter alone.
--   B02..   the original's branches 1..k combined (finds where a union first breaks).
--   H01..   every UNION branch of the hardened exporter alone.
--   CONTEXT facts about the session and counts of objects. Counts are counts only:
--           they say nothing about which privileges exist or whether RLS is on.
DO $diag$
DECLARE
  v1 text := $v1$
-- SCHEMA-ONLY export of the `public` schema, for restoring into the disposable
-- test PostgreSQL (see test-db/SCHEMA_VALIDATION.md).
--
-- READ-ONLY and DATA-FREE: one SELECT over system catalogs (pg_class,
-- pg_attribute, pg_constraint, pg_index, pg_proc, pg_trigger, pg_policy,
-- pg_default_acl, ...). It never reads any business table (no clients,
-- appointments, employees, ... rows), writes nothing, and needs no credentials
-- beyond a normal Supabase SQL Editor session.
--
-- Returns ONE row with ONE text cell: a SQL script. Copy that cell into
-- test-db/production-schema.sql (gitignored). Covers: enum types, sequences,
-- tables (columns/defaults/NOT NULL/generated), primary/unique/check/foreign
-- key/exclusion constraints, indexes, views, functions (full definitions),
-- triggers, RLS enablement, policies, table/function grants for PUBLIC/anon/
-- authenticated/service_role, and the default privileges for `public`.
-- Not covered (not needed by the recurrence functions): comments, partitioned
-- tables, other schemas, column-level grants, ownership.

WITH stmts (ord, sub, stmt) AS (

  SELECT 0, 'a', '-- schema-only export of public; server ' || current_setting('server_version')
  UNION ALL
  SELECT 0, 'b', '-- extensions installed: ' ||
         COALESCE((SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension), '(none)')
  UNION ALL
  SELECT 1, 'a', 'SET check_function_bodies = off;'

  -- enum types
  UNION ALL
  SELECT 5, t.typname,
         format('CREATE TYPE public.%I AS ENUM (%s);', t.typname,
                (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid))
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype = 'e'

  -- sequences that are not identity sequences
  UNION ALL
  SELECT 8, s.sequencename,
         format('CREATE SEQUENCE public.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s %s;',
                s.sequencename, s.data_type, s.increment_by, s.min_value, s.max_value, s.start_value,
                CASE WHEN s.cycle THEN 'CYCLE' ELSE 'NO CYCLE' END)
  FROM pg_sequences s
  WHERE s.schemaname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.objid = ('public.' || quote_ident(s.sequencename))::regclass AND d.deptype = 'i')

  -- tables
  UNION ALL
  SELECT 10, c.relname,
         format('CREATE TABLE public.%I (%s);', c.relname,
           (SELECT string_agg(
              format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                CASE WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                     WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
                     ELSE '' END,
                CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END),
              ', ' ORDER BY a.attnum)
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'

  -- constraints: keys first, then checks, then foreign keys / exclusions
  UNION ALL
  SELECT CASE k.contype WHEN 'p' THEN 30 WHEN 'u' THEN 30 WHEN 'c' THEN 31 ELSE 32 END,
         c.relname || '.' || k.conname,
         format('ALTER TABLE ONLY public.%I ADD CONSTRAINT %I %s;', c.relname, k.conname, pg_get_constraintdef(k.oid))
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND k.contype IN ('p', 'u', 'c', 'f', 'x')

  -- indexes that no constraint owns
  UNION ALL
  SELECT 35, ic.relname, pg_get_indexdef(i.indexrelid) || ';'
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname = 'public' AND tc.relkind = 'r'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)

  -- functions (not extension-owned)
  UNION ALL
  SELECT 40, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid) || ';'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')

  -- views
  UNION ALL
  SELECT 45, c.relname, format('CREATE VIEW public.%I AS %s', c.relname, pg_get_viewdef(c.oid, true))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v'

  -- triggers
  UNION ALL
  SELECT 50, c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ';'
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal

  -- row level security
  UNION ALL
  SELECT 60, c.relname,
         format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', c.relname)
         || CASE WHEN c.relforcerowsecurity THEN format(' ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', c.relname) ELSE '' END
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity

  UNION ALL
  SELECT 61, p.tablename || '.' || p.policyname,
         format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
                p.policyname, p.tablename, p.permissive, p.cmd,
                array_to_string(ARRAY(SELECT CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END FROM unnest(p.roles) r), ', '),
                CASE WHEN p.qual IS NOT NULL THEN ' USING (' || p.qual || ')' ELSE '' END,
                CASE WHEN p.with_check IS NOT NULL THEN ' WITH CHECK (' || p.with_check || ')' ELSE '' END)
  FROM pg_policies p
  WHERE p.schemaname = 'public'

  -- table grants: reset the four roles, then restore exactly what exists
  UNION ALL
  SELECT 70, c.relname,
         format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role;', c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')

  UNION ALL
  SELECT 71, c.relname || '.' || COALESCE(r.rolname, 'PUBLIC'),
         format('GRANT %s ON TABLE public.%I TO %s;', string_agg(DISTINCT x.privilege_type, ', '), c.relname,
                COALESCE(quote_ident(r.rolname), 'PUBLIC'))
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
    AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
  GROUP BY c.relname, r.rolname

  -- function grants (a NULL ACL is the default: PUBLIC may execute; nothing to restore)
  UNION ALL
  SELECT 72, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role;',
                p.proname, pg_get_function_identity_arguments(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proacl IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')

  UNION ALL
  SELECT 73, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ').' || COALESCE(r.rolname, 'PUBLIC'),
         format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO %s;',
                p.proname, pg_get_function_identity_arguments(p.oid), COALESCE(quote_ident(r.rolname), 'PUBLIC'))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(p.proacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')

  -- default privileges for `public` (last: they must not touch the tables above,
  -- only the tables the migrations create next)
  UNION ALL
  SELECT DISTINCT 80,
         CASE a.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' END
           || '.' || COALESCE(r.rolname, 'PUBLIC') || '.' || x.privilege_type,
         format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT %s ON %s TO %s;', x.privilege_type,
                CASE a.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' END,
                COALESCE(quote_ident(r.rolname), 'PUBLIC'))
  FROM pg_default_acl a
  JOIN pg_namespace n ON n.oid = a.defaclnamespace
  CROSS JOIN LATERAL aclexplode(a.defaclacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND a.defaclobjtype IN ('r', 'S', 'f')
    AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
)
SELECT string_agg(stmt, E'\n' ORDER BY ord, sub) AS schema_script FROM stmts
$v1$;
  v4 text := $v4$
-- SCHEMA-ONLY export of the `public` schema, for restoring into the disposable
-- test PostgreSQL (see test-db/SCHEMA_VALIDATION.md).
--
-- READ-ONLY and DATA-FREE: one SELECT over system catalogs (pg_class,
-- pg_attribute, pg_constraint, pg_index, pg_proc, pg_trigger, pg_policy,
-- pg_default_acl, ...). It never reads any business table (no clients,
-- appointments, employees, ... rows), writes nothing, and needs no credentials
-- beyond a normal Supabase SQL Editor session.
--
-- Returns ONE row with ONE text cell: a SQL script. Copy that cell into
-- test-db/production-schema.sql (gitignored). Covers: enum types, sequences,
-- tables (columns/defaults/NOT NULL/generated), primary/unique/check/foreign
-- key/exclusion constraints, indexes, views, functions (full definitions),
-- triggers, RLS enablement, policies, table/function grants for PUBLIC/anon/
-- authenticated/service_role, and the default privileges for `public`.
-- NOT covered: comments, ownership, other schemas, domains, composite/range
-- types, materialized views, partitioned tables (partitions come out as plain
-- tables), identity columns (come out as plain columns), procedures, aggregates,
-- column-level grants, grant options, sequence values. The first lines of the
-- output ("-- NOT EXPORTED ...") count each of these as they exist in the source.
-- Counts in that header are counts only: they say nothing about permissions or
-- whether RLS is enabled (the explicit GRANT/REVOKE and ENABLE ROW LEVEL SECURITY
-- statements below carry that).
-- If this query fails, run test-db/schema-export-diagnostic.sql (see
-- test-db/SCHEMA_VALIDATION.md).

WITH stmts (ord, sub, stmt) AS MATERIALIZED (

  SELECT 0::integer, 'a'::text, '-- schema-only export of public; server ' || current_setting('server_version')
  UNION ALL
  SELECT 0::integer, 'b'::text, '-- extensions installed: ' ||
         COALESCE((SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension), '(none)')
  UNION ALL
  SELECT 0::integer, 'c'::text, '-- NOT EXPORTED (a restore will lack these; counts of what exists in public): ' ||
         'domains=' || (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                        WHERE n.nspname = 'public' AND t.typtype = 'd') ||
         ', composite/range types=' || (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                        LEFT JOIN pg_class rc ON rc.oid = t.typrelid
                        WHERE n.nspname = 'public' AND (t.typtype = 'r' OR (t.typtype = 'c' AND rc.relkind = 'c'))) ||
         ', materialized views=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'm') ||
         ', partitioned tables (skipped)=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'p') ||
         ', partitions (exported as ordinary tables)=' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relispartition) ||
         ', identity columns (restored as plain columns)=' || (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> '') ||
         ', procedures and aggregates=' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind IN ('p', 'a')) ||
         ', columns with column-level grants=' || (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND a.attacl IS NOT NULL) ||
         ', sequences outside public=' || (SELECT count(*) FROM pg_sequences WHERE schemaname <> 'public')
  UNION ALL
  SELECT 1::integer, 'a'::text, 'SET check_function_bodies = off;'
  UNION ALL
  SELECT 1::integer, 'b'::text, 'SET search_path = public;'

  -- enum types
  UNION ALL
  SELECT 5, t.typname::text,
         format('CREATE TYPE public.%I AS ENUM (%s);', t.typname,
                (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
                 FROM pg_enum e WHERE e.enumtypid = t.oid))
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype = 'e'

  -- sequences that are not identity sequences
  UNION ALL
  SELECT 8, s.sequencename::text,
         format('CREATE SEQUENCE public.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s %s;',
                s.sequencename, s.data_type, s.increment_by, s.min_value, s.max_value, s.start_value,
                CASE WHEN s.cycle THEN 'CYCLE' ELSE 'NO CYCLE' END)
  FROM pg_sequences s
  WHERE s.schemaname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    JOIN pg_class sc ON sc.oid = d.objid
                    JOIN pg_namespace sn ON sn.oid = sc.relnamespace
                    WHERE d.deptype = 'i' AND sc.relkind = 'S' AND sn.nspname = s.schemaname AND sc.relname = s.sequencename)

  -- tables
  UNION ALL
  SELECT 10, c.relname::text,
         format('CREATE TABLE public.%I (%s);', c.relname,
           (SELECT string_agg(
              format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                CASE WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                     WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid)
                     ELSE '' END,
                CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END),
              ', ' ORDER BY a.attnum)
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'

  -- constraints: keys first, then checks, then foreign keys / exclusions
  UNION ALL
  SELECT CASE k.contype WHEN 'p' THEN 30 WHEN 'u' THEN 30 WHEN 'c' THEN 31 ELSE 32 END,
         c.relname || '.' || k.conname,
         format('ALTER TABLE ONLY public.%I ADD CONSTRAINT %I %s;', c.relname, k.conname, pg_get_constraintdef(k.oid))
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND k.contype IN ('p', 'u', 'c', 'f', 'x')

  -- indexes that no constraint owns
  UNION ALL
  SELECT 35, ic.relname::text, pg_get_indexdef(i.indexrelid) || ';'
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname = 'public' AND tc.relkind = 'r'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)

  -- functions (not extension-owned)
  UNION ALL
  SELECT 40, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid) || ';'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')

  -- views
  UNION ALL
  SELECT 45, c.relname::text, format('CREATE VIEW public.%I AS %s', c.relname, pg_get_viewdef(c.oid, true))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v'

  -- triggers
  UNION ALL
  SELECT 50, c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ';'
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND NOT t.tgisinternal

  -- row level security
  UNION ALL
  SELECT 60, c.relname::text,
         format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', c.relname)
         || CASE WHEN c.relforcerowsecurity THEN format(' ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', c.relname) ELSE '' END
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity

  UNION ALL
  SELECT 61, p.tablename || '.' || p.policyname,
         format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s%s%s;',
                p.policyname, p.tablename, p.permissive, p.cmd,
                array_to_string(ARRAY(SELECT CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END FROM unnest(p.roles) r), ', '),
                CASE WHEN p.qual IS NOT NULL THEN ' USING (' || p.qual || ')' ELSE '' END,
                CASE WHEN p.with_check IS NOT NULL THEN ' WITH CHECK (' || p.with_check || ')' ELSE '' END)
  FROM pg_policies p
  WHERE p.schemaname = 'public'

  -- table grants: reset the four roles, then restore exactly what exists
  UNION ALL
  SELECT 70, c.relname::text,
         format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role;', c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')

  UNION ALL
  SELECT 71, c.relname || '.' || COALESCE(r.rolname, 'PUBLIC'),
         format('GRANT %s ON TABLE public.%I TO %s;', string_agg(DISTINCT x.privilege_type, ', '), c.relname,
                COALESCE(quote_ident(r.rolname), 'PUBLIC'))
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
    AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
  GROUP BY c.relname, r.rolname

  -- function grants (a NULL ACL is the default: PUBLIC may execute; nothing to restore)
  UNION ALL
  SELECT 72, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role;',
                p.proname, pg_get_function_identity_arguments(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proacl IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')

  UNION ALL
  SELECT 73, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ').' || COALESCE(r.rolname, 'PUBLIC'),
         format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO %s;',
                p.proname, pg_get_function_identity_arguments(p.oid), COALESCE(quote_ident(r.rolname), 'PUBLIC'))
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(p.proacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND p.prokind = 'f'
    AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')

  -- default privileges for `public` (last: they must not touch the tables above,
  -- only the tables the migrations create next)
  UNION ALL
  SELECT DISTINCT 80,
         CASE a.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' END
           || '.' || COALESCE(r.rolname, 'PUBLIC') || '.' || x.privilege_type,
         format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT %s ON %s TO %s;', x.privilege_type,
                CASE a.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' END,
                COALESCE(quote_ident(r.rolname), 'PUBLIC'))
  FROM pg_default_acl a
  JOIN pg_namespace n ON n.oid = a.defaclnamespace
  CROSS JOIN LATERAL aclexplode(a.defaclacl) x
  LEFT JOIN pg_roles r ON r.oid = x.grantee
  WHERE n.nspname = 'public' AND a.defaclobjtype IN ('r', 'S', 'f')
    AND (x.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'))
)
SELECT string_agg(stmt, E'\n' ORDER BY ord, sub) AS schema_script FROM stmts
$v4$;
  v2 text; v3 text;
  ob text[]; obl text[]; hb text[]; hbl text[];
  j_code text[] := '{}'; j_label text[] := '{}'; j_kind text[] := '{}'; j_sql text[] := '{}';
  rep text := ''; failed text := '';
  i int; k int; cnt bigint; len bigint; tier text; tier_ok text := ''; tier_bad text := ''; seen text := '';
  m text; st text; cx text; det text;
  head text; body text; pieces text[];
  cred text := E'\\n\\s*UNION ALL\\s*\\n';
BEGIN
  SET LOCAL transaction_read_only = on;

  -- ---- CONTEXT ---------------------------------------------------------
  BEGIN
    rep := rep || format(E'CONTEXT server=%s | user=%s | superuser=%s | read_only=%s | search_path=%s\n',
      current_setting('server_version'), current_user, current_setting('is_superuser'),
      current_setting('transaction_read_only'), current_setting('search_path'));
    rep := rep || format(E'CONTEXT to_regclass(''public'')=%s | relations named public=%s | functions named public=%s | types named public=%s\n',
      COALESCE(to_regclass('public')::text, 'null'),
      (SELECT count(*) FROM pg_class WHERE relname = 'public'),
      (SELECT count(*) FROM pg_proc WHERE proname = 'public'),
      (SELECT count(*) FROM pg_type WHERE typname = 'public'));
    rep := rep || format(E'CONTEXT counts (not permissions): public tables=%s | public functions=%s | public sequences=%s | sequences in other schemas=%s | non-internal triggers=%s | policies=%s | extensions=%s\n',
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      (SELECT count(*) FROM pg_sequences WHERE schemaname = 'public'),
      (SELECT count(*) FROM pg_sequences WHERE schemaname <> 'public'),
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal),
      (SELECT count(*) FROM pg_policies),
      (SELECT count(*) FROM pg_extension));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, st = RETURNED_SQLSTATE;
    rep := rep || format(E'CONTEXT FAILED sqlstate=%s message=%s\n', st, m);
  END;

  -- ---- build the variants and the branch lists --------------------------
  v2 := replace(v1, 'WITH stmts (ord, sub, stmt) AS (', 'WITH stmts (ord, sub, stmt) AS MATERIALIZED (');
  v3 := replace(v1,
    $r$WHERE d.objid = ('public.' || quote_ident(s.sequencename))::regclass AND d.deptype = 'i')$r$,
    $r$JOIN pg_class sc ON sc.oid = d.objid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
                    WHERE d.deptype = 'i' AND sc.relkind = 'S' AND sn.nspname = s.schemaname AND sc.relname = s.sequencename)$r$);

  FOR i IN 1..2 LOOP
    head := CASE i WHEN 1 THEN v1 ELSE v4 END;
    body := substring(head from 'AS (?:MATERIALIZED )?\((.*)\)\s*SELECT string_agg');
    pieces := regexp_split_to_array(body, cred);
    FOR k IN 1..coalesce(array_length(pieces, 1), 0) LOOP
      DECLARE
        prev_line text := CASE WHEN k > 1 THEN regexp_replace(rtrim(pieces[k - 1]), '^.*\n', '') END;
        lbl text := CASE WHEN prev_line ~ '^\s*--' THEN trim(regexp_replace(prev_line, '^\s*--\s*', '')) END;
        sqltxt text := regexp_replace(pieces[k], '^\s*--[^\n]*$', '', 'gn');
      BEGIN
        IF lbl IS NULL THEN lbl := 'header: ' || left(regexp_replace(trim(sqltxt), '\s+', ' ', 'g'), 50); END IF;
        IF i = 1 THEN ob := array_append(coalesce(ob, '{}'), trim(sqltxt)); obl := array_append(coalesce(obl, '{}'), lbl);
        ELSE hb := array_append(coalesce(hb, '{}'), trim(sqltxt)); hbl := array_append(coalesce(hbl, '{}'), lbl); END IF;
      END;
    END LOOP;
  END LOOP;

  -- ---- job list ----------------------------------------------------------
  j_code := array_append(j_code, 'C1'); j_label := array_append(j_label, 'COMPLETE exporter, original as first sent'); j_kind := array_append(j_kind, 'f'); j_sql := array_append(j_sql, v1);
  j_code := array_append(j_code, 'C2'); j_label := array_append(j_label, 'COMPLETE original + CTE MATERIALIZED');     j_kind := array_append(j_kind, 'f'); j_sql := array_append(j_sql, v2);
  j_code := array_append(j_code, 'C3'); j_label := array_append(j_label, 'COMPLETE original + cast-free sequence predicate'); j_kind := array_append(j_kind, 'f'); j_sql := array_append(j_sql, v3);
  j_code := array_append(j_code, 'C4'); j_label := array_append(j_label, 'COMPLETE hardened exporter (current file)'); j_kind := array_append(j_kind, 'f'); j_sql := array_append(j_sql, v4);
  FOR k IN 1..coalesce(array_length(ob, 1), 0) LOOP
    j_code := array_append(j_code, format('A%s', lpad(k::text, 2, '0'))); j_label := array_append(j_label, ('original branch alone: ' || obl[k]));
    j_kind := array_append(j_kind, 'b'); j_sql := array_append(j_sql, ob[k]);
  END LOOP;
  FOR k IN 2..coalesce(array_length(ob, 1), 0) LOOP
    j_code := array_append(j_code, format('B%s', lpad(k::text, 2, '0'))); j_label := array_append(j_label, format('original branches 1..%s combined (UNION ALL)', k));
    j_kind := array_append(j_kind, 'b'); j_sql := array_append(j_sql, array_to_string(ob[1:k], E'\nUNION ALL\n'));
  END LOOP;
  FOR k IN 1..coalesce(array_length(hb, 1), 0) LOOP
    j_code := array_append(j_code, format('H%s', lpad(k::text, 2, '0'))); j_label := array_append(j_label, ('hardened branch alone: ' || hbl[k]));
    j_kind := array_append(j_kind, 'b'); j_sql := array_append(j_sql, hb[k]);
  END LOOP;

  -- ---- run every job in its own protected block -------------------------
  FOR i IN 1..array_length(j_code, 1) LOOP
    BEGIN
      IF j_kind[i] = 'f' THEN
        EXECUTE 'SELECT count(*), COALESCE(sum(length(schema_script)), 0) FROM (' || j_sql[i] || ') q' INTO cnt, len;
        rep := rep || format(E'%s OK      %s chars | %s\n', rpad(j_code[i], 4), len, j_label[i]);
      ELSE
        EXECUTE 'SELECT count(*), COALESCE(sum(length(stmt::text)), 0) FROM (' || j_sql[i] || ') q(ord, sub, stmt)' INTO cnt, len;
        tier_ok := tier_ok || (left(j_code[i], 1) || '=' || j_code[i] || ' ');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, st = RETURNED_SQLSTATE, cx = PG_EXCEPTION_CONTEXT, det = PG_EXCEPTION_DETAIL;
      failed := failed || j_code[i] || ' ';
      IF j_kind[i] = 'f' THEN
        rep := rep || format(E'%s FAILED  sqlstate=%s | message=%s | detail=%s | %s\n', rpad(j_code[i], 4), st, m, coalesce(det, ''), j_label[i]);
      ELSE
        tier_bad := tier_bad || (left(j_code[i], 1) || '=' || j_code[i] || ' ');
        -- full detail only the first time a given error appears within a tier
        IF position((left(j_code[i], 1) || '|' || st || '|' || m) IN seen) = 0 THEN
          seen := seen || (left(j_code[i], 1) || '|' || st || '|' || m || E'\n');
          rep := rep || format(E'%s FAILED  sqlstate=%s | message=%s | detail=%s | %s\n', rpad(j_code[i], 4), st, m, coalesce(det, ''), j_label[i]);
        END IF;
      END IF;
    END;
  END LOOP;

  FOREACH tier IN ARRAY ARRAY['A', 'B', 'H'] LOOP
    rep := rep || format(E'%s (%s): OK=[%s] FAILED=[%s]\n', tier,
      CASE tier WHEN 'A' THEN 'original branches, each alone' WHEN 'B' THEN 'original branches 1..k combined' ELSE 'hardened branches, each alone' END,
      array_to_string(ARRAY(SELECT substr(t, 3) FROM unnest(string_to_array(trim(tier_ok), ' ')) t WHERE left(t, 2) = tier || '='), ' '),
      array_to_string(ARRAY(SELECT substr(t, 3) FROM unnest(string_to_array(trim(tier_bad), ' ')) t WHERE left(t, 2) = tier || '='), ' '));
  END LOOP;
  rep := rep || E'\nBRANCH LEGEND (original): ';
  FOR k IN 1..coalesce(array_length(ob, 1), 0) LOOP rep := rep || format('A%s=%s; ', lpad(k::text, 2, '0'), obl[k]); END LOOP;
  rep := rep || E'\nFAILED STEPS: ' || CASE WHEN failed = '' THEN '(none -- every step succeeded)' ELSE failed END;
  RAISE EXCEPTION 'EXPORTER DIAGNOSTIC REPORT (intentional: this error IS the output; nothing was changed)%', E'\n' || rep
    USING ERRCODE = 'P0001';
END
$diag$;
