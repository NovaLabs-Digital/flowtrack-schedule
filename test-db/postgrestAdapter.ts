// Test-only: a minimal supabase-js-shaped client over a REAL PostgreSQL
// (the embedded test database), so app code that talks to Supabase/PostgREST
// can run unchanged against real tables, constraints and RPCs.
//
// Faithful to the PostgREST behaviors these tests depend on:
//  - every response is capped at MAX_ROWS (Supabase's default 1000), with or
//    without .range()/.limit() -- the exact silent-truncation behavior the
//    capacity fixes are about;
//  - errors come back as { data: null, error: { message } }, never thrown;
//  - timestamps come back as ISO strings; scalar RPCs return their value,
//    set-returning RPCs return rows.
// Supports only the query-builder surface the code under test uses. Column
// lists and identifiers come from application constants, never user input.
//
// Fault injection: `failWhen(call)` can make any table read/write or RPC
// return an error, e.g. "the 2nd page of appointment_employees".
/* eslint-disable @typescript-eslint/no-explicit-any -- test-only stand-in
   for supabase-js's untyped, chainable query builder. */
import pg from "pg";
import { parse as parseArray } from "postgres-array";

export const MAX_ROWS = 1000;

// PostgREST returns timestamps as text at full (microsecond) precision, e.g.
// "2026-11-03T19:39:47.436599+00:00". Code under test compares them for
// equality (compare-and-set on updated_at, the RPC's expected snapshot
// version), so a JS Date (millisecond precision) would be unfaithful.
const pgTimestampText = (v: string) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
export const POSTGREST_TYPES = {
  getTypeParser(oid: number, format?: any) {
    if (oid === 1184 || oid === 1114) return (v: string) => pgTimestampText(v);
    if (oid === 1082) return (v: string) => v; // date: "YYYY-MM-DD", as PostgREST returns it
    if (oid === 1185 || oid === 1115) return (v: string) => parseArray(v, (x: string) => pgTimestampText(x));
    return (pg.types.getTypeParser as any)(oid, format);
  },
};

export type AdapterCall = { kind: "select" | "update" | "insert" | "rpc"; table: string; seq: number; args?: unknown; range?: [number, number] };

// PostgREST passes a database error through as { code: SQLSTATE, message,
// details: DETAIL, hint }; app code branches on `code` (e.g. 'SL001').
function pgError(err: unknown) {
  const e = err as { message?: string; code?: string; detail?: string; hint?: string };
  return { message: e.message ?? String(err), code: e.code, details: e.detail ?? null, hint: e.hint ?? null };
}

type Filter = { sql: string; values: unknown[] };

