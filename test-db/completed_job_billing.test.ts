// Real-PostgreSQL integration tests for migrations 032/033/034's
// database-level constraints and functions -- the properties that can only
// be genuinely proven by a real constraint-enforcing engine, not by a
// mocked/fake Supabase client (see lib/testSupport.ts, which never enforces
// FKs, CHECKs, unique indexes, or the transactional behavior of a real
// PL/pgSQL function).
//
// Scope is deliberately narrow: this file does NOT re-prove anything already
// covered by migrations/032_create_completed_job_billing.test.ts /
// migrations/033_completed_job_billing_invoice_per_client.test.ts /
// migrations/034_completed_job_billing_finalize_invoice_per_client.test.ts
// (static source-level shape checks) or lib/completedJobBilling.test.ts /
// app/api/billing/completed-jobs/**/*.test.ts (application-layer behavior,
// mocked). It exists only to prove, against a real disposable PostgreSQL
// instance, the genuine two-phase rollout behavior:
//   A. after PHASE 1 (migration 033) alone, an OLD-style raw upsert that
//      omits client_id can still create a new billing row successfully --
//      the currently-deployed app is never broken by this migration.
//   B. after PHASE 1 alone, upsert_completed_job_billing already exists and
//      is callable.
//   C. after PHASE 1 alone, the OLD UNIQUE invoice-number index still
//      exists and still blocks a same-client repeated invoice number, even
//      through the new RPC -- an accepted, temporary limitation of the
//      intermediate state (see migration 033's own header comment).
//   D. after PHASE 2 (migration 034), client_id is NOT NULL.
//   E. after PHASE 2, the invoice-number index is non-unique.
//   F. after PHASE 2, the full grouped-invoice behavior (same-client
//      allowed, cross-client rejected atomically, paid/payment_method sync
//      in both directions, cash/no-invoice independence, workspace/client
//      isolation) works exactly as already approved.
//   G. applying PHASE 2 against a database that already has PHASE-1-era
//      data (including a row an old-style raw upsert left with a NULL
//      client_id) loses no row and rewrites no existing row's data beyond
//      filling that one column.
//
// Deliberately NOT wired into test-db/harness.ts's own MIGRATIONS/
// NEW_MIGRATIONS lists -- those are purpose-built for the atomic-
// recurrence-change feature (migrations 029/030/031) and its own schema-audit
// tooling (see harness.ts's and schema-audit.test.ts's own comments). This
// file builds its own migration lists locally via startTestDb's `migrations`
// option instead, so it adds zero risk to that unrelated, already-verified
// machinery. Run with `npm run test:db:billing`. This spins up throwaway
// local PostgreSQL instances (embedded-postgres) and deletes them on exit --
// it never touches production or any shared database, and applying
// migrations 033/034 here is not "running them against production."
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, MIGRATIONS, type TestDb, type Fixture } from "./harness.ts";

const MIGRATION_034_SQL = fs.readFileSync(
  fileURLToPath(new URL("../migrations/034_completed_job_billing_finalize_invoice_per_client.sql", import.meta.url)),
  "utf8"
);

async function insertBilling(
  c: pg.Client,
  opts: {
    workspaceId: string;
    appointmentId: string;
    clientId?: string | null;
    invoiceNumber?: string | null;
    paid?: boolean;
    paymentMethod?: string | null;
  }
) {
  if (opts.clientId === undefined) {
    // Simulates the CURRENTLY DEPLOYED (pre-this-feature) app's raw upsert,
    // which never supplies client_id at all -- only valid while client_id
    // is still nullable (PHASE 1).
    return c.query(
      `INSERT INTO completed_job_billing (id, workspace_id, appointment_id, invoice_number, paid, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), opts.workspaceId, opts.appointmentId, opts.invoiceNumber ?? null, opts.paid ?? false, opts.paymentMethod ?? null]
    );
  }
  return c.query(
    `INSERT INTO completed_job_billing (id, workspace_id, appointment_id, client_id, invoice_number, paid, payment_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), opts.workspaceId, opts.appointmentId, opts.clientId, opts.invoiceNumber ?? null, opts.paid ?? false, opts.paymentMethod ?? null]
  );
}

