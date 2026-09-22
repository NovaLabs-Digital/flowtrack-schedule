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
SELECT string_agg(stmt, E'\n' ORDER BY ord, sub) AS schema_script FROM stmts;
