// SFT invoices (migrations/049) on a REAL PostgreSQL built from the exported
// production schema + migrations 029-048. Billing data is seeded BEFORE 049
// is applied, so the rollout (preflight, one-time Cash backfill, postflight,
// re-run) is tested exactly as it would run in production.
//
// The DEPLOYED Billing route (frozen copy of a593d9c in test-db/deployed/)
// runs unchanged against the 049 database through test-db/postgrestAdapter.ts,
// proving the live app keeps saving ordinary Billing changes after 049 is
// applied and before the new app is deployed.
//
// The "PDF" bytes here are a stand-in: "%PDF-" + the exact render JSON. That
// lets every test decode the STORED file and prove it agrees with the issued
// invoice (number, revision, every printed value). The real renderer
// (pdf-lib) arrives in Step 3 and is tested there.
//
//   TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db:invoices
/* eslint-disable @typescript-eslint/no-explicit-any -- test-only: rows are
   inspected dynamically against the database. */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, waitUntilBlocked, backendPid, track, type TestDb, type Fixture } from "./harness.ts";
import { createPostgrestAdapter, POSTGREST_TYPES } from "./postgrestAdapter.ts";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = process.env.TEST_DB_SCHEMA_FILE ? path.resolve(ROOT, process.env.TEST_DB_SCHEMA_FILE) : "";
const SKIP = !schemaFile || !existsSync(schemaFile) ? "TEST_DB_SCHEMA_FILE (production schema export) not provided" : false;

let currentClient: any = null;
mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (t: string) => currentClient.from(t),
      rpc: (fn: string, args?: Record<string, unknown>) => currentClient.rpc(fn, args),
    },
  },
});
let session: any = { role: "none" };
const { fakeSessionNamedExports } = await import("../lib/testSupport.ts");
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => session) });
mock.module("@/lib/entitlementServer", {
  namedExports: { requireCapability: async () => ({ allowed: true }) },
});

const deployedBillingRoute = await import("./deployed/billing-update-route.a593d9c.ts");

const M049 = readFileSync(path.join(ROOT, "migrations", "049_invoices.sql"), "utf8");
const runSql = async (file: string) => (await c.query(readFileSync(path.join(ROOT, "test-db", file), "utf8"))).rows as { check_name: string; ok: boolean; detail: string }[];

let db: TestDb;
let pool: pg.Pool; // raw connections for the database functions (and real concurrency)
let adapterPool: pg.Pool; // PostgREST stand-in for the deployed route
let c: pg.Client; // admin / observer

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Ws = Fixture & { otherClientId: string };

async function newWorkspace(): Promise<Ws> {
  const fx = await makeWorkspace(c, { employees: 1 });
  const otherClientId = randomUUID();
  await c.query("INSERT INTO clients (id, workspace_id, name) VALUES ($1, $2, 'Other client')", [otherClientId, fx.workspaceId]);
  return { ...fx, otherClientId };
}

let dayOffset = 0;
// A past job whose assigned employee completed Job Tracking (billing-eligible).
async function completedJob(ws: Ws, opts: { clientId?: string; priceCents?: number | null; status?: string } = {}): Promise<string> {
  dayOffset += 1;
  const start = new Date(Date.UTC(2026, 9, 1, 14) + dayOffset * 3600_000);
  const id = await makeAppointment(c, { ...ws, clientId: opts.clientId ?? ws.clientId }, {
    scheduledFor: start,
    employees: [ws.employeeIds[0]],
    priceCents: opts.priceCents === undefined ? 15000 : opts.priceCents,
    status: opts.status,
  });
  await c.query(
    "UPDATE appointment_employees SET actual_started_at = $2, actual_completed_at = $3 WHERE appointment_id = $1",
    [id, start, new Date(start.getTime() + 90 * 60_000)]
  );
  return id;
}

async function billingRow(appointmentId: string): Promise<any> {
  return (await c.query("SELECT * FROM completed_job_billing WHERE appointment_id = $1", [appointmentId])).rows[0] ?? null;
}
async function invoiceRow(id: string): Promise<any> {
  return (await c.query("SELECT * FROM invoices WHERE id = $1", [id])).rows[0] ?? null;
}
async function counter(ws: Ws): Promise<number | null> {
  return (await c.query("SELECT next_number FROM invoice_counters WHERE workspace_id = $1", [ws.workspaceId])).rows[0]?.next_number ?? null;
}

// Calls a database function returning jsonb/void through a given connection.
async function fn(cl: pg.Client | pg.Pool | pg.PoolClient, name: string, args: unknown[]): Promise<any> {
  const ph = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await cl.query(`SELECT ${name}(${ph}) AS r`, args)).rows[0].r;
}

// The new app's Billing writes (same six-argument function as the deployed app).
async function upsertBilling(cl: pg.Client | pg.Pool, ws: Ws, appointmentId: string, clientId: string, invoiceNumber: string | null, paid: boolean, method: string | null) {
  await cl.query("SELECT 1 FROM upsert_completed_job_billing($1, $2, $3, $4, $5, $6)", [ws.workspaceId, appointmentId, clientId, invoiceNumber, paid, method]);
}

function draftFields(o: Record<string, unknown> = {}) {
  return {
    business_name: "ACS Cleaning", business_address: "1 Main St\nSpringfield", business_phone: "555-0100", business_email: "office@example.test",
    bill_to_name: "Client A", bill_to_address: "2 Oak Ave", bill_to_email: "client.a@example.test",
    terms: "due_on_receipt", invoice_date: "2026-11-12", due_date: "2026-11-12", service_date: "2026-11-10",
    product_service: "Recurring Cleaning", description: "Biweekly cleaning", quantity: 1, rate_cents: 15000,
    payment_instructions: "Zelle or check", note_to_client: "Thank you for your business.",
    ...o,
  };
}

async function createDraft(cl: pg.Client | pg.Pool, ws: Ws, appointmentId: string, opts: { requestId?: string; fields?: Record<string, unknown> } = {}) {
  return fn(cl, "create_invoice_draft", [ws.workspaceId, appointmentId, opts.requestId ?? randomUUID(), JSON.stringify(draftFields(opts.fields))]);
}