async function makeApptFixture(c: pg.Client): Promise<{ fx: Fixture; appointmentId: string }> {
  const fx = await makeWorkspace(c);
  const appointmentId = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-01T13:00:00Z") });
  return { fx, appointmentId };
}

// A second, distinct client in the SAME workspace as `fx`, plus one
// appointment for that client -- `makeWorkspace`/`makeAppointment` (shared
// harness helpers) always use the one client makeWorkspace itself creates,
// so cross-client scenarios need their own small local helper rather than a
// change to the shared harness.
async function addSecondClientAppointment(c: pg.Client, fx: Fixture, scheduledFor: Date): Promise<{ clientId: string; appointmentId: string }> {
  const clientId = randomUUID();
  await c.query("INSERT INTO clients (id, workspace_id, name, status) VALUES ($1, $2, 'Second Client', 'active')", [
    clientId,
    fx.workspaceId,
  ]);
  const appointmentId = randomUUID();
  const dur = 60;
  await c.query(
    `INSERT INTO appointments (id, workspace_id, client_id, service_type, scheduled_for, scheduled_end,
        duration_minutes, status, cancel_token, frequency_type, repeat_weeks)
     VALUES ($1,$2,$3,'Regular Cleaning',$4,$5,$6,'scheduled',$7,'one_time',1)`,
    [appointmentId, fx.workspaceId, clientId, scheduledFor, new Date(scheduledFor.getTime() + dur * 60000), dur, randomUUID().replace(/-/g, "")]
  );
  return { clientId, appointmentId };
}

type BillingRow = { id: string; workspace_id: string; appointment_id: string; client_id: string | null; invoice_number: string | null; paid: boolean; payment_method: string | null };

async function upsertViaRpc(
  c: pg.Client,
  opts: { workspaceId: string; appointmentId: string; clientId: string; invoiceNumber: string | null; paid: boolean; paymentMethod: string | null }
): Promise<BillingRow> {
  const res = await c.query(
    `SELECT * FROM upsert_completed_job_billing($1, $2, $3, $4, $5, $6)`,
    [opts.workspaceId, opts.appointmentId, opts.clientId, opts.invoiceNumber, opts.paid, opts.paymentMethod]
  );
  return res.rows[0] as BillingRow;
}

async function billingRow(c: pg.Client, appointmentId: string): Promise<BillingRow> {
  const res = await c.query("SELECT * FROM completed_job_billing WHERE appointment_id = $1", [appointmentId]);
  return res.rows[0] as BillingRow;
}

