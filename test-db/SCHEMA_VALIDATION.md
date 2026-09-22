# Validating migrations 029/030 against the real schema

Nothing here touches production data or applies anything to production. The only
things Alberto runs against the real database are **read-only, data-free
queries over the system catalogs**; everything else happens on this computer in a
throwaway PostgreSQL.

## Why this is needed

Several core tables (`workspaces`, `clients`, `appointments`, `employees`,
`appointment_employee_hours`, `company_settings`) were created outside the
tracked migrations. The local tests use a hand-built approximation
(`test-db/baseline.sql`). An export of the real schema replaces that guess.

## Step 1 -- run the exporter (Supabase SQL Editor)

1. Supabase dashboard -> the production project -> **SQL Editor** -> New query.
2. Paste the entire contents of `test-db/schema-export.sql` and **Run**.
3. If it returns one row with one cell (`schema_script`): copy that cell into
   `test-db/production-schema.sql` (gitignored). Done -- skip step 2.

## Step 2 -- ONLY if step 1 fails: run the diagnostic ONCE

An earlier exporter failed on Supabase PostgreSQL 17.6 with
`ERROR 42P01: relation "public" does not exist`. That could **not** be reproduced
locally (PostgreSQL 17.10, a Supabase-shaped schema, non-superuser role, empty and
Supabase-like `search_path`, sequences in other schemas), so the cause is
**unknown**; `schema-export.sql` was hardened against the suspects that could be
identified, but no claim is made that this fixes it until it runs on Supabase.

Run `test-db/schema-export-diagnostic.sql` (paste all, Run). It runs the
*complete* exporter in four variants plus every UNION branch alone plus every
branch prefix, each in its own protected block, and returns one labelled report.

- The report is delivered as the text of an **error** titled
  `EXPORTER DIAGNOSTIC REPORT`. That is intentional: it is the only way a script
  that writes nothing can hand back text after catching failures. Copy the whole
  message and send it back.
- It reads catalogs only, never a business table; it sets the transaction
  read-only first and creates/changes nothing.
- How to read it: `C1` = the exporter as first sent, `C2` = plus `MATERIALIZED`,
  `C3` = plus a cast-free sequence predicate, `C4` = the current hardened file.
  `A` = each original branch alone (the legend at the bottom names each), `B` = the
  first N branches combined (the first `B` that fails is where a union breaks),
  `H` = each hardened branch alone. The first line of each failure has the
  SQLSTATE and message; the failing step names the exact expression's branch.
- The diagnostic is generated from the two exporter files by
  `node test-db/build-export-diagnostic.mjs`; a test fails if it is stale.

## Step 3 -- what Claude then runs locally

```
npm run test:db:schema                                              # restore, apply 029/030, audit; also the exporter/diagnostic tests
TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db   # the full functional suite on the real schema
```

- `test:db:schema` restores the export into a disposable PostgreSQL, applies
  **only** 029 and 030 on top, then asserts every column, constraint, index, RLS
  setting, grant, function permission and foreign-key delete rule the new code
  depends on, and prints an inventory of triggers and foreign keys.
- If migrations 026-028 are not in production yet, the restore is missing what 029
  needs and the run fails with that reason -- which is itself the finding.

## What the export does and does not prove

- **It is schema-only.** No table rows are read. The export's header states
  the server version, the installed extensions, and a line beginning
  `-- NOT EXPORTED` with counts of what exists but is not restored.
- **Counts are not permissions.** ACL entry counts, policy counts and trigger
  counts say nothing about what is granted or enforced. The export writes explicit
  `REVOKE`/`GRANT` statements from the real ACLs and explicit
  `ENABLE/FORCE ROW LEVEL SECURITY` per table, so permissions and RLS state come
  from the restored objects, checked by the audit after restore -- never inferred
  from "zero policies" or from entry counts. (A table with RLS enabled and no
  policies denies everything to non-bypass roles; a table with RLS *disabled* and
  no policies does not. Only the per-table flag distinguishes them.)

## Restoration limits (verified against a Supabase-shaped local schema)

Not restored, and reported as counts in the `-- NOT EXPORTED` header:

| Object | What a restore does |
|---|---|
| Domains (`CREATE DOMAIN`) | not exported; a column using one **fails the restore loudly** ("type does not exist") |
| Composite / range types | not exported; same loud failure if a column uses one |
| Materialized views | not exported |
| Partitioned tables | parent skipped; each partition is exported as an ordinary standalone table |
| Identity columns (`GENERATED ... AS IDENTITY`) | restored as plain `NOT NULL` columns (identity and its sequence are lost) |
| Procedures, aggregates | not exported (only ordinary functions) |
| Column-level grants, `WITH GRANT OPTION` | not exported (table/function-level grants only) |
| Comments, ownership, other schemas | not exported |
| Extension-owned functions/types | not exported; a default or type needing an extension the local PostgreSQL lacks fails the restore loudly |
| Sequence *current values* | not exported (sequences restart) |
| Grants to roles other than PUBLIC/anon/authenticated/service_role | not exported |

Defaults are rendered as PostgreSQL prints them for the exporting session's
`search_path`; the export sets `search_path = public` before its own statements so
both qualified and unqualified spellings restore identically.

None of these affects migrations 029/030 unless the real schema uses them in the
tables those migrations touch -- and if it does, the restore fails loudly rather
than silently differing.