// Stand-in renderer: "%PDF-" + exactly the render JSON it was given.
function renderPdf(snapshot: unknown): { base64: string; sha256: string } {
  const bytes = Buffer.from(`%PDF-1.7\n${JSON.stringify(snapshot)}\n%%EOF\n`, "utf8");
  return { base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function decodeStoredPdf(pdf: Buffer): any {
  const text = pdf.toString("utf8");
  assert.ok(text.startsWith("%PDF-1.7\n"), "stored bytes are the rendered PDF");
  return JSON.parse(text.slice("%PDF-1.7\n".length, text.lastIndexOf("\n%%EOF")));
}

type Rendered = { revision: number; invoice_number: string; render_snapshot: any; pdf: { base64: string; sha256: string } };
async function render(cl: pg.Client | pg.Pool, ws: Ws, invoiceId: string): Promise<Rendered> {
  const input = await fn(cl, "invoice_render_input", [ws.workspaceId, invoiceId]);
  assert.equal(input.outcome, "ok", JSON.stringify(input));
  // Exactly what the app would do: the JSON goes through a JS round trip.
  const snapshot = JSON.parse(JSON.stringify(input.render_snapshot));
  return { revision: input.revision, invoice_number: input.invoice_number, render_snapshot: snapshot, pdf: renderPdf(snapshot) };
}
async function issue(cl: pg.Client | pg.Pool, ws: Ws, invoiceId: string, r: Rendered) {
  return fn(cl, "issue_invoice", [ws.workspaceId, invoiceId, r.revision, r.invoice_number, JSON.stringify(r.render_snapshot), r.pdf.base64, r.pdf.sha256]);
}
// The app's issue loop: render, issue, re-render when the number moved.
async function renderAndIssue(cl: pg.Client | pg.Pool, ws: Ws, invoiceId: string): Promise<any> {
  for (let i = 0; i < 10; i++) {
    const out = await issue(cl, ws, invoiceId, await render(cl, ws, invoiceId));
    if (out.outcome !== "number_changed") return out;
  }
  throw new Error("number kept changing");
}

// The invariant this whole feature exists for: the stored PDF is exactly the
// issued invoice -- same number, same revision, same printed values -- and
// Billing shows that number.
async function assertStoredPdfAgrees(invoiceId: string) {
  const inv = await invoiceRow(invoiceId);
  assert.ok(inv.status === "issued" || inv.status === "void");
  const printed = decodeStoredPdf(inv.pdf);
  assert.equal(createHash("sha256").update(inv.pdf).digest("hex"), inv.pdf_sha256);
  assert.equal(printed.invoice_number, inv.invoice_number, "PDF number = issued number");
  assert.equal(printed.revision, inv.revision, "PDF revision = issued revision");
  assert.deepEqual(printed, JSON.parse(JSON.stringify(inv.render_snapshot)));
  const fresh = (await c.query("SELECT invoice_render_snapshot(i, i.invoice_number) AS s FROM invoices i WHERE id = $1", [invoiceId])).rows[0].s;
  assert.deepEqual(printed, JSON.parse(JSON.stringify(fresh)), "PDF = the invoice's current saved details");
  if (inv.status === "issued") {
    assert.equal((await billingRow(inv.appointment_id)).invoice_number, inv.invoice_number, "Billing shows the issued number");
  }
}

// ---------------------------------------------------------------------------
// The deployed Billing route (a593d9c), unchanged
// ---------------------------------------------------------------------------

async function deployedSave(ws: Ws, body: Record<string, unknown>) {
  session = { role: "owner", workspaceId: ws.workspaceId, authUserId: "owner-" + ws.workspaceId, sessionEpoch: 1 };
  const res = await deployedBillingRoute.PATCH(new Request("http://localhost/api/billing/completed-jobs/update", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Setup: production-like billing data BEFORE 049
// ---------------------------------------------------------------------------

let legacy: Ws;
const L: Record<string, string> = {};
let legacyBefore: any[] = [];
let preflight: { check_name: string; ok: boolean; detail: string }[] = [];
let preflightSft: { check_name: string; ok: boolean; detail: string }[] = [];
let postflight: { check_name: string; ok: boolean; detail: string }[] = [];

before(async () => {
  if (SKIP) return;
  db = await startTestDb({
    migrations: [
      "029_add_atomic_recurrence_change.sql", "030_add_work_recording_locking_protocol.sql", "031_add_owner_worked_time_override.sql",
      "032_create_completed_job_billing.sql", "033_completed_job_billing_invoice_per_client.sql", "034_completed_job_billing_finalize_invoice_per_client.sql",
      "035_reset_reminder_on_recurrence_change.sql", "036_reminder_claim_protocol.sql", "037_messages_sent_occurrence_snapshot.sql",
      "038_add_cancellation_correction_fields.sql", "039_preserve_cancelled_occurrence_exclusion.sql", "040_add_messages_sent_subject.sql",
      "041_block_early_job_start.sql", "042_add_demo_sessions.sql", "043_guest_control_permissions.sql", "044_shared_session_view.sql",
      "045_owner_sign_in_security.sql", "046_session_chat.sql", "047_atomic_future_edit.sql", "048_employee_seat_allowance.sql",
    ],
  });
  c = await db.connect();
  await c.query("SET TIME ZONE 'UTC'");
  pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 25 });
  adapterPool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 10, types: POSTGREST_TYPES as any });
  adapterPool.on("connect", (client) => client.query("SET TIME ZONE 'UTC'"));
  currentClient = createPostgrestAdapter(adapterPool).client;

  // Billing as the 033 function leaves it today.
  legacy = await newWorkspace();
  const seed = async (key: string, invoice: string | null, paid: boolean, method: string | null, clientId = legacy.clientId) => {
    L[key] = await completedJob(legacy, { clientId });
    await upsertBilling(c, legacy, L[key], clientId, invoice, paid, method);
  };
  await seed("cashClosed", null, true, "cash"); // closed by today's automatic Cash rule
  await seed("cashClosed2", null, true, "cash");
  await seed("zellePaidNoNumber", null, true, "zelle"); // shows "Needs invoice number" today
  await seed("cashUnpaid", null, false, "cash");
  await seed("cashWithNumber", "13422", true, "cash");
  await seed("qbUnpaid", "13480", false, null);
  legacyBefore = (await c.query("SELECT * FROM completed_job_billing WHERE workspace_id = $1 ORDER BY id", [legacy.workspaceId])).rows;

  preflight = await runSql("049-preflight.sql");
  // The SFT-prefix check, seen once with a conflicting number, then rolled back.
  await c.query("BEGIN");
  await c.query("UPDATE completed_job_billing SET invoice_number = 'sft-9' WHERE appointment_id = $1", [L.qbUnpaid]);
  preflightSft = await runSql("049-preflight.sql");
  await c.query("ROLLBACK");

  await c.query(M049); // the rollout
  postflight = await runSql("049-postflight.sql");
});

after(async () => {
  if (SKIP) return;
  await pool.end();
  await adapterPool.end();
  await c.end();
  await db.stop();
});

// ---------------------------------------------------------------------------
// Rollout
// ---------------------------------------------------------------------------

describe("Rollout (migration 049)", { skip: SKIP }, () => {
  test("049-preflight passes on the pre-rollout database (at 048) and counts what the backfill will mark, without names", () => {
    assert.equal(preflight.length, 11);
    assert.deepEqual(preflight.filter((r) => !r.ok), []);
    assert.equal(preflight.find((r) => r.check_name === "backfill_cash_closed_jobs")!.detail, "2 job(s) in 1 workspace(s) will be marked Paid directly, no invoice");
    assert.match(preflight.find((r) => r.check_name === "paid_other_without_number")!.detail, /^1 job\(s\)/);
    assert.ok(!JSON.stringify(preflight).includes("Client") && !JSON.stringify(preflight).includes("13422"), "counts only");
  });

  test("the preflight blocks the rollout if any saved number already starts with SFT (any case)", () => {
    const row = preflightSft.find((r) => r.check_name === "no_sft_numbers_in_use")!;
    assert.equal(row.ok, false);
    assert.match(row.detail, /^1 saved invoice number/);
  });

  test("049-postflight passes right after the rollout", () => {
    assert.equal(postflight.length, 13);
    assert.deepEqual(postflight.filter((r) => !r.ok), []);
    assert.equal(postflight.find((r) => r.check_name === "backfill_complete")!.detail, "2 job(s) marked Paid directly, no invoice");
  });

  test("the one-time backfill marks exactly the jobs closed by the old Cash rule; no existing value changes", async () => {
    const after1 = (await c.query("SELECT * FROM completed_job_billing WHERE workspace_id = $1 ORDER BY id", [legacy.workspaceId])).rows;
    const marked = Object.fromEntries(Object.entries(L).map(([k, id]) => [k, after1.find((r) => r.appointment_id === id).no_invoice_required]));
    assert.deepEqual(marked, {
      cashClosed: true, cashClosed2: true,
      zellePaidNoNumber: false, cashUnpaid: false, cashWithNumber: false, qbUnpaid: false,
    });
    assert.deepEqual(after1.map((row) => { const rest = { ...row }; delete rest.no_invoice_required; return rest; }), legacyBefore, "every other column (including updated_at) is byte-identical");
  });

  test("after the rollout the preflight says 049 is already applied", async () => {
    const again = await runSql("049-preflight.sql");
    assert.deepEqual(again.filter((r) => !r.ok).map((r) => r.check_name).sort(), ["no_name_conflicts", "not_applied_yet"]);
  });

  test("re-running 049 never applies the old Cash rule to newer jobs and never re-marks an undone job", async () => {
    const ws = await newWorkspace();
    // A newer job saved paid + Cash + no number (by the deployed app, the
    // old way) is NOT closed under the new rule...
    const newer = await completedJob(ws);
    assert.equal((await deployedSave(ws, { appointment_id: newer, paid: true, payment_method: "cash" })).status, 200);
    assert.equal((await billingRow(newer)).no_invoice_required, false);
    // ...and the owner undoes one backfilled job on purpose.
    assert.equal((await fn(c, "set_no_invoice_required", [legacy.workspaceId, L.cashClosed2, false, null])).outcome, "ok");

    const flagsBefore = (await c.query("SELECT appointment_id, no_invoice_required, updated_at FROM completed_job_billing ORDER BY appointment_id")).rows;
    await c.query(M049);
    await c.query(M049);
    const flagsAfter = (await c.query("SELECT appointment_id, no_invoice_required, updated_at FROM completed_job_billing ORDER BY appointment_id")).rows;
    assert.deepEqual(flagsAfter, flagsBefore, "re-runs change no row");
    assert.equal((await billingRow(newer)).no_invoice_required, false, "newer cash job still open");
    assert.equal((await billingRow(L.cashClosed2)).no_invoice_required, false, "undone job stays undone");
    assert.equal((await billingRow(L.cashClosed)).no_invoice_required, true, "backfilled job stays closed");
    // Put it back for the rest of the suite.
    assert.equal((await fn(c, "set_no_invoice_required", [legacy.workspaceId, L.cashClosed2, true, "cash"])).outcome, "ok");
  });

  test("Venmo is accepted; 'paid directly' must be paid, with a method and no number", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    await upsertBilling(c, ws, job, ws.clientId, null, true, "venmo");
    assert.equal((await billingRow(job)).payment_method, "venmo");
    await assert.rejects(c.query("UPDATE completed_job_billing SET paid = false WHERE appointment_id = $1 AND no_invoice_required", [L.cashClosed]), /no_invoice_required_shape/);
    await assert.rejects(c.query("UPDATE completed_job_billing SET payment_method = 'bitcoin' WHERE appointment_id = $1", [job]), /payment_method_valid/);
  });
});

// ---------------------------------------------------------------------------
// The deployed app after 049 (before the new app is deployed)
// ---------------------------------------------------------------------------