function toJs(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJs);
  return value;
}
function rowToJs(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = toJs(v);
  return out;
}
const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier ${name}`);
  return `"${name}"`;
};

export function createPostgrestAdapter(pool: pg.Pool, opts: { failWhen?: (call: AdapterCall) => boolean } = {}) {
  const calls: AdapterCall[] = [];
  const perTable = new Map<string, number>();
  const nextSeq = (key: string) => {
    const n = (perTable.get(key) ?? 0) + 1;
    perTable.set(key, n);
    return n;
  };

  function from(table: string) {
    let mode: "select" | "update" | "insert" = "select";
    let columns = "*";
    let returning: string | null = null;
    let patch: Record<string, unknown> | null = null;
    let rowsToInsert: Record<string, unknown>[] = [];
    let countExact = false;
    let headOnly = false;
    let single: "maybe" | "one" | null = null;
    const filters: Filter[] = [];
    const orders: string[] = [];
    let offset = 0;
    let limit: number | null = null;
    let range: [number, number] | undefined;

    const builder: any = {
      select(cols: string = "*", opts: { count?: string; head?: boolean } = {}) {
        if (mode === "update" || mode === "insert") returning = cols;
        else columns = cols;
        countExact = opts.count === "exact";
        headOnly = !!opts.head;
        return builder;
      },
      insert(values: Record<string, unknown> | Record<string, unknown>[]) {
        mode = "insert";
        rowsToInsert = Array.isArray(values) ? values : [values];
        return builder;
      },
      update(values: Record<string, unknown>) {
        mode = "update";
        patch = values;
        return builder;
      },
      eq(col: string, v: unknown) { filters.push({ sql: `${ident(col)} = $?`, values: [v] }); return builder; },
      neq(col: string, v: unknown) { filters.push({ sql: `${ident(col)} <> $?`, values: [v] }); return builder; },
      gt(col: string, v: unknown) { filters.push({ sql: `${ident(col)} > $?`, values: [v] }); return builder; },
      gte(col: string, v: unknown) { filters.push({ sql: `${ident(col)} >= $?`, values: [v] }); return builder; },
      lt(col: string, v: unknown) { filters.push({ sql: `${ident(col)} < $?`, values: [v] }); return builder; },
      lte(col: string, v: unknown) { filters.push({ sql: `${ident(col)} <= $?`, values: [v] }); return builder; },
      is(col: string, v: null | boolean) {
        filters.push({ sql: `${ident(col)} IS ${v === null ? "NULL" : v ? "TRUE" : "FALSE"}`, values: [] });
        return builder;
      },
      in(col: string, vs: unknown[]) {
        filters.push({ sql: `${ident(col)}::text = ANY($?::text[])`, values: [vs.map(String)] });
        return builder;
      },
      order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
        const dir = o.ascending === false ? "DESC" : "ASC";
        const nulls = o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
        orders.push(`${ident(col)} ${dir}${nulls}`);
        return builder;
      },
      range(a: number, b: number) { offset = a; limit = b - a + 1; range = [a, b]; return builder; },
      limit(n: number) { limit = n; return builder; },
      maybeSingle() { single = "maybe"; return builder; },
      single() { single = "one"; return builder; },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return execute().then(resolve, reject);
      },
    };

    async function execute(): Promise<{ data: unknown; error: { message: string; code?: string; details?: string | null; hint?: string | null } | null; count?: number | null }> {
      const call: AdapterCall = { kind: mode, table, seq: nextSeq(`${mode}:${table}`), range };
      calls.push(call);
      if (opts.failWhen?.(call)) return { data: null, error: { message: `injected failure: ${mode} ${table} #${call.seq}` } };

      if (mode === "insert") {
        try {
          const keys = Array.from(new Set(rowsToInsert.flatMap((r) => Object.keys(r))));
          const sql = `INSERT INTO ${ident(table)} (${keys.map(ident).join(", ")})
                       SELECT ${keys.map(ident).join(", ")} FROM jsonb_populate_recordset(NULL::${ident(table)}, $1::jsonb)
                       ${returning ? `RETURNING ${returning}` : ""}`;
          const res = await pool.query(sql, [JSON.stringify(rowsToInsert)]);
          const rows = res.rows.map(rowToJs);
          if (single) {
            if (rows.length !== 1) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: null, hint: null } };
            return { data: rows[0], error: null };
          }
          return { data: returning ? rows : null, error: null };
        } catch (err) {
          return { data: null, error: pgError(err) };
        }
      }

      const values: unknown[] = [];
      const whereSql = filters.length
        ? " WHERE " +
          filters
            .map((f) => {
              let i = 0;
              return f.sql.replace(/\$\?/g, () => {
                values.push(f.values[i++]);
                return `$${values.length}`;
              });
            })
            .join(" AND ")
        : "";
      try {
        if (mode === "update") {
          const sets = Object.entries(patch!).map(([k, v]) => {
            values.push(v);
            return `${ident(k)} = $${values.length}`;
          });
          const sql = `UPDATE ${ident(table)} SET ${sets.join(", ")}${whereSql}${returning ? ` RETURNING ${returning}` : ""}`;
          const res = await pool.query(sql, values);
          return { data: returning ? res.rows.map(rowToJs) : null, error: null };
        }
        if (countExact) {
          const c = await pool.query(`SELECT count(*)::int AS n FROM ${ident(table)}${whereSql}`, values);
          if (headOnly) return { data: null, error: null, count: c.rows[0].n };
        }
        const cap = Math.min(limit ?? MAX_ROWS, MAX_ROWS);
        const sql = `SELECT ${columns} FROM ${ident(table)}${whereSql}${orders.length ? " ORDER BY " + orders.join(", ") : ""} LIMIT ${cap} OFFSET ${offset}`;
        const res = await pool.query(sql, values);
        const rows = res.rows.map(rowToJs);
        if (single) {
          if (rows.length > 1) return { data: null, error: { message: "multiple rows returned" } };
          if (rows.length === 0 && single === "one") return { data: null, error: { message: "no rows returned" } };
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      } catch (err) {
        return { data: null, error: pgError(err) };
      }
    }

    return builder;
  }

  async function rpc(fn: string, args: Record<string, unknown> = {}) {
    const call: AdapterCall = { kind: "rpc", table: fn, seq: nextSeq(`rpc:${fn}`), args };
    calls.push(call);
    if (opts.failWhen?.(call)) return { data: null, error: { message: `injected failure: rpc ${fn} #${call.seq}` } };
    try {
      const meta = await pool.query(
        `SELECT p.proretset, p.proargnames, ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types,
                rt.typtype = 'c' AS returns_row
         FROM pg_proc p JOIN pg_type rt ON rt.oid = p.prorettype WHERE p.proname = $1 LIMIT 1`,
        [fn]
      );
      // PostgREST sends the request body as JSON, so a json/jsonb parameter
      // receives the JSON value as-is (node-postgres would otherwise turn a
      // JS array into a Postgres array literal).
      const typeOf = new Map<string, string>();
      const names: string[] = meta.rows[0]?.proargnames ?? [];
      const types: string[] = meta.rows[0]?.types ?? [];
      names.forEach((n, i) => typeOf.set(n, types[i]));
      const values: unknown[] = [];
      const named = Object.entries(args).map(([k, v]) => {
        const t = typeOf.get(k);
        values.push((t === "jsonb" || t === "json") && v !== null && v !== undefined ? JSON.stringify(v) : v);
        return `${ident(k)} => $${values.length}`;
      });
      const res = await pool.query(`SELECT * FROM ${ident(fn)}(${named.join(", ")})`, values);
      if (meta.rows[0]?.proretset) return { data: res.rows.map(rowToJs), error: null };
      const row = res.rows[0];
      // A function returning a table row comes back from PostgREST as that
      // row (an object), not as its first column.
      if (meta.rows[0]?.returns_row) return { data: row ? rowToJs(row) : null, error: null };
      return { data: row ? toJs(Object.values(row)[0]) : null, error: null };
    } catch (err) {
      return { data: null, error: pgError(err) };
    }
  }

  return { client: { from, rpc }, calls };
}