// ===========================================================================
// PHASE 1 ONLY -- migration 033 applied, migration 034 NOT applied. Proves
// this intermediate state is genuinely compatible with the currently
// deployed application (A, B) and that the old UNIQUE index's temporary
// limitation is real, not assumed (C).
// ===========================================================================
describe("PHASE 1 only (migration 033, no 034) -- compatible with the currently deployed app", () => {
  let db: TestDb;
  let c: pg.Client;

  before(async () => {
    db = await startTestDb({
      migrations: [...MIGRATIONS, "032_create_completed_job_billing.sql", "033_completed_job_billing_invoice_per_client.sql"],
    });
    c = await db.connect();
  });
  after(async () => {
    await c.end();
    await db.stop();
  });

  test("A: an OLD-style raw upsert that omits client_id entirely still creates a new billing row successfully", async () => {
    const { fx, appointmentId } = await makeApptFixture(c);
    await assert.doesNotReject(insertBilling(c, { workspaceId: fx.workspaceId, appointmentId, invoiceNumber: "OLD-1" }));
    const row = await billingRow(c, appointmentId);
    assert.equal(row.invoice_number, "OLD-1");
    assert.equal(row.client_id, null, "client_id stays NULL -- exactly what old code leaves it as, and PHASE 1 must tolerate that");
  });

  test("A: an OLD-style raw upsert can also EDIT an existing row (ON CONFLICT appointment_id) without ever supplying client_id", async () => {
    const { fx, appointmentId } = await makeApptFixture(c);
    await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId, invoiceNumber: "OLD-2", paid: false });
    await c.query(
      `INSERT INTO completed_job_billing (id, workspace_id, appointment_id, invoice_number, paid, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (appointment_id) DO UPDATE SET paid = EXCLUDED.paid, payment_method = EXCLUDED.payment_method`,
      [randomUUID(), fx.workspaceId, appointmentId, "OLD-2", true, "cash"]
    );
    const row = await billingRow(c, appointmentId);
    assert.equal(row.paid, true);
    assert.equal(row.payment_method, "cash");
  });

  test("B: upsert_completed_job_billing already exists and is callable after PHASE 1 alone", async () => {
    const { fx, appointmentId } = await makeApptFixture(c);
    const row = await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId, clientId: fx.clientId, invoiceNumber: "NEW-1", paid: false, paymentMethod: null });
    assert.equal(row.invoice_number, "NEW-1");
    assert.equal(row.client_id, fx.clientId);
  });

  test("C: the OLD UNIQUE invoice-number index still exists and still blocks a same-client repeated invoice number, even through the new RPC -- accepted temporary limitation of PHASE 1 (see migration 033's header)", async () => {
    const { fx, appointmentId: appt1 } = await makeApptFixture(c);
    const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-02T13:00:00Z") });

    await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13425", paid: false, paymentMethod: null });

    await assert.rejects(
      upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "13425", paid: false, paymentMethod: null }),
      (err: unknown) => {
        const pgErr = err as { code?: string; message?: string };
        assert.equal(pgErr.code, "23505", "must still be a unique_violation from the OLD index, not the new function's own cross-client check");
        assert.doesNotMatch(pgErr.message ?? "", /completed_job_billing_invoice_number_different_client/, "this is the OLD index's generic conflict, not the new function's distinguishable cross-client error");
        return true;
      }
    );
  });

  test("C: a raw INSERT directly repeating an invoice number for the SAME client is also still blocked by the old index (confirms the index itself, independent of the RPC)", async () => {
    const { fx, appointmentId: appt1 } = await makeApptFixture(c);
    const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-03T13:00:00Z") });
    await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "DUP-STILL-BLOCKED" });
    await assert.rejects(
      insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "DUP-STILL-BLOCKED" }),
      (err: unknown) => (err as { code?: string }).code === "23505"
    );
  });
});

// ===========================================================================
// G -- applying PHASE 2 (migration 034) against a database that already has
// PHASE-1-era data, including a row an old-style raw upsert left with a
// NULL client_id, loses no row and rewrites no existing data beyond filling
// that column.
// ===========================================================================
describe("Transitioning from PHASE 1 data to PHASE 2 (applying migration 034 against existing rows)", () => {
  let db: TestDb;
  let c: pg.Client;

  before(async () => {
    db = await startTestDb({
      migrations: [...MIGRATIONS, "032_create_completed_job_billing.sql", "033_completed_job_billing_invoice_per_client.sql"],
    });
    c = await db.connect();
  });
  after(async () => {
    await c.end();
    await db.stop();
  });

  test("G: no existing row is lost, and no existing value is rewritten beyond backfilling a NULL client_id, when migration 034 runs against PHASE-1-era data", async () => {
    // Row 1: already written via the RPC (a client that upgraded to the new
    // app during PHASE 1), already has client_id, already paid.
    const { fx, appointmentId: appt1 } = await makeApptFixture(c);
    await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "PRE-034-A", paid: true, paymentMethod: "check" });

    // Row 2: written by OLD code's raw upsert during the gap -- client_id is
    // NULL, exactly the case migration 034's own backfill-then-guard exists
    // to handle.
    const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-04T13:00:00Z") });
    await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt2, invoiceNumber: "PRE-034-B", paid: false, paymentMethod: null });

    // Row 3: a cash/no-invoice row, also written by old code, also NULL
    // client_id.
    const appt3 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-05T13:00:00Z") });
    await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt3, invoiceNumber: null, paid: true, paymentMethod: "cash" });

    const before = await c.query("SELECT count(*) FROM completed_job_billing");
    assert.equal(before.rows[0].count, "3");

    // Apply PHASE 2 (migration 034) against this already-populated database.
    await c.query(MIGRATION_034_SQL);

    const after = await c.query("SELECT count(*) FROM completed_job_billing");
    assert.equal(after.rows[0].count, "3", "no row must be lost");

    const row1 = await billingRow(c, appt1);
    assert.equal(row1.client_id, fx.clientId, "row 1's already-correct client_id must be untouched");
    assert.equal(row1.invoice_number, "PRE-034-A");
    assert.equal(row1.paid, true);
    assert.equal(row1.payment_method, "check");

    const row2 = await billingRow(c, appt2);
    assert.equal(row2.client_id, fx.clientId, "row 2's NULL client_id must be backfilled from its appointment");
    assert.equal(row2.invoice_number, "PRE-034-B", "no other field must be rewritten");
    assert.equal(row2.paid, false);
    assert.equal(row2.payment_method, null);

    const row3 = await billingRow(c, appt3);
    assert.equal(row3.client_id, fx.clientId);
    assert.equal(row3.invoice_number, null, "a cash/no-invoice row stays null-invoice after the transition");
    assert.equal(row3.paid, true);
    assert.equal(row3.payment_method, "cash");

    // And client_id is now genuinely NOT NULL for every row.
    const nullCount = await c.query("SELECT count(*) FROM completed_job_billing WHERE client_id IS NULL");
    assert.equal(nullCount.rows[0].count, "0");
  });
});