describe("The deployed Billing route (a593d9c) keeps working after 049", { skip: SKIP }, () => {
  test("ordinary edits: type a QuickBooks number, mark paid, change method, mark unpaid", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    let r = await deployedSave(ws, { appointment_id: job, invoice_number: " 13501 " });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.billing.invoice_number, "13501");
    r = await deployedSave(ws, { appointment_id: job, paid: true, payment_method: "zelle" });
    assert.equal(r.status, 200);
    r = await deployedSave(ws, { appointment_id: job, payment_method: "check" });
    assert.equal(r.status, 200);
    r = await deployedSave(ws, { appointment_id: job, paid: false });
    assert.equal(r.status, 200);
    const row = await billingRow(job);
    assert.deepEqual([row.invoice_number, row.paid, row.payment_method, row.no_invoice_required], ["13501", false, "check", false]);
  });

  test("one QuickBooks number across the same client's jobs still syncs paid; a different client is still refused", async () => {
    const ws = await newWorkspace();
    const a = await completedJob(ws);
    const b = await completedJob(ws);
    const other = await completedJob(ws, { clientId: ws.otherClientId });
    assert.equal((await deployedSave(ws, { appointment_id: a, invoice_number: "13600" })).status, 200);
    assert.equal((await deployedSave(ws, { appointment_id: b, invoice_number: "13600" })).status, 200);
    assert.equal((await deployedSave(ws, { appointment_id: a, paid: true, payment_method: "zelle" })).status, 200);
    assert.equal((await billingRow(b)).paid, true, "sibling synced");
    const cross = await deployedSave(ws, { appointment_id: other, invoice_number: "13600" });
    assert.equal(cross.status, 409);
    assert.match(cross.body.error, /different client/);
  });

  test("paid + Cash with no number still saves -- but no longer closes the job by itself", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    assert.equal((await deployedSave(ws, { appointment_id: job, paid: true, payment_method: "cash" })).status, 200);
    const row = await billingRow(job);
    assert.deepEqual([row.paid, row.payment_method, row.invoice_number, row.no_invoice_required], [true, "cash", null, false]);
  });

  test("an SFT number typed in the deployed app is refused with its existing friendly message; nothing is saved", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    for (const typed of ["SFT-1001", " sft-1001 ", "Sft1001", "SFT"]) {
      const r = await deployedSave(ws, { appointment_id: job, invoice_number: typed });
      assert.equal(r.status, 409, typed);
      assert.match(r.body.error, /already used by another job/);
    }
    assert.equal(await billingRow(job), null);
  });

  test("on a 'paid directly' job, the deployed app typing a number or marking unpaid ends 'paid directly'", async () => {
    const ws = await newWorkspace();
    const a = await completedJob(ws);
    const b = await completedJob(ws);
    // Cash: the realistic state while the deployed app is still live (the
    // backfilled jobs). Only the new app can save Venmo.
    for (const j of [a, b]) assert.equal((await fn(c, "set_no_invoice_required", [ws.workspaceId, j, true, "cash"])).outcome, "ok");
    assert.equal((await deployedSave(ws, { appointment_id: a, invoice_number: "13700" })).status, 200);
    assert.deepEqual([(await billingRow(a)).invoice_number, (await billingRow(a)).no_invoice_required], ["13700", false]);
    assert.equal((await deployedSave(ws, { appointment_id: b, paid: false })).status, 200);
    assert.deepEqual([(await billingRow(b)).paid, (await billingRow(b)).no_invoice_required], [false, false]);
  });

  test("the deployed app does not know Venmo: on a Venmo row it refuses safely (400) and changes nothing", async () => {
    // Cannot happen in production: Venmo is only offered by the new app,
    // which replaces the deployed one. Proven anyway so the window is safe.
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    await fn(c, "set_no_invoice_required", [ws.workspaceId, job, true, "venmo"]);
    const before1 = await billingRow(job);
    const r = await deployedSave(ws, { appointment_id: job, invoice_number: "13701" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid payment method/);
    assert.deepEqual(await billingRow(job), before1);
  });

  test("on an issued SFT invoice, the deployed app can mark it paid and unpaid; its number cannot be changed or cleared", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const issued = await renderAndIssue(pool, ws, d.invoice_id);
    assert.equal(issued.outcome, "issued");

    let r = await deployedSave(ws, { appointment_id: job, paid: true, payment_method: "zelle" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([(await billingRow(job)).invoice_number, (await billingRow(job)).paid], [issued.invoice_number, true]);
    r = await deployedSave(ws, { appointment_id: job, paid: false });
    assert.equal(r.status, 200);
    assert.equal((await billingRow(job)).paid, false);

    for (const typed of ["13800", "", null]) {
      r = await deployedSave(ws, { appointment_id: job, invoice_number: typed });
      assert.notEqual(r.status, 200, `changing to ${JSON.stringify(typed)} must be refused`);
      assert.equal((await billingRow(job)).invoice_number, issued.invoice_number);
    }
    // Still usable for Void & Reissue.
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, d.invoice_id, "wrong rate"])).outcome, "ok");
  });
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe("Drafts", { skip: SKIP }, () => {
  test("20 simultaneous creates with one request id (double-click / retry) make exactly one draft", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const requestId = randomUUID();
    const outs = await Promise.all(Array.from({ length: 20 }, () => createDraft(pool, ws, job, { requestId })));
    assert.ok(outs.every((o) => o.outcome === "ok"));
    assert.equal(new Set(outs.map((o) => o.invoice_id)).size, 1);
    assert.equal(outs.filter((o) => !o.replayed).length, 1);
    assert.equal(Number((await c.query("SELECT count(*) n FROM invoices WHERE appointment_id = $1", [job])).rows[0].n), 1);
  });

  test("a second, separate create for the same job is refused and points to the existing draft", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const first = await createDraft(pool, ws, job);
    const second = await createDraft(pool, ws, job);
    assert.equal(second.outcome, "job_has_invoice");
    assert.equal(second.invoice_id, first.invoice_id);
  });

  test("refused for a job with a QuickBooks number, a job paid directly, a cancelled job, or another workspace's job", async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    const linked = await completedJob(ws);
    await upsertBilling(c, ws, linked, ws.clientId, "13900", false, null);
    const direct = await completedJob(ws);
    await fn(c, "set_no_invoice_required", [ws.workspaceId, direct, true, "cash"]);
    const cancelled = await completedJob(ws, { status: "cancelled" });
    assert.equal((await createDraft(pool, ws, linked)).outcome, "job_has_invoice_number");
    assert.equal((await createDraft(pool, ws, direct)).outcome, "job_paid_directly");
    assert.equal((await createDraft(pool, ws, cancelled)).outcome, "appointment_cancelled");
    assert.equal((await createDraft(pool, other, linked)).outcome, "not_found");
    assert.equal(Number((await c.query("SELECT count(*) n FROM invoices WHERE appointment_id = ANY($1)", [[linked, direct, cancelled]])).rows[0].n), 0);
  });

  test("the amount is Qty x Rate computed by the database; the job price is kept for reference", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws, { priceCents: 15000 });
    const d = await createDraft(pool, ws, job, { fields: { quantity: 2.5, rate_cents: 6400, amount_cents: 1 } });
    const inv = await invoiceRow(d.invoice_id);
    assert.deepEqual([Number(inv.quantity), inv.rate_cents, inv.amount_cents, inv.total_cents, inv.job_price_cents], [2.5, 6400, 16000, 16000, 15000]);
  });

  test("every content edit is a new revision (even a raw UPDATE); a no-op is not; a stale tab is refused", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    assert.equal(d.revision, 1);
    let u = await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 1, JSON.stringify(draftFields({ description: "Deep clean" }))]);
    assert.deepEqual([u.outcome, u.revision], ["ok", 2]);
    u = await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 2, JSON.stringify(draftFields({ description: "Deep clean" }))]);
    assert.deepEqual([u.outcome, u.revision], ["ok", 2], "no change, same revision");
    u = await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 1, JSON.stringify(draftFields())]);
    assert.deepEqual([u.outcome, u.revision], ["stale_revision", 2]);
    await c.query("UPDATE invoices SET note_to_client = 'Thanks!', revision = 1 WHERE id = $1", [d.invoice_id]);
    assert.equal((await invoiceRow(d.invoice_id)).revision, 3, "the trigger sets the revision, not the caller");
  });

  test("a draft can be discarded; then the job can get a new draft", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    assert.equal((await fn(pool, "discard_invoice_draft", [ws.workspaceId, d.invoice_id])).outcome, "ok");
    assert.equal(await invoiceRow(d.invoice_id), null);
    assert.equal((await createDraft(pool, ws, job)).outcome, "ok");
  });
});

// ---------------------------------------------------------------------------
// Issue: number + stored PDF + Billing, together
// ---------------------------------------------------------------------------

