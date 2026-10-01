// Real-PostgreSQL integration tests for migration 032's database-level
// constraints -- the properties that can only be genuinely proven by a real
// constraint-enforcing engine, not by a mocked/fake Supabase client (see
// lib/testSupport.ts, which never enforces FKs, CHECKs or unique indexes).
//
// Scope is deliberately narrow: this file does NOT re-prove anything already
// covered by migrations/032_create_completed_job_billing.test.ts (static
// source-level shape checks) or lib/completedJobBilling.test.ts /
// app/api/billing/completed-jobs/**/*.test.ts (application-layer behavior).
// It exists only to prove, against a real disposable PostgreSQL instance,
// that the database itself -- independent of the API route's own checks --
// rejects:
//   1. a completed_job_billing row whose workspace_id does not match the
//      workspace of the appointment it references (the composite FK), and
//   2. a non-normalized or duplicate-per-workspace invoice_number.
//
// Deliberately NOT wired into test-db/harness.ts's own MIGRATIONS/
// NEW_MIGRATIONS lists -- those are purpose-built for the atomic-
// recurrence-change feature (migrations 029/030/031) and its own schema-audit
// tooling (see harness.ts's and schema-audit.test.ts's own comments). This
// file builds its own migration list locally via startTestDb's `migrations`
// option instead, so it adds zero risk to that unrelated, already-verified
// machinery. Run with `npm run test:db:billing`.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, MIGRATIONS, type TestDb, type Fixture } from "./harness.ts";

let db: TestDb;
let c: pg.Client;

before(async () => {
  db = await startTestDb({ migrations: [...MIGRATIONS, "032_create_completed_job_billing.sql"] });
  c = await db.connect();
});
after(async () => {
  await c.end();
  await db.stop();
});

async function insertBilling(opts: {
  workspaceId: string;
  appointmentId: string;
  invoiceNumber?: string | null;
  paid?: boolean;
  paymentMethod?: string | null;
}) {
  return c.query(
    `INSERT INTO completed_job_billing (id, workspace_id, appointment_id, invoice_number, paid, payment_method)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      randomUUID(),
      opts.workspaceId,
      opts.appointmentId,
      opts.invoiceNumber ?? null,
      opts.paid ?? false,
      opts.paymentMethod ?? null,
    ]
  );
}

async function makeApptFixture(): Promise<{ fx: Fixture; appointmentId: string }> {
  const fx = await makeWorkspace(c);
  const appointmentId = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-01T13:00:00Z") });
  return { fx, appointmentId };
}

describe("migration 032 -- composite FK: (appointment_id, workspace_id) must match a real appointment", () => {
  test("accepts a billing row whose workspace_id correctly matches the referenced appointment's own workspace", async () => {
    const { fx, appointmentId } = await makeApptFixture();
    await assert.doesNotReject(insertBilling({ workspaceId: fx.workspaceId, appointmentId }));
  });

  test("rejects a billing row whose workspace_id does NOT match the referenced appointment's real workspace -- the database itself blocks cross-workspace association, independent of any API-layer check", async () => {
    const { appointmentId } = await makeApptFixture(); // appointment belongs to workspace A
    const otherWorkspace = await makeWorkspace(c); // an unrelated workspace B

    await assert.rejects(
      insertBilling({ workspaceId: otherWorkspace.workspaceId, appointmentId }),
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
      insertBilling({ workspaceId: fx.workspaceId, appointmentId: randomUUID() }),
      (err: unknown) => (err as { code?: string }).code === "23503"
    );
  });
});

describe("migration 032 -- invoice_number is normalized and unique per workspace at the database layer", () => {
  test("rejects an invoice_number with leading/trailing whitespace, even though it is non-blank", async () => {
    const { fx, appointmentId } = await makeApptFixture();
    await assert.rejects(
      insertBilling({ workspaceId: fx.workspaceId, appointmentId, invoiceNumber: " 13425 " }),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        assert.equal(pgErr.code, "23514", "expected a check_violation (23514)");
        assert.equal(pgErr.constraint, "completed_job_billing_invoice_number_trimmed");
        return true;
      }
    );
  });

  test("rejects a duplicate NORMALIZED invoice_number in the same workspace -- '13425' then '13425' again (same workspace, different appointments)", async () => {
    const fx = await makeWorkspace(c);
    const appt1 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-01T13:00:00Z") });
    const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-02T13:00:00Z") });

    await insertBilling({ workspaceId: fx.workspaceId, appointmentId: appt1, invoiceNumber: "13425" });
    await assert.rejects(
      insertBilling({ workspaceId: fx.workspaceId, appointmentId: appt2, invoiceNumber: "13425" }),
      (err: unknown) => {
        const pgErr = err as { code?: string; constraint?: string };
        assert.equal(pgErr.code, "23505", "expected a unique_violation (23505)");
        assert.equal(pgErr.constraint, "idx_completed_job_billing_workspace_invoice_number");
        return true;
      }
    );
  });

  test("allows the SAME invoice_number in two DIFFERENT workspaces -- uniqueness is per-workspace, not global", async () => {
    const { fx: fxA, appointmentId: apptA } = await makeApptFixture();
    const { fx: fxB, appointmentId: apptB } = await makeApptFixture();

    await insertBilling({ workspaceId: fxA.workspaceId, appointmentId: apptA, invoiceNumber: "DUP-1" });
    await assert.doesNotReject(insertBilling({ workspaceId: fxB.workspaceId, appointmentId: apptB, invoiceNumber: "DUP-1" }));
  });

  test("allows any number of NULL (not-yet-invoiced) rows in the same workspace -- the unique index excludes NULLs", async () => {
    const fx = await makeWorkspace(c);
    const appt1 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-03T13:00:00Z") });
    const appt2 = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-04T13:00:00Z") });
    await insertBilling({ workspaceId: fx.workspaceId, appointmentId: appt1, invoiceNumber: null });
    await assert.doesNotReject(insertBilling({ workspaceId: fx.workspaceId, appointmentId: appt2, invoiceNumber: null }));
  });
});