// ===========================================================================
// PHASE 2 (final state) -- migrations 033 AND 034 both applied. Proves D, E,
// F, plus the general FK/normalization behavior migration 032 already
// established (re-verified against the final schema, not just PHASE 1's).
// ===========================================================================
describe("PHASE 2 / final state (migrations 033 + 034 applied)", () => {
  let db: TestDb;
  let c: pg.Client;

  before(async () => {
    db = await startTestDb({
      migrations: [
        ...MIGRATIONS,
        "032_create_completed_job_billing.sql",
        "033_completed_job_billing_invoice_per_client.sql",
        "034_completed_job_billing_finalize_invoice_per_client.sql",
      ],
    });
    c = await db.connect();
  });
  after(async () => {
    await c.end();
    await db.stop();
  });

  describe("migration 032 -- composite FK: (appointment_id, workspace_id) must match a real appointment", () => {
    test("accepts a billing row whose workspace_id correctly matches the referenced appointment's own workspace", async () => {
      const { fx, appointmentId } = await makeApptFixture(c);
      await assert.doesNotReject(insertBilling(c, { workspaceId: fx.workspaceId, appointmentId, clientId: fx.clientId }));
    });

    test("rejects a billing row whose workspace_id does NOT match the referenced appointment's real workspace -- the database itself blocks cross-workspace association, independent of any API-layer check", async () => {
      const { fx, appointmentId } = await makeApptFixture(c); // appointment belongs to workspace A
      const otherWorkspace = await makeWorkspace(c); // an unrelated workspace B

      await assert.rejects(
        insertBilling(c, { workspaceId: otherWorkspace.workspaceId, appointmentId, clientId: fx.clientId }),
        (err: unknown) => {
          const pgErr = err as { code?: string; constraint?: string };
          assert.equal(pgErr.code, "23503", "expected a foreign_key_violation (23503)");
          assert.equal(pgErr.constraint, "completed_job_billing_appointment_workspace_fkey");
          return true;
        }
      );
    });

    test("rejects a billing row referencing an appointment_id that does not exist at all, under any workspace_id", async () => {
      const fx = await makeWorkspace(c);
      await assert.rejects(
        insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: randomUUID(), clientId: fx.clientId }),
        (err: unknown) => (err as { code?: string }).code === "23503"
      );
    });
  });

  describe("migration 032 -- invoice_number normalization at the database layer", () => {
    test("rejects an invoice_number with leading/trailing whitespace, even though it is non-blank", async () => {
      const { fx, appointmentId } = await makeApptFixture(c);
      await assert.rejects(
        insertBilling(c, { workspaceId: fx.workspaceId, appointmentId, clientId: fx.clientId, invoiceNumber: " 13425 " }),
        (err: unknown) => {
          const pgErr = err as { code?: string; constraint?: string };
          assert.equal(pgErr.code, "23514", "expected a check_violation (23514)");
          assert.equal(pgErr.constraint, "completed_job_billing_invoice_number_trimmed");
          return true;
        }
      );
    });

    test("allows any number of NULL (not-yet-invoiced) rows in the same workspace", async () => {
      const fx = await makeWorkspace(c);
      const appt1 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-03T13:00:00Z") });
      const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-04T13:00:00Z") });
      await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: null });
      await assert.doesNotReject(insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: null }));
    });
  });

  test("D: client_id is NOT NULL at the database layer -- a raw INSERT omitting it is rejected", async () => {
    const { fx, appointmentId } = await makeApptFixture(c);
    await assert.rejects(
      c.query(
        `INSERT INTO completed_job_billing (id, workspace_id, appointment_id, invoice_number, paid, payment_method)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), fx.workspaceId, appointmentId, null, false, null]
      ),
      (err: unknown) => (err as { code?: string }).code === "23502" // not_null_violation
    );
  });

  describe("E/F -- a raw INSERT bypassing the RPC is NOT protected by any remaining database constraint (documents the real enforcement boundary); the RPC itself still enforces every rule atomically", () => {
    test("E: a repeated invoice number for the SAME client, inserted directly (not via the RPC), succeeds -- the old UNIQUE index is gone", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-02T13:00:00Z") });
      await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13425" });
      await assert.doesNotReject(insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "13425" }));
    });

    test("a repeated invoice number for a DIFFERENT client, inserted directly (not via the RPC), is NOT rejected by the database -- only upsert_completed_job_billing enforces that rule, confirming this application must never write to this table any other way", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const { clientId: otherClientId, appointmentId: appt2 } = await addSecondClientAppointment(c, fx, new Date("2026-06-05T13:00:00Z"));
      await insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13426" });
      await assert.doesNotReject(insertBilling(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: otherClientId, invoiceNumber: "13426" }));
    });

    test("the same invoice_number in two DIFFERENT workspaces is unaffected either way -- never scoped beyond one workspace", async () => {
      const { fx: fxA, appointmentId: apptA } = await makeApptFixture(c);
      const { fx: fxB, appointmentId: apptB } = await makeApptFixture(c);
      await insertBilling(c, { workspaceId: fxA.workspaceId, appointmentId: apptA, clientId: fxA.clientId, invoiceNumber: "DUP-1" });
      await assert.doesNotReject(insertBilling(c, { workspaceId: fxB.workspaceId, appointmentId: apptB, clientId: fxB.clientId, invoiceNumber: "DUP-1" }));
    });
  });

  describe("F: upsert_completed_job_billing -- real-Postgres proof of cross-client rejection and invoice-group payment sync", () => {
    test("same client, repeated invoice number -- both calls succeed, both rows exist with the shared invoice number", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-07-08T13:00:00Z") });

      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13422", paid: false, paymentMethod: null });
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "13422", paid: false, paymentMethod: null });

      const row1 = await billingRow(c, appt1);
      const row2 = await billingRow(c, appt2);
      assert.equal(row1.invoice_number, "13422");
      assert.equal(row2.invoice_number, "13422");
    });

    test("different client, same invoice number -- rejected atomically, and NOTHING is written for the rejected appointment (no partial row)", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const { clientId: otherClientId, appointmentId: appt2 } = await addSecondClientAppointment(c, fx, new Date("2026-06-10T13:00:00Z"));

      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13999", paid: false, paymentMethod: null });

      await assert.rejects(
        upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: otherClientId, invoiceNumber: "13999", paid: false, paymentMethod: null }),
        (err: unknown) => {
          const pgErr = err as { code?: string; message?: string };
          assert.equal(pgErr.code, "23505");
          assert.match(pgErr.message ?? "", /completed_job_billing_invoice_number_different_client/);
          return true;
        }
      );

      // The rejected appointment has NO billing row at all -- the rejection
      // happened before the INSERT, inside the same transaction, not after a
      // partial write.
      const res = await c.query("SELECT * FROM completed_job_billing WHERE appointment_id = $1", [appt2]);
      assert.equal(res.rows.length, 0, "a rejected upsert must leave zero rows for that appointment");
    });

    test("marking one grouped-invoice row Paid (with a payment method) synchronizes paid + payment_method onto every other row in the group", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-07-08T13:00:00Z") });
      const appt3 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-07-22T13:00:00Z") });

      for (const apptId of [appt1, appt2, appt3]) {
        await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: apptId, clientId: fx.clientId, invoiceNumber: "13422", paid: false, paymentMethod: null });
      }

      // Mark just ONE of the three jobs Paid via Zelle.
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "13422", paid: true, paymentMethod: "zelle" });

      for (const apptId of [appt1, appt2, appt3]) {
        const row = await billingRow(c, apptId);
        assert.equal(row.paid, true, `appointment ${apptId} must be marked paid`);
        assert.equal(row.payment_method, "zelle", `appointment ${apptId} must carry the group's payment method`);
      }
    });

    test("setting the group back to unpaid synchronizes unpaid across every row in the group", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-07-08T13:00:00Z") });

      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13500", paid: true, paymentMethod: "check" });
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "13500", paid: true, paymentMethod: "check" });

      // Flip it back to unpaid via either row in the group.
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13500", paid: false, paymentMethod: "check" });

      for (const apptId of [appt1, appt2]) {
        const row = await billingRow(c, apptId);
        assert.equal(row.paid, false, `appointment ${apptId} must be marked unpaid`);
      }
    });

    test("a DIFFERENT (unrelated) invoice number for the SAME client is never touched by a sync", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-07-08T13:00:00Z") });
      const unrelatedAppt = await makeAppointment(c, fx, { scheduledFor: new Date("2026-08-01T13:00:00Z") });

      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13422", paid: false, paymentMethod: null });
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt2, clientId: fx.clientId, invoiceNumber: "13422", paid: false, paymentMethod: null });
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: unrelatedAppt, clientId: fx.clientId, invoiceNumber: "99999", paid: false, paymentMethod: null });

      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13422", paid: true, paymentMethod: "zelle" });

      const unrelatedRow = await billingRow(c, unrelatedAppt);
      assert.equal(unrelatedRow.paid, false, "an unrelated invoice number for the same client must be untouched");
      assert.equal(unrelatedRow.payment_method, null);
    });

    test("the same invoice number for the same client in a DIFFERENT workspace is never touched by a sync", async () => {
      const { fx: fxA, appointmentId: apptA1 } = await makeApptFixture(c);
      const apptA2 = await makeAppointment(c, fxA, { scheduledFor: new Date("2026-07-08T13:00:00Z") });
      const { fx: fxB, appointmentId: apptB1 } = await makeApptFixture(c);

      await upsertViaRpc(c, { workspaceId: fxA.workspaceId, appointmentId: apptA1, clientId: fxA.clientId, invoiceNumber: "SHARED-1", paid: false, paymentMethod: null });
      await upsertViaRpc(c, { workspaceId: fxA.workspaceId, appointmentId: apptA2, clientId: fxA.clientId, invoiceNumber: "SHARED-1", paid: false, paymentMethod: null });
      // Coincidentally the same invoice number text, but a totally different
      // workspace (and a different client_id, since clients are per-workspace).
      await upsertViaRpc(c, { workspaceId: fxB.workspaceId, appointmentId: apptB1, clientId: fxB.clientId, invoiceNumber: "SHARED-1", paid: false, paymentMethod: null });

      await upsertViaRpc(c, { workspaceId: fxA.workspaceId, appointmentId: apptA1, clientId: fxA.clientId, invoiceNumber: "SHARED-1", paid: true, paymentMethod: "cash" });

      const otherWorkspaceRow = await billingRow(c, apptB1);
      assert.equal(otherWorkspaceRow.paid, false, "a different workspace's row must never be touched by another workspace's sync");
    });

    test("Cash/no-invoice rows are never touched by a sync -- marking a null-invoice row Paid does not scan for or affect any other row", async () => {
      const { fx, appointmentId: appt1 } = await makeApptFixture(c);
      const cashAppt = await makeAppointment(c, fx, { scheduledFor: new Date("2026-07-08T13:00:00Z") });

      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: appt1, clientId: fx.clientId, invoiceNumber: "13422", paid: false, paymentMethod: null });
      await upsertViaRpc(c, { workspaceId: fx.workspaceId, appointmentId: cashAppt, clientId: fx.clientId, invoiceNumber: null, paid: true, paymentMethod: "cash" });

      const invoicedRow = await billingRow(c, appt1);
      assert.equal(invoicedRow.paid, false, "a cash/no-invoice row's paid edit must never leak onto an invoiced job");
    });
  });
});