describe("Issuing", { skip: SKIP }, () => {
  test("issues SFT-1001 with the stored PDF and writes the number to Billing, keeping paid status as it was", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const paidFirst = await completedJob(ws);
    await upsertBilling(c, ws, paidFirst, ws.clientId, null, true, "zelle"); // paid before invoicing (not "directly")

    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    assert.equal(r.invoice_number, "SFT-1001");
    assert.equal(r.render_snapshot.invoice_number, "SFT-1001");
    const out = await issue(pool, ws, d.invoice_id, r);
    assert.deepEqual([out.outcome, out.invoice_number], ["issued", "SFT-1001"]);
    await assertStoredPdfAgrees(d.invoice_id);
    const b = await billingRow(job);
    assert.deepEqual([b.invoice_number, b.paid, b.payment_method, b.client_id], ["SFT-1001", false, null, ws.clientId]);
    assert.equal(await counter(ws), 1002);

    const d2 = await createDraft(pool, ws, paidFirst);
    assert.equal((await renderAndIssue(pool, ws, d2.invoice_id)).invoice_number, "SFT-1002");
    const b2 = await billingRow(paidFirst);
    assert.deepEqual([b2.invoice_number, b2.paid, b2.payment_method], ["SFT-1002", true, "zelle"]);
  });

  test("an edit made while the PDF was rendering is caught: nothing is issued, no number is used", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id); // revision 1
    await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 1, JSON.stringify(draftFields({ rate_cents: 17500 }))]);
    const out = await issue(pool, ws, d.invoice_id, r);
    assert.deepEqual([out.outcome, out.revision], ["stale_revision", 2]);
    assert.equal((await invoiceRow(d.invoice_id)).status, "draft");
    assert.equal(await counter(ws), null, "no number consumed");
    assert.equal(await billingRow(job), null);
    // Re-render from revision 2 and issue: the PDF has the edited amount.
    assert.equal((await renderAndIssue(pool, ws, d.invoice_id)).invoice_number, "SFT-1001");
    await assertStoredPdfAgrees(d.invoice_id);
    assert.equal(decodeStoredPdf((await invoiceRow(d.invoice_id)).pdf).total_cents, 17500);
  });

  test("edit and issue at the same moment, edit first: the issue waits, then is refused as stale", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    const editor = await db.connect();
    const issuer = await db.connect();
    const issuerPid = await backendPid(issuer);
    try {
      await editor.query("BEGIN");
      await fn(editor, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 1, JSON.stringify(draftFields({ description: "Edited while rendering" }))]);
      const pending = track(issue(issuer, ws, d.invoice_id, r));
      await waitUntilBlocked(c, issuerPid);
      assert.equal(pending.settled(), false);
      await editor.query("COMMIT");
      assert.equal((await pending.result).outcome, "stale_revision");
    } finally {
      await editor.end();
      await issuer.end();
    }
    assert.equal((await invoiceRow(d.invoice_id)).status, "draft");
    await renderAndIssue(pool, ws, d.invoice_id);
    await assertStoredPdfAgrees(d.invoice_id);
    assert.equal(decodeStoredPdf((await invoiceRow(d.invoice_id)).pdf).description, "Edited while rendering");
  });

  test("edit and issue at the same moment, issue first: the edit waits, then is refused; the PDF keeps the original", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    const editor = await db.connect();
    const issuer = await db.connect();
    const editorPid = await backendPid(editor);
    try {
      await issuer.query("BEGIN");
      assert.equal((await issue(issuer, ws, d.invoice_id, r)).outcome, "issued");
      const pending = track(fn(editor, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 1, JSON.stringify(draftFields({ description: "Too late" }))]));
      await waitUntilBlocked(c, editorPid);
      await issuer.query("COMMIT");
      const out = await pending.result;
      assert.deepEqual([out.outcome, out.status, out.invoice_number], ["not_draft", "issued", "SFT-1001"]);
    } finally {
      await editor.end();
      await issuer.end();
    }
    await assertStoredPdfAgrees(d.invoice_id);
    assert.equal(decodeStoredPdf((await invoiceRow(d.invoice_id)).pdf).description, "Biweekly cleaning");
  });

  test("two invoices issued at the same moment with the same proposed number: one gets it, the other re-renders with the next", async () => {
    const ws = await newWorkspace();
    const x = await createDraft(pool, ws, await completedJob(ws));
    const y = await createDraft(pool, ws, await completedJob(ws));
    const rx = await render(pool, ws, x.invoice_id);
    const ry = await render(pool, ws, y.invoice_id);
    assert.equal(rx.invoice_number, ry.invoice_number);
    const a = await db.connect();
    const b = await db.connect();
    const bPid = await backendPid(b);
    try {
      await a.query("BEGIN");
      assert.equal((await issue(a, ws, x.invoice_id, rx)).outcome, "issued");
      const pending = track(issue(b, ws, y.invoice_id, ry));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      const out = await pending.result;
      assert.deepEqual([out.outcome, out.invoice_number], ["number_changed", "SFT-1002"]);
    } finally {
      await a.end();
      await b.end();
    }
    assert.equal((await invoiceRow(y.invoice_id)).status, "draft", "the loser wrote nothing");
    assert.equal((await renderAndIssue(pool, ws, y.invoice_id)).invoice_number, "SFT-1002");
    await assertStoredPdfAgrees(x.invoice_id);
    await assertStoredPdfAgrees(y.invoice_id);
    assert.equal(await counter(ws), 1003);
  });

  test("ten invoices issued at once get SFT-1001..SFT-1010, no repeats, no gaps, every PDF agreeing", async () => {
    const ws = await newWorkspace();
    const drafts = [];
    for (let i = 0; i < 10; i++) drafts.push(await createDraft(pool, ws, await completedJob(ws)));
    const outs = await Promise.all(drafts.map((d) => renderAndIssue(pool, ws, d.invoice_id)));
    assert.deepEqual(outs.map((o) => o.invoice_number).sort((p, q) => Number(p.slice(4)) - Number(q.slice(4))),
      Array.from({ length: 10 }, (_, i) => `SFT-${1001 + i}`));
    for (const d of drafts) await assertStoredPdfAgrees(d.invoice_id);
  });

  test("20 simultaneous issues of the same invoice (double-click): one issue, one number", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    const outs = await Promise.all(Array.from({ length: 20 }, () => issue(pool, ws, d.invoice_id, r)));
    assert.equal(outs.filter((o) => o.outcome === "issued").length, 1);
    assert.equal(outs.filter((o) => o.outcome === "already_issued").length, 19);
    assert.ok(outs.every((o) => o.invoice_number === "SFT-1001"));
    assert.equal(await counter(ws), 1002);
    await assertStoredPdfAgrees(d.invoice_id);
  });

  test("refuses a PDF that does not match: tampered details, wrong hash, not a PDF, or a number not yet proposed", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    const tampered = { ...r.render_snapshot, total_cents: 1 };
    assert.equal((await issue(pool, ws, d.invoice_id, { ...r, render_snapshot: tampered, pdf: renderPdf(tampered) })).outcome, "snapshot_mismatch");
    assert.equal((await issue(pool, ws, d.invoice_id, { ...r, pdf: { ...r.pdf, sha256: "0".repeat(64) } })).outcome, "pdf_invalid");
    const notPdf = Buffer.from("hello");
    assert.equal((await issue(pool, ws, d.invoice_id, { ...r, pdf: { base64: notPdf.toString("base64"), sha256: createHash("sha256").update(notPdf).digest("hex") } })).outcome, "pdf_invalid");
    assert.equal((await issue(pool, ws, d.invoice_id, { ...r, invoice_number: "SFT-1005" })).outcome, "number_changed");
    assert.equal((await invoiceRow(d.invoice_id)).status, "draft");
    assert.equal(await counter(ws), 1001, "counter row created, nothing consumed");
    assert.equal(await billingRow(job), null);
  });

  test("if the Billing write fails inside the issue, nothing is kept: no number, no PDF, no Billing change", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    await c.query(`CREATE FUNCTION test_fail_billing() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.appointment_id = '${job}' THEN RAISE EXCEPTION 'injected billing failure'; END IF; RETURN NEW; END $$`);
    await c.query("CREATE TRIGGER test_fail_billing BEFORE INSERT OR UPDATE ON completed_job_billing FOR EACH ROW EXECUTE FUNCTION test_fail_billing()");
    try {
      await assert.rejects(issue(pool, ws, d.invoice_id, r), /injected billing failure/);
    } finally {
      await c.query("DROP TRIGGER test_fail_billing ON completed_job_billing");
      await c.query("DROP FUNCTION test_fail_billing()");
    }
    const inv = await invoiceRow(d.invoice_id);
    assert.deepEqual([inv.status, inv.invoice_number, inv.pdf], ["draft", null, null]);
    assert.equal(await counter(ws), null);
    assert.equal(await billingRow(job), null);
    assert.equal((await issue(pool, ws, d.invoice_id, r)).outcome, "issued", "the same render issues fine afterwards");
  });
});

// ---------------------------------------------------------------------------
// Create Invoice vs Link Existing Invoice (and vs Paid directly), same job
// ---------------------------------------------------------------------------

