// Generates test-db/schema-export-diagnostic.sql from the two exporter files, so
// the diagnostic always tests the EXACT text of the exporters it reports on.
//   node test-db/build-export-diagnostic.mjs          # (re)writes the file
// test-db/schema-export-diagnostic.test.ts fails if the checked-in file is stale.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `override` exists only so the test can inject a fault into an exporter's text.
export function buildDiagnostic(override = {}) {
  const asQuery = (text) => text.trimEnd().replace(/;$/, "");
  const v1 = asQuery(override.v1 ?? readFileSync(path.join(HERE, "schema-export.v1.sql"), "utf8"));
  const v4 = asQuery(override.v4 ?? readFileSync(path.join(HERE, "schema-export.sql"), "utf8"));
  for (const [tag, text] of [["v1", v1], ["v4", v4]]) {
    if (text.includes(`$${tag}$`) || text.includes("$diag$")) throw new Error(`exporter ${tag} contains a reserved dollar-quote tag`);
  }

  return `-- DIAGNOSTIC for test-db/schema-export.sql -- run this ONCE in the Supabase SQL Editor.
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
${v1}
$v1$;
  v4 text := $v4$
${v4}
$v4$;
  v2 text; v3 text;
  ob text[]; obl text[]; hb text[]; hbl text[];
  j_code text[] := '{}'; j_label text[] := '{}'; j_kind text[] := '{}'; j_sql text[] := '{}';
  rep text := ''; failed text := '';
  i int; k int; cnt bigint; len bigint; tier text; tier_ok text := ''; tier_bad text := ''; seen text := '';
  m text; st text; cx text; det text;
  head text; body text; pieces text[];
  cred text := E'\\\\n\\\\s*UNION ALL\\\\s*\\\\n';
BEGIN
  SET LOCAL transaction_read_only = on;

  -- ---- CONTEXT ---------------------------------------------------------
  BEGIN
    rep := rep || format(E'CONTEXT server=%s | user=%s | superuser=%s | read_only=%s | search_path=%s\\n',
      current_setting('server_version'), current_user, current_setting('is_superuser'),
      current_setting('transaction_read_only'), current_setting('search_path'));
    rep := rep || format(E'CONTEXT to_regclass(''public'')=%s | relations named public=%s | functions named public=%s | types named public=%s\\n',
      COALESCE(to_regclass('public')::text, 'null'),
      (SELECT count(*) FROM pg_class WHERE relname = 'public'),
      (SELECT count(*) FROM pg_proc WHERE proname = 'public'),
      (SELECT count(*) FROM pg_type WHERE typname = 'public'));
    rep := rep || format(E'CONTEXT counts (not permissions): public tables=%s | public functions=%s | public sequences=%s | sequences in other schemas=%s | non-internal triggers=%s | policies=%s | extensions=%s\\n',
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'),
      (SELECT count(*) FROM pg_sequences WHERE schemaname = 'public'),
      (SELECT count(*) FROM pg_sequences WHERE schemaname <> 'public'),
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal),
      (SELECT count(*) FROM pg_policies),
      (SELECT count(*) FROM pg_extension));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, st = RETURNED_SQLSTATE;
    rep := rep || format(E'CONTEXT FAILED sqlstate=%s message=%s\\n', st, m);
  END;

  -- ---- build the variants and the branch lists --------------------------
  v2 := replace(v1, 'WITH stmts (ord, sub, stmt) AS (', 'WITH stmts (ord, sub, stmt) AS MATERIALIZED (');
  v3 := replace(v1,
    $r$WHERE d.objid = ('public.' || quote_ident(s.sequencename))::regclass AND d.deptype = 'i')$r$,
    $r$JOIN pg_class sc ON sc.oid = d.objid JOIN pg_namespace sn ON sn.oid = sc.relnamespace
                    WHERE d.deptype = 'i' AND sc.relkind = 'S' AND sn.nspname = s.schemaname AND sc.relname = s.sequencename)$r$);

  FOR i IN 1..2 LOOP
    head := CASE i WHEN 1 THEN v1 ELSE v4 END;
    body := substring(head from 'AS (?:MATERIALIZED )?\\((.*)\\)\\s*SELECT string_agg');
    pieces := regexp_split_to_array(body, cred);
    FOR k IN 1..coalesce(array_length(pieces, 1), 0) LOOP
      DECLARE
        prev_line text := CASE WHEN k > 1 THEN regexp_replace(rtrim(pieces[k - 1]), '^.*\\n', '') END;
        lbl text := CASE WHEN prev_line ~ '^\\s*--' THEN trim(regexp_replace(prev_line, '^\\s*--\\s*', '')) END;
        sqltxt text := regexp_replace(pieces[k], '^\\s*--[^\\n]*$', '', 'gn');
      BEGIN
        IF lbl IS NULL THEN lbl := 'header: ' || left(regexp_replace(trim(sqltxt), '\\s+', ' ', 'g'), 50); END IF;
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
    j_kind := array_append(j_kind, 'b'); j_sql := array_append(j_sql, array_to_string(ob[1:k], E'\\nUNION ALL\\n'));
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
        rep := rep || format(E'%s OK      %s chars | %s\\n', rpad(j_code[i], 4), len, j_label[i]);
      ELSE
        EXECUTE 'SELECT count(*), COALESCE(sum(length(stmt::text)), 0) FROM (' || j_sql[i] || ') q(ord, sub, stmt)' INTO cnt, len;
        tier_ok := tier_ok || (left(j_code[i], 1) || '=' || j_code[i] || ' ');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, st = RETURNED_SQLSTATE, cx = PG_EXCEPTION_CONTEXT, det = PG_EXCEPTION_DETAIL;
      failed := failed || j_code[i] || ' ';
      IF j_kind[i] = 'f' THEN
        rep := rep || format(E'%s FAILED  sqlstate=%s | message=%s | detail=%s | %s\\n', rpad(j_code[i], 4), st, m, coalesce(det, ''), j_label[i]);
      ELSE
        tier_bad := tier_bad || (left(j_code[i], 1) || '=' || j_code[i] || ' ');
        -- full detail only the first time a given error appears within a tier
        IF position((left(j_code[i], 1) || '|' || st || '|' || m) IN seen) = 0 THEN
          seen := seen || (left(j_code[i], 1) || '|' || st || '|' || m || E'\\n');
          rep := rep || format(E'%s FAILED  sqlstate=%s | message=%s | detail=%s | %s\\n', rpad(j_code[i], 4), st, m, coalesce(det, ''), j_label[i]);
        END IF;
      END IF;
    END;
  END LOOP;

  FOREACH tier IN ARRAY ARRAY['A', 'B', 'H'] LOOP
    rep := rep || format(E'%s (%s): OK=[%s] FAILED=[%s]\\n', tier,
      CASE tier WHEN 'A' THEN 'original branches, each alone' WHEN 'B' THEN 'original branches 1..k combined' ELSE 'hardened branches, each alone' END,
      array_to_string(ARRAY(SELECT substr(t, 3) FROM unnest(string_to_array(trim(tier_ok), ' ')) t WHERE left(t, 2) = tier || '='), ' '),
      array_to_string(ARRAY(SELECT substr(t, 3) FROM unnest(string_to_array(trim(tier_bad), ' ')) t WHERE left(t, 2) = tier || '='), ' '));
  END LOOP;
  rep := rep || E'\\nBRANCH LEGEND (original): ';
  FOR k IN 1..coalesce(array_length(ob, 1), 0) LOOP rep := rep || format('A%s=%s; ', lpad(k::text, 2, '0'), obl[k]); END LOOP;
  rep := rep || E'\\nFAILED STEPS: ' || CASE WHEN failed = '' THEN '(none -- every step succeeded)' ELSE failed END;
  RAISE EXCEPTION 'EXPORTER DIAGNOSTIC REPORT (intentional: this error IS the output; nothing was changed)%', E'\\n' || rep
    USING ERRCODE = 'P0001';
END
$diag$;
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(HERE, "schema-export-diagnostic.sql"), buildDiagnostic());
  console.log("wrote test-db/schema-export-diagnostic.sql");
}