describe("Create Invoice and Link Existing Invoice at the same time", { skip: SKIP }, () => {
  // Create Invoice = create draft -> render -> issue (the full app flow).
  async function createInvoiceFlow(ws: Ws, job: string) {
    const d = await createDraft(pool, ws, job);
    if (d.outcome !== "ok") return { stage: "draft", outcome: d.outcome };
    const out = await renderAndIssue(pool, ws, d.invoice_id);
    return { stage: "issue", outcome: out.outcome, invoiceId: d.invoice_id };
  }

  async function assertOneWinner(ws: Ws, job: string, create: any, link: { ok: boolean; error?: string }) {
    const live = (await c.query("SELECT * FROM invoices WHERE appointment_id = $1 AND status IN ('draft','issued')", [job])).rows;
    const b = await billingRow(job);
    if (link.ok) {
      // Link won: the QuickBooks number, and no draft or issued invoice.
      assert.equal(b.invoice_number, "QB-77001");
      assert.equal(live.length, 0);
      assert.equal(create.stage, "draft");
      assert.equal(create.outcome, "job_has_invoice_number");
    } else {
      // Create won: an issued invoice whose number is the one in Billing.
      assert.match(link.error!, /invoice_draft_exists|invoice_number_locked/);
      assert.equal(live.length, 1);
      assert.equal(live[0].status, "issued");
      assert.equal(b.invoice_number, live[0].invoice_number);
      await assertStoredPdfAgrees(live[0].id);
    }
  }

  test("50 rounds through the database functions: exactly one wins every time, never a mixed state", async (t) => {
    const ws = await newWorkspace();
    let createWins = 0;
    let linkWins = 0;
    for (let round = 0; round < 50; round++) {
      const job = await completedJob(ws);
      const linkP = (async () => {
        if (round % 2) await new Promise((res) => setImmediate(res));
        try {
          await upsertBilling(pool, ws, job, ws.clientId, "QB-77001", false, null);
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: e.message as string };
        }
      })();
      const [create, link] = await Promise.all([createInvoiceFlow(ws, job), linkP]);
      await assertOneWinner(ws, job, create, link);
      if (link.ok) linkWins++;
      else createWins++;
    }
    assert.equal(createWins + linkWins, 50);
    t.diagnostic(`Create won ${createWins}, Link won ${linkWins}`);
  });

  test("20 rounds against the deployed Billing route: exactly one wins every time", async () => {
    const ws = await newWorkspace();
    for (let round = 0; round < 20; round++) {
      const job = await completedJob(ws);
      const linkP = deployedSave(ws, { appointment_id: job, invoice_number: "QB-77001" }).then((r) =>
        r.status === 200 ? { ok: true } : { ok: false, error: String(r.body.error) });
      const [create, link] = await Promise.all([createInvoiceFlow(ws, job), linkP]);
      await assertOneWinner(ws, job, create, link);
    }
  });

  test("deterministic, both orders: link holding the job lock makes Create refuse; a draft holding it makes Link refuse", async () => {
    const ws = await newWorkspace();
    const a = await db.connect();
    const b = await db.connect();
    const bPid = await backendPid(b);
    try {
      // Link first.
      const job1 = await completedJob(ws);
      await a.query("BEGIN");
      await upsertBilling(a, ws, job1, ws.clientId, "QB-77001", false, null);
      const pendingCreate = track(createDraft(b, ws, job1));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      assert.equal((await pendingCreate.result).outcome, "job_has_invoice_number");

      // Create first.
      const job2 = await completedJob(ws);
      await a.query("BEGIN");
      assert.equal((await createDraft(a, ws, job2)).outcome, "ok");
      const pendingLink = track(upsertBilling(b, ws, job2, ws.clientId, "QB-77001", false, null));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      await assert.rejects(pendingLink.result, /invoice_draft_exists/);
      assert.equal(await billingRow(job2), null);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("Create Invoice vs Paid directly, 20 rounds: exactly one wins every time", async () => {
    const ws = await newWorkspace();
    for (let round = 0; round < 20; round++) {
      const job = await completedJob(ws);
      const [create, direct] = await Promise.all([
        createInvoiceFlow(ws, job),
        fn(pool, "set_no_invoice_required", [ws.workspaceId, job, true, "venmo"]),
      ]);
      const b = await billingRow(job);
      const live = (await c.query("SELECT * FROM invoices WHERE appointment_id = $1 AND status IN ('draft','issued')", [job])).rows;
      if (direct.outcome === "ok") {
        assert.deepEqual([create.stage, create.outcome, live.length, b.no_invoice_required, b.invoice_number], ["draft", "job_paid_directly", 0, true, null]);
      } else {
        assert.equal(direct.outcome, "job_has_invoice");
        assert.equal(live[0].status, "issued");
        assert.equal(b.no_invoice_required, false);
        await assertStoredPdfAgrees(live[0].id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Paid / unpaid on an issued invoice, Void & Reissue, frozen documents
// ---------------------------------------------------------------------------

describe("Paid status, Void & Reissue", { skip: SKIP }, () => {
  test("Billing can mark an issued invoice paid (any method) and unpaid; its number cannot change or be cleared", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const { invoice_number } = await renderAndIssue(pool, ws, d.invoice_id);
    await upsertBilling(pool, ws, job, ws.clientId, invoice_number, true, "venmo");
    assert.deepEqual([(await billingRow(job)).paid, (await billingRow(job)).payment_method], [true, "venmo"]);
    await upsertBilling(pool, ws, job, ws.clientId, invoice_number, false, "venmo");
    assert.equal((await billingRow(job)).paid, false);
    await assert.rejects(upsertBilling(pool, ws, job, ws.clientId, "13999", false, null), (e: any) => e.code === "IV002");
    await assert.rejects(upsertBilling(pool, ws, job, ws.clientId, null, false, null), (e: any) => e.code === "IV002");
    assert.equal((await billingRow(job)).invoice_number, invoice_number);
    await assertStoredPdfAgrees(d.invoice_id);
  });

  test("a paid invoice cannot be voided; once unpaid it can, and its number is retired forever", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const { invoice_number } = await renderAndIssue(pool, ws, d.invoice_id);
    assert.equal(invoice_number, "SFT-1001");
    await upsertBilling(pool, ws, job, ws.clientId, invoice_number, true, "zelle");
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, d.invoice_id, "wrong rate"])).outcome, "invoice_paid");
    await upsertBilling(pool, ws, job, ws.clientId, invoice_number, false, "zelle");
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, d.invoice_id, " "])).outcome, "reason_required");
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, d.invoice_id, "wrong rate"])).outcome, "ok");

    const voided = await invoiceRow(d.invoice_id);
    assert.deepEqual([voided.status, voided.invoice_number, voided.void_reason], ["void", "SFT-1001", "wrong rate"]);
    await assertStoredPdfAgrees(d.invoice_id); // the voided document is kept intact
    assert.equal((await billingRow(job)).invoice_number, null, "Billing number cleared");

    // The retired number can never be linked by hand...
    for (const typed of ["SFT-1001", "sft-1001", " SFT-1001 ", "SFT1001"]) {
      await assert.rejects(upsertBilling(pool, ws, job, ws.clientId, typed, false, null), /invoice_number_reserved/, typed);
    }
    // ...nor reissued: the reissue gets the next number.
    assert.equal((await createDraft(pool, ws, job, { fields: { reissued_from_invoice_id: randomUUID() } })).outcome, "invalid_reissue");
    const re = await createDraft(pool, ws, job, { fields: { reissued_from_invoice_id: d.invoice_id, rate_cents: 16000 } });
    assert.equal(re.outcome, "ok");
    assert.equal((await renderAndIssue(pool, ws, re.invoice_id)).invoice_number, "SFT-1002");
    assert.equal((await invoiceRow(re.invoice_id)).reissued_from_invoice_id, d.invoice_id);
    await assertStoredPdfAgrees(re.invoice_id);
  });

  test("issued and void invoices are frozen against any direct write; only drafts can be deleted", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    await renderAndIssue(pool, ws, d.invoice_id);
    const id = d.invoice_id;
    const frozen = (e: any) => e.code === "IV010";
    await assert.rejects(c.query("UPDATE invoices SET rate_cents = 1, amount_cents = 1, total_cents = 1 WHERE id = $1", [id]), frozen);
    await assert.rejects(c.query("UPDATE invoices SET pdf = '\\x255044462d00'::bytea WHERE id = $1", [id]), frozen);
    await assert.rejects(c.query("UPDATE invoices SET status = 'draft', invoice_number = NULL, issued_at = NULL, render_snapshot = NULL, pdf = NULL, pdf_sha256 = NULL WHERE id = $1", [id]), frozen);
    await assert.rejects(c.query("DELETE FROM invoices WHERE id = $1", [id]), frozen);
    await fn(pool, "void_invoice", [ws.workspaceId, id, "test"]);
    await assert.rejects(c.query("UPDATE invoices SET status = 'issued', voided_at = NULL, void_reason = NULL WHERE id = $1", [id]), frozen);
    await assert.rejects(c.query("UPDATE invoices SET void_reason = 'changed' WHERE id = $1", [id]), frozen);
    await assert.rejects(c.query("DELETE FROM invoices WHERE id = $1", [id]), frozen);
    await assertStoredPdfAgrees(id);
  });

  test("a saved invoice keeps its details when the client, job price or business settings change later", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws, { priceCents: 15000 });
    const d = await createDraft(pool, ws, job);
    await renderAndIssue(pool, ws, d.invoice_id);
    const before1 = await invoiceRow(d.invoice_id);
    await c.query("UPDATE clients SET name = 'Renamed', address = 'Elsewhere' WHERE id = $1", [ws.clientId]);
    await c.query("UPDATE appointments SET price_cents = 99900, service_type = 'Changed' WHERE id = $1", [job]);
    await c.query("UPDATE company_settings SET company_name = 'New name' WHERE workspace_id = $1", [ws.workspaceId]);
    assert.deepEqual(await invoiceRow(d.invoice_id), before1);
    await assertStoredPdfAgrees(d.invoice_id);
  });
});

// ---------------------------------------------------------------------------
// Paid directly, no invoice
// ---------------------------------------------------------------------------

describe("Paid directly, no invoice", { skip: SKIP }, () => {
  test("is an explicit choice with any supported method; the method alone never closes a job", async () => {
    const ws = await newWorkspace();
    for (const method of ["cash", "venmo", "zelle", "check", "quickbooks_card", "other"]) {
      const chosenOnly = await completedJob(ws);
      await upsertBilling(pool, ws, chosenOnly, ws.clientId, null, true, method);
      assert.equal((await billingRow(chosenOnly)).no_invoice_required, false, `${method} alone stays open`);
      const confirmed = await completedJob(ws);
      assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, confirmed, true, method])).outcome, "ok");
      const b = await billingRow(confirmed);
      assert.deepEqual([b.paid, b.payment_method, b.invoice_number, b.no_invoice_required], [true, method, null, true]);
    }
  });

  test("needs a valid method; refused when the job has an SFT draft/invoice or a QuickBooks number; undo keeps paid", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, job, true, null])).outcome, "invalid_payment_method");
    assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, job, true, "bitcoin"])).outcome, "invalid_payment_method");
    const withDraft = await completedJob(ws);
    await createDraft(pool, ws, withDraft);
    assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, withDraft, true, "cash"])).outcome, "job_has_invoice");
    const linked = await completedJob(ws);
    await upsertBilling(pool, ws, linked, ws.clientId, "14001", false, null);
    assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, linked, true, "cash"])).outcome, "job_has_invoice_number");

    assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, job, true, "venmo"])).outcome, "ok");
    assert.equal((await fn(pool, "set_no_invoice_required", [ws.workspaceId, job, false, null])).outcome, "ok");
    const b = await billingRow(job);
    assert.deepEqual([b.paid, b.payment_method, b.no_invoice_required], [true, "venmo", false]);
  });

  test("a legacy saved number that starts with SFT can still be marked paid, but not changed to another SFT number", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    await c.query("INSERT INTO completed_job_billing (workspace_id, appointment_id, client_id, invoice_number) VALUES ($1, $2, $3, 'SFT-OLD-1')",
      [ws.workspaceId, job, ws.clientId]);
    await upsertBilling(pool, ws, job, ws.clientId, "SFT-OLD-1", true, "check");
    assert.equal((await billingRow(job)).paid, true);
    await assert.rejects(upsertBilling(pool, ws, job, ws.clientId, "SFT-OLD-2", true, "check"), /invoice_number_reserved/);
  });
});

// ---------------------------------------------------------------------------
// Workspaces and access
// ---------------------------------------------------------------------------

describe("Workspaces and access", { skip: SKIP }, () => {
  test("each workspace has its own series; one workspace cannot see, render, edit, issue or void another's invoice", async () => {
    const ws1 = await newWorkspace();
    const ws2 = await newWorkspace();
    const d1 = await createDraft(pool, ws1, await completedJob(ws1));
    const d2 = await createDraft(pool, ws2, await completedJob(ws2));
    const r1 = await render(pool, ws1, d1.invoice_id);
    assert.equal((await fn(pool, "invoice_render_input", [ws2.workspaceId, d1.invoice_id])).outcome, "not_found");
    assert.equal((await fn(pool, "update_invoice_draft", [ws2.workspaceId, d1.invoice_id, 1, JSON.stringify(draftFields())])).outcome, "not_found");
    assert.equal((await issue(pool, ws2, d1.invoice_id, r1)).outcome, "not_found");
    assert.equal((await fn(pool, "discard_invoice_draft", [ws2.workspaceId, d1.invoice_id])).outcome, "not_found");
    assert.equal((await renderAndIssue(pool, ws1, d1.invoice_id)).invoice_number, "SFT-1001");
    assert.equal((await renderAndIssue(pool, ws2, d2.invoice_id)).invoice_number, "SFT-1001");
    assert.equal((await fn(pool, "void_invoice", [ws2.workspaceId, d1.invoice_id, "x"])).outcome, "not_found");
  });

  test("only the service role can run the functions or read the tables", async () => {
    const { rows } = await c.query(`
      SELECT p.proname, r AS role, has_function_privilege(r, p.oid, 'EXECUTE') AS can
      FROM pg_proc p, unnest(ARRAY['anon', 'authenticated', 'service_role']) r
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('upsert_completed_job_billing', 'set_no_invoice_required', 'create_invoice_draft', 'update_invoice_draft',
                          'discard_invoice_draft', 'invoice_render_input', 'issue_invoice', 'void_invoice',
                          'invoice_number_key', 'invoice_number_taken', 'invoice_next_available_number',
                          'invoice_numbering_state', 'set_invoice_starting_number')`);
    assert.deepEqual(rows.filter((x) => x.can !== (x.role === "service_role")), []);
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["invoices", "invoice_counters"]) {
        assert.equal((await c.query("SELECT has_table_privilege($1, $2, 'SELECT') AS can", [role, `public.${t}`])).rows[0].can, false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Starting invoice number (continue QuickBooks numbering)
// ---------------------------------------------------------------------------

describe("Starting invoice number", { skip: SKIP }, () => {
  const setStart = (cl: pg.Client | pg.Pool, ws: Ws, n: number | null) => fn(cl, "set_invoice_starting_number", [ws.workspaceId, n]);
  const state = (ws: Ws) => fn(pool, "invoice_numbering_state", [ws.workspaceId]);
  const link = async (cl: pg.Client | pg.Pool, ws: Ws, job: string, n: string) => {
    try {
      await upsertBilling(cl, ws, job, ws.clientId, n, false, null);
      return { ok: true as const };
    } catch (e: any) {
      return { ok: false as const, error: e.message as string, code: e.code as string };
    }
  };
  async function linkedJob(ws: Ws, n: string) {
    const job = await completedJob(ws);
    await upsertBilling(pool, ws, job, ws.clientId, n, false, null);
    return job;
  }
  async function issueNew(ws: Ws) {
    const d = await createDraft(pool, ws, await completedJob(ws));
    const out = await renderAndIssue(pool, ws, d.invoice_id);
    assert.equal(out.outcome, "issued", JSON.stringify(out));
    await assertStoredPdfAgrees(d.invoice_id);
    return { id: d.invoice_id as string, number: out.invoice_number as string };
  }
  // No number may belong to two different jobs, whatever mix of SFT
  // invoices (issued or void) and Billing numbers holds it.
  async function assertNoNumberSharedAcrossJobs(ws: Ws) {
    const { rows } = await c.query(`
      WITH held AS (
        SELECT invoice_number_key(invoice_number) AS k, appointment_id FROM invoices WHERE workspace_id = $1 AND invoice_number IS NOT NULL
        UNION
        SELECT invoice_number_key(invoice_number), appointment_id FROM completed_job_billing WHERE workspace_id = $1 AND invoice_number IS NOT NULL)
      SELECT k, count(DISTINCT appointment_id) AS jobs FROM held GROUP BY k HAVING count(DISTINCT appointment_id) > 1`, [ws.workspaceId]);
    assert.deepEqual(rows, []);
  }

  test("default: no setting means the SFT series; nothing recorded means no guide number", async () => {
    const ws = await newWorkspace();
    assert.deepEqual(await state(ws), { series: "sft", starting_number: null, next_available: "SFT-1001", locked: false, highest_recorded: null });
    assert.equal((await issueNew(ws)).number, "SFT-1001");
    assert.equal((await issueNew(ws)).number, "SFT-1002");
  });

  test("start 13485: issued as 13485 then 13486, no prefix -- the same plain number in Billing and on the stored PDF; other workspaces keep SFT-1001", async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace();
    await linkedJob(ws, "13484"); // the last QuickBooks invoice recorded in Billing
    const st = await state(ws);
    assert.deepEqual(st.highest_recorded, { number: "13484", value: "13484", client_name: "Izabel" });
    const set = await setStart(pool, ws, 13485);
    assert.equal(set.outcome, "ok");
    assert.deepEqual([set.state.series, set.state.starting_number, set.state.next_available, set.state.locked], ["custom", 13485, "13485", false]);

    const first = await issueNew(ws);
    const second = await issueNew(ws);
    assert.deepEqual([first.number, second.number], ["13485", "13486"]);
    for (const inv of [first, second]) {
      const row = await invoiceRow(inv.id);
      assert.equal(decodeStoredPdf(row.pdf).invoice_number, inv.number, "stored PDF prints the plain number");
      assert.equal((await billingRow(row.appointment_id)).invoice_number, inv.number, "Billing shows the same plain number");
    }
    assert.equal(await counter(ws), 13487);
    assert.equal((await state(ws)).next_available, "13487");
    assert.equal((await issueNew(other)).number, "SFT-1001", "another workspace is unaffected");
  });

  test("the start must be above the highest numeric number in Billing (compared as a number); text numbers are ignored; range 1..999,999,999", async () => {
    const ws = await newWorkspace();
    await linkedJob(ws, "13484");
    await linkedJob(ws, "013490"); // leading zero: still 13490
    await linkedJob(ws, "QB-99999"); // not a plain number: not a guide
    await linkedJob(ws, "9999"); // shorter, lower
    const st = await state(ws);
    assert.deepEqual(st.highest_recorded, { number: "013490", value: "13490", client_name: "Izabel" });
    for (const n of [13490, 13000, 1]) {
      const out = await setStart(pool, ws, n);
      assert.equal(out.outcome, "at_or_below_recorded", String(n));
    }
    assert.equal((await setStart(pool, ws, 0)).outcome, "invalid");
    assert.equal((await setStart(pool, ws, 1_000_000_000)).outcome, "invalid");
    assert.equal(await counter(ws), 1001, "a refused start changes nothing");
    assert.equal((await state(ws)).series, "sft");
    assert.equal((await setStart(pool, ws, 13491)).outcome, "ok");
    assert.equal((await state(ws)).next_available, "13491");
  });

  test("changeable while only drafts exist (the draft's number follows), clearable back to SFT-1001; locked from the first issue on, even after it is voided", async () => {
    const ws = await newWorkspace();
    const d = await createDraft(pool, ws, await completedJob(ws));
    assert.equal((await render(pool, ws, d.invoice_id)).invoice_number, "SFT-1001");
    assert.equal((await setStart(pool, ws, 20000)).outcome, "ok");
    assert.equal((await render(pool, ws, d.invoice_id)).invoice_number, "20000");
    assert.equal((await setStart(pool, ws, 30000)).outcome, "ok");
    assert.equal((await render(pool, ws, d.invoice_id)).invoice_number, "30000");
    assert.equal((await setStart(pool, ws, null)).outcome, "ok");
    assert.deepEqual([(await state(ws)).series, (await state(ws)).next_available], ["sft", "SFT-1001"]);
    assert.equal((await setStart(pool, ws, 30000)).outcome, "ok");

    const out = await renderAndIssue(pool, ws, d.invoice_id);
    assert.equal(out.invoice_number, "30000");
    const locked = await state(ws);
    assert.deepEqual([locked.locked, locked.starting_number, locked.next_available], [true, null, "30001"]);
    for (const n of [40000, null]) assert.equal((await setStart(pool, ws, n)).outcome, "locked");

    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, d.invoice_id, "wrong client"])).outcome, "ok");
    assert.equal((await state(ws)).locked, true, "still locked after the only issued invoice is voided");
    assert.equal((await setStart(pool, ws, 40000)).outcome, "locked");
    assert.equal((await setStart(pool, ws, null)).outcome, "locked");
    assert.equal((await issueNew(ws)).number, "30001", "the voided 30000 is never reused");
  });

  test("issuing skips numbers already in Billing -- including ones linked after the start was set, with leading zeros or #", async () => {
    const ws = await newWorkspace();
    await linkedJob(ws, "13484");
    assert.equal((await setStart(pool, ws, 13485)).outcome, "ok");
    await linkedJob(ws, "13486"); // QuickBooks invoices linked later
    await linkedJob(ws, "013487");
    await linkedJob(ws, "#13489");
    assert.equal((await state(ws)).next_available, "13485");
    assert.equal((await issueNew(ws)).number, "13485");
    const d = await createDraft(pool, ws, await completedJob(ws));
    assert.equal((await render(pool, ws, d.invoice_id)).invoice_number, "13488", "the preview already skips 13486 and 013487");
    assert.equal((await renderAndIssue(pool, ws, d.invoice_id)).invoice_number, "13488");
    assert.equal((await issueNew(ws)).number, "13490", "#13489 is skipped too");
    assert.equal(await counter(ws), 13491);
    await assertNoNumberSharedAcrossJobs(ws);
  });

  test("linking refuses an issued or voided SFT invoice's number, however it is typed; a later number is accepted and then skipped", async () => {
    const ws = await newWorkspace();
    await linkedJob(ws, "13484");
    await setStart(pool, ws, 13485);
    const inv = await issueNew(ws); // 13485
    const job = await completedJob(ws);
    for (const typed of ["13485", "013485", "#13485", "#0013485"]) {
      const out = await link(pool, ws, job, typed);
      assert.equal(out.ok, false, typed);
      assert.equal(out.code, "23505");
      assert.match(out.error!, /completed_job_billing_invoice_number_reserved/);
    }
    assert.equal(await billingRow(job), null, "nothing saved");
    // The issued invoice's own job can still be marked paid with its number.
    const own = (await invoiceRow(inv.id)).appointment_id;
    await upsertBilling(pool, ws, own, ws.clientId, "13485", true, "zelle");
    assert.equal((await billingRow(own)).paid, true);
    await upsertBilling(pool, ws, own, ws.clientId, "13485", false, "zelle");
    // Voided: the number stays retired.
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, inv.id, "typo"])).outcome, "ok");
    assert.equal((await link(pool, ws, job, "13485")).ok, false);
    assert.equal((await link(pool, ws, own, "13485")).ok, false, "not even on the voided invoice's own job");
    // SFT stays reserved in a custom-numbered workspace too.
    assert.equal((await link(pool, ws, job, "SFT-1")).ok, false);
    // A number SFT has not reached yet is a real QuickBooks invoice: accepted, then skipped.
    assert.equal((await link(pool, ws, job, "13486")).ok, true);
    assert.equal((await issueNew(ws)).number, "13487");
    await assertNoNumberSharedAcrossJobs(ws);
  });

  test("the deployed Billing route typing an SFT invoice's plain number gets its existing friendly refusal; nothing saved", async () => {
    const ws = await newWorkspace();
    await setStart(pool, ws, 50000);
    await issueNew(ws);
    const job = await completedJob(ws);
    for (const typed of ["50000", "050000"]) {
      const r = await deployedSave(ws, { appointment_id: job, invoice_number: typed });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error, "That invoice number is already used by another job in this workspace.");
    }
    assert.equal(await billingRow(job), null);
  });

  test("linking while issuing, link first: the issue waits, then re-renders with the next free number", async () => {
    const ws = await newWorkspace();
    await setStart(pool, ws, 13485);
    const d = await createDraft(pool, ws, await completedJob(ws));
    const r = await render(pool, ws, d.invoice_id);
    assert.equal(r.invoice_number, "13485");
    const other = await completedJob(ws);
    const a = await db.connect();
    const b = await db.connect();
    const bPid = await backendPid(b);
    try {
      await a.query("BEGIN");
      await upsertBilling(a, ws, other, ws.clientId, "013485", false, null); // holds the numbering lock
      const pending = track(issue(b, ws, d.invoice_id, r));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      const out = await pending.result;
      assert.deepEqual([out.outcome, out.invoice_number], ["number_changed", "13486"]);
    } finally {
      await a.end();
      await b.end();
    }
    assert.equal((await invoiceRow(d.invoice_id)).status, "draft", "nothing issued with the linked number");
    assert.equal((await renderAndIssue(pool, ws, d.invoice_id)).invoice_number, "13486");
    await assertStoredPdfAgrees(d.invoice_id);
    assert.equal((await billingRow(other)).invoice_number, "013485", "the QuickBooks number is kept exactly as typed");
    await assertNoNumberSharedAcrossJobs(ws);
  });

  test("linking while issuing, issue first: the link waits, then is refused; Billing and the PDF show the issued number", async () => {
    const ws = await newWorkspace();
    await setStart(pool, ws, 13485);
    const d = await createDraft(pool, ws, await completedJob(ws));
    const r = await render(pool, ws, d.invoice_id);
    const other = await completedJob(ws);
    const a = await db.connect();
    const b = await db.connect();
    const bPid = await backendPid(b);
    try {
      await a.query("BEGIN");
      assert.equal((await issue(a, ws, d.invoice_id, r)).outcome, "issued");
      const pending = track(link(b, ws, other, "13485"));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      const out = await pending.result;
      assert.equal(out.ok, false);
      assert.match((out as any).error, /completed_job_billing_invoice_number_reserved/);
    } finally {
      await a.end();
      await b.end();
    }
    assert.equal(await billingRow(other), null);
    await assertStoredPdfAgrees(d.invoice_id);
    assert.equal((await billingRow((await invoiceRow(d.invoice_id)).appointment_id)).invoice_number, "13485");
  });

  test("40 rounds of linking the proposed number while issuing (leading zeros on odd rounds): never one number on two jobs", async (t) => {
    const ws = await newWorkspace();
    await setStart(pool, ws, 70000);
    let linkWon = 0;
    let issueWon = 0;
    for (let round = 0; round < 40; round++) {
      const proposed = (await state(ws)).next_available as string;
      const typed = round % 2 ? `00${proposed}` : proposed;
      const issueJob = await completedJob(ws);
      const linkJob = await completedJob(ws);
      const d = await createDraft(pool, ws, issueJob);
      // Alternate which side starts a moment later, so both orders happen.
      const [out, l] = await Promise.all([
        (async () => {
          if (round % 2 === 0) await new Promise((res) => setTimeout(res, 3));
          return renderAndIssue(pool, ws, d.invoice_id);
        })(),
        (async () => {
          if (round % 4 === 1) await new Promise((res) => setImmediate(res));
          return link(pool, ws, linkJob, typed);
        })(),
      ]);
      assert.equal(out.outcome, "issued");
      await assertStoredPdfAgrees(d.invoice_id);
      if (l.ok) {
        linkWon++;
        assert.notEqual(out.invoice_number, proposed, "the issue moved past the linked number");
      } else {
        issueWon++;
        assert.equal(out.invoice_number, proposed);
        assert.match(l.error!, /completed_job_billing_invoice_number_reserved/);
      }
    }
    await assertNoNumberSharedAcrossJobs(ws);
    t.diagnostic(`link won ${linkWon}, issue won ${issueWon}`);
    assert.ok(linkWon > 0 && issueWon > 0, `both orders must occur (link ${linkWon}, issue ${issueWon})`);
  });

  test("changing the start while an invoice is issued: either the start applies first, or it is refused as locked -- never half of each", async () => {
    // Setting first: the issue waits and re-renders with the new start.
    {
      const ws = await newWorkspace();
      const d = await createDraft(pool, ws, await completedJob(ws));
      const r = await render(pool, ws, d.invoice_id);
      assert.equal(r.invoice_number, "SFT-1001");
      const a = await db.connect();
      const b = await db.connect();
      const bPid = await backendPid(b);
      try {
        await a.query("BEGIN");
        assert.equal((await setStart(a, ws, 13485)).outcome, "ok");
        const pending = track(issue(b, ws, d.invoice_id, r));
        await waitUntilBlocked(c, bPid);
        await a.query("COMMIT");
        assert.deepEqual([(await pending.result).outcome, (await pending.result).invoice_number], ["number_changed", "13485"]);
      } finally {
        await a.end();
        await b.end();
      }
      assert.equal((await renderAndIssue(pool, ws, d.invoice_id)).invoice_number, "13485");
      await assertStoredPdfAgrees(d.invoice_id);
    }
    // Issue first: the setting waits, then is refused as locked.
    {
      const ws = await newWorkspace();
      const d = await createDraft(pool, ws, await completedJob(ws));
      const r = await render(pool, ws, d.invoice_id);
      const a = await db.connect();
      const b = await db.connect();
      const bPid = await backendPid(b);
      try {
        await a.query("BEGIN");
        assert.equal((await issue(a, ws, d.invoice_id, r)).outcome, "issued");
        const pending = track(setStart(b, ws, 13485));
        await waitUntilBlocked(c, bPid);
        await a.query("COMMIT");
        assert.equal((await pending.result).outcome, "locked");
      } finally {
        await a.end();
        await b.end();
      }
      assert.equal((await invoiceRow(d.invoice_id)).invoice_number, "SFT-1001");
      assert.deepEqual([(await state(ws)).series, (await state(ws)).next_available], ["sft", "SFT-1002"]);
    }
  });

  test("a start set while a higher QuickBooks number is being linked: serialized, so the start is checked against it", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const a = await db.connect();
    const b = await db.connect();
    const bPid = await backendPid(b);
    try {
      await a.query("BEGIN");
      await upsertBilling(a, ws, job, ws.clientId, "13500", false, null);
      const pending = track(setStart(b, ws, 13485));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      assert.equal((await pending.result).outcome, "at_or_below_recorded");
    } finally {
      await a.end();
      await b.end();
    }
    assert.equal((await state(ws)).series, "sft");
  });

  test("existing invoice numbers are never rewritten by setting a start or issuing", async () => {
    const ws = await newWorkspace();
    const jobs = [await linkedJob(ws, "13484"), await linkedJob(ws, "013480"), await linkedJob(ws, "QB-12")];
    const before = (await c.query("SELECT appointment_id, invoice_number, updated_at FROM completed_job_billing WHERE appointment_id = ANY($1) ORDER BY appointment_id", [jobs])).rows;
    await setStart(pool, ws, 13485);
    await issueNew(ws);
    const after = (await c.query("SELECT appointment_id, invoice_number, updated_at FROM completed_job_billing WHERE appointment_id = ANY($1) ORDER BY appointment_id", [jobs])).rows;
    assert.deepEqual(after, before);
  });
});

// ---------------------------------------------------------------------------
// Optional sales tax
// ---------------------------------------------------------------------------

const { TAX_ROUNDING_CASES, AMOUNT_ROUNDING_CASES } = await import("./taxRoundingCases.ts");

describe("Optional sales tax", { skip: SKIP }, () => {
  test("new invoices start with tax off: no rate, tax 0, total = amount", async () => {
    const ws = await newWorkspace();
    const d = await createDraft(pool, ws, await completedJob(ws));
    const inv = await invoiceRow(d.invoice_id);
    assert.deepEqual([inv.tax_rate, inv.tax_cents, inv.amount_cents, inv.total_cents], [null, 0, 15000, 15000]);
  });

  test("the shared rounding cases, through the real draft functions (same table as the app's unit tests)", async () => {
    const ws = await newWorkspace();
    const d = await createDraft(pool, ws, await completedJob(ws));
    let revision = 1;
    for (const c of TAX_ROUNDING_CASES) {
      const u = await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, revision, JSON.stringify(draftFields({ quantity: 1, rate_cents: c.amountCents, tax_rate: c.rate }))]);
      assert.equal(u.outcome, "ok", c.note);
      revision = u.revision;
      const inv = await invoiceRow(d.invoice_id);
      assert.equal(inv.tax_cents, c.taxCents, c.note);
      assert.equal(inv.total_cents, c.amountCents + c.taxCents, c.note);
      assert.equal(Number(inv.tax_rate), Number(c.rate), c.note);
    }
    for (const c of AMOUNT_ROUNDING_CASES) {
      const u = await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, revision, JSON.stringify(draftFields({ quantity: c.quantity, rate_cents: c.rateCents, tax_rate: null }))]);
      revision = u.revision;
      assert.equal((await invoiceRow(d.invoice_id)).amount_cents, c.amountCents, JSON.stringify(c));
    }
  });

  test("a rate must be > 0, < 100, with at most 3 decimals -- refused, never silently rounded; blank means off", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    for (const bad of ["0", "100", "6.8755", "-1", "abc", "6,5", 6.8755]) {
      const r = await createDraft(pool, ws, job, { fields: { tax_rate: bad } });
      assert.deepEqual([r.outcome, r.field], ["invalid_input", "tax_rate"], String(bad));
    }
    const blank = await createDraft(pool, ws, job, { fields: { tax_rate: "" } });
    assert.equal(blank.outcome, "ok");
    assert.equal((await invoiceRow(blank.invoice_id)).tax_rate, null);
  });

  test("the database refuses a tax amount or total that doesn't match the rate", async () => {
    const ws = await newWorkspace();
    const d = await createDraft(pool, ws, await completedJob(ws), { fields: { tax_rate: "6.5" } });
    await assert.rejects(c.query("UPDATE invoices SET tax_cents = tax_cents + 1, total_cents = total_cents + 1 WHERE id = $1", [d.invoice_id]), /invoices_amounts_valid/);
    await assert.rejects(c.query("UPDATE invoices SET total_cents = amount_cents WHERE id = $1", [d.invoice_id]), /invoices_amounts_valid/);
    await assert.rejects(c.query("UPDATE invoices SET tax_rate = 0, tax_cents = 0, total_cents = amount_cents WHERE id = $1", [d.invoice_id]), /invoices_tax_rate_valid/);
  });

  test("changing only the tax rate is a new revision: a PDF rendered before it is refused", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job);
    const r = await render(pool, ws, d.invoice_id);
    const u = await fn(pool, "update_invoice_draft", [ws.workspaceId, d.invoice_id, 1, JSON.stringify(draftFields({ tax_rate: "6.5" }))]);
    assert.equal(u.revision, 2);
    assert.equal((await issue(pool, ws, d.invoice_id, r)).outcome, "stale_revision");
    assert.equal((await renderAndIssue(pool, ws, d.invoice_id)).outcome, "issued");
    const inv = await invoiceRow(d.invoice_id);
    const printed = decodeStoredPdf(inv.pdf);
    assert.deepEqual([Number(printed.tax_rate), printed.tax_cents, printed.subtotal_cents, printed.total_cents, printed.balance_due_cents], [6.5, 975, 15000, 15975, 15975]);
    assert.equal((await billingRow(job)).invoice_number, inv.invoice_number);
    await assertStoredPdfAgrees(d.invoice_id);
  });

  test("tax on but rounding to $0.00 keeps the rate on the issued invoice (so the TAX line shows)", async () => {
    const ws = await newWorkspace();
    const d = await createDraft(pool, ws, await completedJob(ws), { fields: { rate_cents: 5, tax_rate: "6.5" } });
    await renderAndIssue(pool, ws, d.invoice_id);
    const printed = decodeStoredPdf((await invoiceRow(d.invoice_id)).pdf);
    assert.deepEqual([Number(printed.tax_rate), printed.tax_cents, printed.total_cents], [6.5, 0, 5]);
  });

  test("issued tax values are frozen; Void & Reissue keeps the voided invoice's tax and recalculates the new draft's", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const d = await createDraft(pool, ws, job, { fields: { tax_rate: "6.5" } });
    await renderAndIssue(pool, ws, d.invoice_id);
    await assert.rejects(c.query("UPDATE invoices SET tax_rate = 7 WHERE id = $1", [d.invoice_id]), (e: any) => e.code === "IV010");
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, d.invoice_id, "wrong amount"])).outcome, "ok");
    const voided = await invoiceRow(d.invoice_id);
    assert.deepEqual([Number(voided.tax_rate), voided.tax_cents, voided.total_cents, voided.status], [6.5, 975, 15975, "void"]);
    // The reissue carries the rate (the app copies it) with a corrected amount.
    const re = await createDraft(pool, ws, job, { fields: { reissued_from_invoice_id: d.invoice_id, tax_rate: "6.5", rate_cents: 16000 } });
    const draft = await invoiceRow(re.invoice_id);
    assert.deepEqual([Number(draft.tax_rate), draft.tax_cents, draft.total_cents], [6.5, 1040, 17040]);
    await renderAndIssue(pool, ws, re.invoice_id);
    await assertStoredPdfAgrees(re.invoice_id);
    await assertStoredPdfAgrees(d.invoice_id);
  });
});
