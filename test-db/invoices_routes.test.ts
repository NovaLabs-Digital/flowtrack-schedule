// Step 2 of SFT invoices: the REAL routes (invoices, Billing, direct
// payment, Needs Attention) against a REAL PostgreSQL built from the
// exported production schema + migrations 029-049. Only @/lib/supabaseAdmin
// (-> test-db/postgrestAdapter.ts), the session and the capability gate are
// stand-ins. The PDF is the real pdf-lib renderer.
//
// "Something happens while the PDF is rendering" is simulated at the one
// place it matters: right before the route's issue_invoice call (after it
// read the render input and rendered), through the supabaseAdmin stand-in.
//
//   TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db:invoices
/* eslint-disable @typescript-eslint/no-explicit-any -- test-only: rows and
   JSON bodies are inspected dynamically. */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PDFDocument } from "pdf-lib";
import { NextResponse } from "next/server";
import { startTestDb, makeWorkspace, makeAppointment, type TestDb, type Fixture } from "./harness.ts";
import { createPostgrestAdapter, POSTGREST_TYPES } from "./postgrestAdapter.ts";
import { computeBillingSummary, applyBillingStatusFilter, type CompletedJobRow } from "../lib/completedJobBilling.ts";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = process.env.TEST_DB_SCHEMA_FILE ? path.resolve(ROOT, process.env.TEST_DB_SCHEMA_FILE) : "";
const SKIP = !schemaFile || !existsSync(schemaFile) ? "TEST_DB_SCHEMA_FILE (production schema export) not provided" : false;

let currentClient: any = null;
let beforeIssue: (() => Promise<void>) | null = null; // runs once, right before the next issue_invoice
const issueCalls: string[] = []; // proposed numbers the route sent to issue_invoice
mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (t: string) => currentClient.from(t),
      rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === "issue_invoice") {
          issueCalls.push(String(args?.p_invoice_number));
          if (beforeIssue) {
            const hook = beforeIssue;
            beforeIssue = null;
            await hook();
          }
        }
        return currentClient.rpc(fn, args);
      },
    },
  },
});
let session: any = { role: "none" };
const { fakeSessionNamedExports } = await import("../lib/testSupport.ts");
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => session) });
let capabilityAllowed = true;
mock.module("@/lib/entitlementServer", {
  namedExports: {
    requireCapability: async () =>
      capabilityAllowed ? { allowed: true } : { allowed: false, response: NextResponse.json({ error: "restricted" }, { status: 403 }) },
  },
});

const invoicesRoute = await import("../app/api/invoices/route.ts");
const invoiceRoute = await import("../app/api/invoices/[id]/route.ts");
const issueRoute = await import("../app/api/invoices/[id]/issue/route.ts");
const voidRoute = await import("../app/api/invoices/[id]/void/route.ts");
const pdfRoute = await import("../app/api/invoices/[id]/pdf/route.ts");
const billingRoute = await import("../app/api/billing/completed-jobs/route.ts");
const billingUpdateRoute = await import("../app/api/billing/completed-jobs/update/route.ts");
const directPaymentRoute = await import("../app/api/billing/completed-jobs/direct-payment/route.ts");
const needsAttentionRoute = await import("../app/api/dashboard/needs-attention/route.ts");
const deployedBillingRoute = await import("./deployed/billing-update-route.a593d9c.ts");

let db: TestDb;
let pool: pg.Pool;
let adapterPool: pg.Pool;
let c: pg.Client;

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
      "049_invoices.sql",
    ],
  });
  c = await db.connect();
  await c.query("SET TIME ZONE 'UTC'");
  pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 10 });
  adapterPool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 10, types: POSTGREST_TYPES as any });
  adapterPool.on("connect", (client) => client.query("SET TIME ZONE 'UTC'"));
  currentClient = createPostgrestAdapter(adapterPool).client;
});
after(async () => {
  if (SKIP) return;
  await pool.end();
  await adapterPool.end();
  await c.end();
  await db.stop();
});

// ---------------------------------------------------------------------------
// Fixtures and calls
// ---------------------------------------------------------------------------

type Ws = Fixture & { otherClientId: string };
async function newWorkspace(opts: { companyName?: string | null } = {}): Promise<Ws> {
  const fx = await makeWorkspace(c, { employees: 1 });
  await c.query(
    "UPDATE company_settings SET company_name = $2, address = '1 Main St', city = 'Springfield', state = 'IL', zip = '62701', phone = '555-0100' WHERE workspace_id = $1",
    [fx.workspaceId, opts.companyName === undefined ? "ACS Cleaning" : opts.companyName]
  );
  await c.query("UPDATE clients SET address = '2 Oak Ave', email = 'client@example.test' WHERE id = $1", [fx.clientId]);
  const otherClientId = randomUUID();
  await c.query("INSERT INTO clients (id, workspace_id, name) VALUES ($1, $2, 'Other client')", [otherClientId, fx.workspaceId]);
  return { ...fx, otherClientId };
}

let hourOffset = 0;
async function completedJob(ws: Ws, opts: { priceCents?: number | null; tracked?: boolean; demo?: boolean } = {}): Promise<string> {
  hourOffset += 1;
  const start = new Date(Date.UTC(2026, 9, 1, 14) + hourOffset * 3600_000); // October 2026
  const id = await makeAppointment(c, ws, { scheduledFor: start, employees: [ws.employeeIds[0]], priceCents: opts.priceCents === undefined ? 15000 : opts.priceCents });
  if (opts.tracked !== false) {
    await c.query("UPDATE appointment_employees SET actual_started_at = $2, actual_completed_at = $3 WHERE appointment_id = $1",
      [id, start, new Date(start.getTime() + 90 * 60_000)]);
  }
  if (opts.demo) await c.query("UPDATE appointments SET is_demo = true WHERE id = $1", [id]);
  return id;
}

function asOwner(ws: Ws) {
  session = { role: "owner", workspaceId: ws.workspaceId, authUserId: "owner-" + ws.workspaceId, sessionEpoch: 1 };
}
async function send(handler: (...a: any[]) => Promise<Response>, method: string, url: string, body?: unknown, id?: string) {
  const req = new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = id ? await handler(req, { params: Promise.resolve({ id }) }) : await handler(req);
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: type.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer()) } as any;
}

const createInvoice = (ws: Ws, appointmentId: string, extra: Record<string, unknown> = {}) =>
  (asOwner(ws), send(invoicesRoute.POST, "POST", "/api/invoices", { appointment_id: appointmentId, request_id: randomUUID(), ...extra }));
const getInvoice = (ws: Ws, id: string) => (asOwner(ws), send(invoiceRoute.GET, "GET", `/api/invoices/${id}`, undefined, id));
const editDraft = (ws: Ws, id: string, revision: number, fields: Record<string, unknown>) =>
  (asOwner(ws), send(invoiceRoute.PATCH, "PATCH", `/api/invoices/${id}`, { revision, fields }, id));
const issueInvoice = (ws: Ws, id: string, revision: number) => (asOwner(ws), send(issueRoute.POST, "POST", `/api/invoices/${id}/issue`, { revision }, id));
const voidInvoice = (ws: Ws, id: string, reason: string) => (asOwner(ws), send(voidRoute.POST, "POST", `/api/invoices/${id}/void`, { reason }, id));
const downloadPdf = (ws: Ws, id: string) => (asOwner(ws), send(pdfRoute.GET, "GET", `/api/invoices/${id}/pdf`, undefined, id));
const saveBilling = (ws: Ws, body: Record<string, unknown>) => (asOwner(ws), send(billingUpdateRoute.PATCH, "PATCH", "/api/billing/completed-jobs/update", body));
const directPayment = (ws: Ws, body: Record<string, unknown>) => (asOwner(ws), send(directPaymentRoute.POST, "POST", "/api/billing/completed-jobs/direct-payment", body));
async function billingReport(ws: Ws): Promise<CompletedJobRow[]> {
  asOwner(ws);
  const r = await send(billingRoute.GET, "GET", "/api/billing/completed-jobs?start=2026-09-01&end=2026-11-30");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.completed;
}
async function needsAttentionKinds(ws: Ws, appointmentId: string): Promise<string[]> {
  asOwner(ws);
  const r = await send(needsAttentionRoute.GET, "GET", "/api/dashboard/needs-attention?limit=100");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.entries.find((e: any) => e.appointmentId === appointmentId)?.issues ?? []).map((i: any) => i.kind);
}

// Full draft fields from an invoice view, with overrides (what the editor sends).
function fieldsFrom(inv: any, o: Record<string, unknown> = {}) {
  const keys = ["business_name", "business_address", "business_phone", "business_email", "bill_to_name", "bill_to_address", "bill_to_email",
    "terms", "invoice_date", "due_date", "service_date", "product_service", "description", "quantity", "rate_cents", "tax_rate", "payment_instructions", "note_to_client"];
  return { ...Object.fromEntries(keys.map((k) => [k, inv[k]])), ...o };
}

async function storedInvoice(id: string) {
  return (await c.query("SELECT * FROM invoices WHERE id = $1", [id])).rows[0];
}
// The stored PDF is the real document for the issued invoice.
async function assertStoredPdfMatches(id: string) {
  const inv = await storedInvoice(id);
  assert.equal(createHash("sha256").update(inv.pdf).digest("hex"), inv.pdf_sha256);
  const doc = await PDFDocument.load(inv.pdf, { updateMetadata: false });
  assert.equal(doc.getTitle(), `Invoice ${inv.invoice_number}`, "the PDF was rendered with the issued number");
  assert.equal(inv.render_snapshot.invoice_number, inv.invoice_number);
  assert.equal(inv.render_snapshot.revision, inv.revision);
}

// ---------------------------------------------------------------------------
// Create, edit, issue
// ---------------------------------------------------------------------------

describe("Create Invoice -> draft -> issue", { skip: SKIP }, () => {
  test("creates a prefilled draft; a double-click (same request id) returns the same draft", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws, { priceCents: 15000 });
    asOwner(ws);
    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      send(invoicesRoute.POST, "POST", "/api/invoices", { appointment_id: job, request_id: requestId }),
      send(invoicesRoute.POST, "POST", "/api/invoices", { appointment_id: job, request_id: requestId }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.invoice.id, b.body.invoice.id);
    const inv = a.body.invoice;
    assert.equal(inv.status, "draft");
    assert.equal(inv.invoice_number, null, "no number until issued");
    assert.equal(inv.business_name, "ACS Cleaning");
    assert.equal(inv.business_address, "1 Main St\nSpringfield, IL 62701");
    assert.equal(inv.bill_to_name, "Izabel");
    assert.equal(inv.bill_to_address, "2 Oak Ave");
    assert.deepEqual([inv.quantity, inv.rate_cents, inv.amount_cents, inv.job_price_cents], [1, 15000, 15000, 15000]);
    assert.equal(inv.note_to_client, "Thank you for your business.");
    assert.equal(inv.pdf, undefined, "PDF bytes are never sent with the invoice");
  });

  test("refused for a job that is not completed, a job with no business name set up, or another workspace's job", async () => {
    const ws = await newWorkspace();
    const untracked = await completedJob(ws, { tracked: false });
    const r1 = await createInvoice(ws, untracked);
    assert.deepEqual([r1.status, r1.body.code], [409, "JOB_NOT_COMPLETED"]);

    const noName = await newWorkspace({ companyName: null });
    const r2 = await createInvoice(noName, await completedJob(noName));
    assert.deepEqual([r2.status, r2.body.code], [409, "BUSINESS_NAME_MISSING"]);

    const other = await newWorkspace();
    const r3 = await createInvoice(other, await completedJob(ws));
    assert.equal(r3.status, 404);
  });

  test("an owner worked-time correction makes the job billable, same as Billing", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws, { tracked: false });
    await c.query("INSERT INTO appointment_employee_hours (appointment_id, employee_id, hours_worked, note, workspace_id) VALUES ($1, $2, 2, 'forgot to clock in', $3)",
      [job, ws.employeeIds[0], ws.workspaceId]);
    assert.equal((await createInvoice(ws, job)).status, 201);
  });

  test("edits bump the revision; a stale edit returns the current draft for review", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const inv = (await createInvoice(ws, job)).body.invoice;
    const r1 = await editDraft(ws, inv.id, 1, fieldsFrom(inv, { rate_cents: 16000, description: "Deep clean" }));
    assert.equal(r1.status, 200);
    assert.deepEqual([r1.body.invoice.revision, r1.body.invoice.amount_cents], [2, 16000]);
    const stale = await editDraft(ws, inv.id, 1, fieldsFrom(inv, { rate_cents: 1 }));
    assert.deepEqual([stale.status, stale.body.code, stale.body.invoice.revision, stale.body.invoice.rate_cents], [409, "DRAFT_CHANGED", 2, 16000]);
    const bad = await editDraft(ws, inv.id, 2, fieldsFrom(inv, { due_date: "2026-01-01" }));
    assert.equal(bad.status, 400);
  });

  test("issues SFT-1001: number, stored PDF and Billing together; downloading returns the stored bytes", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const inv = (await createInvoice(ws, job)).body.invoice;
    const r = await issueInvoice(ws, inv.id, 1);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.invoice.status, r.body.invoice.invoice_number], ["issued", "SFT-1001"]);
    await assertStoredPdfMatches(inv.id);

    const row = (await billingReport(ws)).find((x) => x.appointmentId === job)!;
    assert.equal(row.billing?.invoice_number, "SFT-1001");
    assert.deepEqual(row.invoice, { id: inv.id, status: "issued", invoice_number: "SFT-1001", total_cents: 15000, revision: 1 });

    const pdf = await downloadPdf(ws, inv.id);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(pdf.headers.get("content-disposition"), 'attachment; filename="SFT-1001.pdf"');
    assert.ok(Buffer.from(pdf.body).equals((await storedInvoice(inv.id)).pdf), "byte for byte the stored PDF");

    const again = await issueInvoice(ws, inv.id, 1);
    assert.deepEqual([again.status, again.body.alreadyIssued, again.body.invoice.invoice_number], [200, true, "SFT-1001"]);
    const edit = await editDraft(ws, inv.id, 1, fieldsFrom(inv));
    assert.deepEqual([edit.status, edit.body.code], [409, "NOT_DRAFT"]);
  });

  test("the number changes while the PDF renders: the route re-renders with the new number and issues it", async () => {
    const ws = await newWorkspace();
    const mine = (await createInvoice(ws, await completedJob(ws))).body.invoice;
    const theirs = (await createInvoice(ws, await completedJob(ws))).body.invoice;
    issueCalls.length = 0;
    // While "mine" is rendering with SFT-1001, another invoice is issued first.
    beforeIssue = async () => {
      const r = await issueInvoice(ws, theirs.id, 1);
      assert.equal(r.body.invoice.invoice_number, "SFT-1001");
    };
    const r = await issueInvoice(ws, mine.id, 1);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.invoice.invoice_number, "SFT-1002");
    assert.deepEqual(issueCalls, ["SFT-1001", "SFT-1001", "SFT-1002"], "mine tried 1001, theirs took it, mine retried with 1002");
    await assertStoredPdfMatches(mine.id);
    await assertStoredPdfMatches(theirs.id);
  });

  test("the draft changes while the PDF renders: nothing is issued and the updated draft comes back for review", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const inv = (await createInvoice(ws, job)).body.invoice;
    beforeIssue = async () => {
      const r = await editDraft(ws, inv.id, 1, fieldsFrom(inv, { rate_cents: 17500 }));
      assert.equal(r.status, 200);
    };
    const r = await issueInvoice(ws, inv.id, 1);
    assert.deepEqual([r.status, r.body.code], [409, "DRAFT_CHANGED"]);
    assert.deepEqual([r.body.invoice.status, r.body.invoice.revision, r.body.invoice.rate_cents, r.body.invoice.invoice_number], ["draft", 2, 17500, null]);
    assert.equal((await c.query("SELECT next_number FROM invoice_counters WHERE workspace_id = $1", [ws.workspaceId])).rows[0]?.next_number ?? 1001, 1001, "no number used");
    assert.equal((await billingReport(ws)).find((x) => x.appointmentId === job)!.billing, null);

    // The owner reviews revision 2 and issues it.
    const ok = await issueInvoice(ws, inv.id, 2);
    assert.deepEqual([ok.status, ok.body.invoice.invoice_number, ok.body.invoice.total_cents], [201, "SFT-1001", 17500]);
    await assertStoredPdfMatches(inv.id);
  });

  test("issuing a draft the owner has not seen (older revision) is refused before rendering", async () => {
    const ws = await newWorkspace();
    const inv = (await createInvoice(ws, await completedJob(ws))).body.invoice;
    await editDraft(ws, inv.id, 1, fieldsFrom(inv, { description: "changed in another tab" }));
    issueCalls.length = 0;
    const r = await issueInvoice(ws, inv.id, 1);
    assert.deepEqual([r.status, r.body.code, r.body.invoice.description], [409, "DRAFT_CHANGED", "changed in another tab"]);
    assert.deepEqual(issueCalls, [], "issue_invoice was never called");
  });
});

// ---------------------------------------------------------------------------
// Billing totals, filters, the protected number
// ---------------------------------------------------------------------------

describe("Billing with SFT invoices", { skip: SKIP }, () => {
  test("an issued invoice's total drives Invoiced $ and Unpaid $; the job price drives Completed Work $; a draft never counts", async () => {
    const ws = await newWorkspace();
    const sftJob = await completedJob(ws, { priceCents: 15000 });
    const draftJob = await completedJob(ws, { priceCents: 10000 });
    const qbJob = await completedJob(ws, { priceCents: 8000 });

    const inv = (await createInvoice(ws, sftJob)).body.invoice;
    await editDraft(ws, inv.id, 1, fieldsFrom(inv, { quantity: 2, rate_cents: 8000 })); // $160 vs job price $150
    assert.equal((await issueInvoice(ws, inv.id, 2)).status, 201);
    const draft = (await createInvoice(ws, draftJob)).body.invoice;
    await editDraft(ws, draft.id, 1, fieldsFrom(draft, { rate_cents: 99900 })); // a big draft must not count
    assert.equal((await saveBilling(ws, { appointment_id: qbJob, invoice_number: "13484" })).status, 200);

    let rows = await billingReport(ws);
    assert.deepEqual(computeBillingSummary(rows), {
      completedJobs: 3, completedWorkCents: 15000 + 10000 + 8000, invoicedCents: 16000 + 8000, unpaidCents: 16000 + 8000,
    });
    assert.deepEqual(applyBillingStatusFilter(rows, "missing_invoice").map((r) => r.appointmentId), [draftJob]);
    assert.deepEqual(applyBillingStatusFilter(rows, "invoiced_unpaid").map((r) => r.appointmentId).sort(), [sftJob, qbJob].sort());

    // Mark the SFT invoice paid (Venmo) through Billing: number kept, Unpaid $ drops by the invoice total.
    const paid = await saveBilling(ws, { appointment_id: sftJob, paid: true, payment_method: "venmo" });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.billing.invoice_number, "SFT-1001");
    rows = await billingReport(ws);
    assert.deepEqual(computeBillingSummary(rows), { completedJobs: 3, completedWorkCents: 33000, invoicedCents: 24000, unpaidCents: 8000 });
    assert.deepEqual(applyBillingStatusFilter(rows, "paid").map((r) => r.appointmentId), [sftJob]);

    // And unpaid again.
    assert.equal((await saveBilling(ws, { appointment_id: sftJob, paid: false })).status, 200);
    assert.equal(computeBillingSummary(await billingReport(ws)).unpaidCents, 24000);
  });

  test("the issued number is protected in Billing; Paid / Payment Method stay editable; SFT numbers can't be typed; a draft blocks linking", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const inv = (await createInvoice(ws, job)).body.invoice;

    const linkWhileDraft = await saveBilling(ws, { appointment_id: job, invoice_number: "13484" });
    assert.deepEqual([linkWhileDraft.status, linkWhileDraft.body.code], [409, "INVOICE_DRAFT_EXISTS"]);
    assert.match(linkWhileDraft.body.error, /Discard the draft/);
    await issueInvoice(ws, inv.id, 1);

    for (const typed of ["13484", ""]) {
      const r = await saveBilling(ws, { appointment_id: job, invoice_number: typed });
      assert.deepEqual([r.status, r.body.code], [409, "INVOICE_NUMBER_LOCKED"], typed);
      assert.match(r.body.error, /void it and reissue/);
    }
    assert.equal((await saveBilling(ws, { appointment_id: job, paid: true, payment_method: "zelle" })).status, 200);
    assert.equal((await saveBilling(ws, { appointment_id: job, payment_method: "check" })).status, 200);
    assert.equal((await saveBilling(ws, { appointment_id: job, paid: false })).status, 200);
    const row = (await billingReport(ws)).find((r) => r.appointmentId === job)!;
    assert.deepEqual([row.billing?.invoice_number, row.billing?.paid, row.billing?.payment_method], ["SFT-1001", false, "check"]);

    const other = await completedJob(ws);
    const typedSft = await saveBilling(ws, { appointment_id: other, invoice_number: "sft-1002" });
    assert.deepEqual([typedSft.status, typedSft.body.code], [409, "INVOICE_NUMBER_RESERVED"]);
  });

  test("Void & Reissue: paid can't be voided; unpaid voids and clears Billing; the reissue copies the details and gets the next number", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const inv = (await createInvoice(ws, job)).body.invoice;
    await editDraft(ws, inv.id, 1, fieldsFrom(inv, { rate_cents: 16000, payment_instructions: "Zelle to 555-0100" }));
    await issueInvoice(ws, inv.id, 2);

    await saveBilling(ws, { appointment_id: job, paid: true, payment_method: "zelle" });
    const refused = await voidInvoice(ws, inv.id, "wrong rate");
    assert.deepEqual([refused.status, refused.body.code], [409, "INVOICE_PAID"]);
    await saveBilling(ws, { appointment_id: job, paid: false });
    assert.equal((await voidInvoice(ws, inv.id, "")).status, 400);
    const voided = await voidInvoice(ws, inv.id, "wrong rate");
    assert.deepEqual([voided.status, voided.body.invoice.status, voided.body.invoice.invoice_number], [200, "void", "SFT-1001"]);
    const afterVoid = (await billingReport(ws)).find((r) => r.appointmentId === job)!;
    assert.deepEqual([afterVoid.billing?.invoice_number, afterVoid.invoice], [null, null]);
    assert.equal((await downloadPdf(ws, inv.id)).status, 200, "the voided PDF is kept");

    const re = await createInvoice(ws, job, { reissue_from_invoice_id: inv.id });
    assert.equal(re.status, 201);
    assert.deepEqual([re.body.invoice.rate_cents, re.body.invoice.payment_instructions, re.body.invoice.reissued_from_invoice_id], [16000, "Zelle to 555-0100", inv.id]);
    const issued = await issueInvoice(ws, re.body.invoice.id, 1);
    assert.equal(issued.body.invoice.invoice_number, "SFT-1002", "the voided number is never reused");

    // The next new invoice in the workspace reuses the last payment instructions.
    const next = await createInvoice(ws, await completedJob(ws));
    assert.equal(next.body.invoice.payment_instructions, "Zelle to 555-0100");
  });
});

describe("Billing with sales tax", { skip: SKIP }, () => {
  test("a taxed invoice: Invoiced $ / Unpaid $ and the PDF use the tax-inclusive total; Completed Work $ keeps the job price", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws, { priceCents: 15000 });
    const inv = (await createInvoice(ws, job)).body.invoice;
    assert.deepEqual([inv.tax_rate, inv.tax_cents], [null, 0], "starts with tax off");
    const edited = await editDraft(ws, inv.id, 1, fieldsFrom(inv, { tax_rate: "6.5" }));
    assert.deepEqual([edited.body.invoice.tax_rate, edited.body.invoice.tax_cents, edited.body.invoice.total_cents], ["6.5", 975, 15975]);
    const issued = await issueInvoice(ws, inv.id, 2);
    assert.equal(issued.status, 201);

    const rows = await billingReport(ws);
    const row = rows.find((r) => r.appointmentId === job)!;
    assert.equal(row.invoice?.total_cents, 15975);
    assert.deepEqual(computeBillingSummary(rows), { completedJobs: 1, completedWorkCents: 15000, invoicedCents: 15975, unpaidCents: 15975 });

    const stored = await storedInvoice(inv.id);
    assert.deepEqual([Number(stored.render_snapshot.tax_rate), stored.render_snapshot.tax_cents, stored.render_snapshot.total_cents], [6.5, 975, 15975]);
    await assertStoredPdfMatches(inv.id);
  });

  test("Void & Reissue copies the tax rate into the new draft; changing the amount recalculates the tax", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws, { priceCents: 15000 });
    const inv = (await createInvoice(ws, job)).body.invoice;
    await editDraft(ws, inv.id, 1, fieldsFrom(inv, { tax_rate: "6.875" }));
    await issueInvoice(ws, inv.id, 2);
    assert.equal((await voidInvoice(ws, inv.id, "wrong amount")).status, 200);
    const re = (await createInvoice(ws, job, { reissue_from_invoice_id: inv.id })).body.invoice;
    assert.deepEqual([re.tax_rate, re.tax_cents, re.total_cents], ["6.875", 1031, 16031], "copied rate, same amount");
    const changed = await editDraft(ws, re.id, re.revision, fieldsFrom(re, { rate_cents: 12345 }));
    assert.deepEqual([changed.body.invoice.tax_rate, changed.body.invoice.tax_cents, changed.body.invoice.total_cents], ["6.875", 849, 13194]);
    const off = await editDraft(ws, re.id, changed.body.invoice.revision, fieldsFrom(changed.body.invoice, { tax_rate: null }));
    assert.deepEqual([off.body.invoice.tax_rate, off.body.invoice.tax_cents, off.body.invoice.total_cents], [null, 0, 12345], "the owner can turn tax off");
    const voided = (await getInvoice(ws, inv.id)).body.invoice;
    assert.deepEqual([voided.status, voided.tax_rate, voided.tax_cents, voided.total_cents], ["void", "6.875", 1031, 16031], "the voided record keeps its tax");
  });
});

// ---------------------------------------------------------------------------
// Paid directly, no invoice -- and Needs Attention
// ---------------------------------------------------------------------------

describe("Paid directly, no invoice", { skip: SKIP }, () => {
  test("confirming clears the job's Needs Attention billing issue; undoing restores Needs invoice number", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    assert.deepEqual(await needsAttentionKinds(ws, job), ["needs_invoicing"]);

    // Choosing Venmo alone does not close the job.
    assert.equal((await saveBilling(ws, { appointment_id: job, paid: true, payment_method: "venmo" })).status, 200);
    assert.deepEqual(await needsAttentionKinds(ws, job), ["needs_invoicing"]);

    const confirmed = await directPayment(ws, { appointment_id: job, no_invoice_required: true, payment_method: "venmo" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual([confirmed.body.billing.no_invoice_required, confirmed.body.billing.paid, confirmed.body.billing.payment_method], [true, true, "venmo"]);
    assert.deepEqual(await needsAttentionKinds(ws, job), []);
    assert.deepEqual(applyBillingStatusFilter(await billingReport(ws), "missing_invoice").map((r) => r.appointmentId), []);

    const undone = await directPayment(ws, { appointment_id: job, no_invoice_required: false });
    assert.equal(undone.status, 200);
    assert.deepEqual([undone.body.billing.no_invoice_required, undone.body.billing.paid], [false, true]);
    assert.deepEqual(await needsAttentionKinds(ws, job), ["needs_invoicing"]);
  });

  test("works in one step from nothing, with any supported method", async () => {
    const ws = await newWorkspace();
    for (const method of ["cash", "venmo", "zelle", "check", "quickbooks_card", "other"]) {
      const job = await completedJob(ws);
      const r = await directPayment(ws, { appointment_id: job, no_invoice_required: true, payment_method: method });
      assert.equal(r.status, 200, method);
      assert.deepEqual(await needsAttentionKinds(ws, job), [], method);
    }
  });

  test("refused without a method, for a job not completed, or when the job has an SFT invoice or a QuickBooks number", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    assert.equal((await directPayment(ws, { appointment_id: job, no_invoice_required: true })).status, 400);
    const untracked = await completedJob(ws, { tracked: false });
    assert.deepEqual((await directPayment(ws, { appointment_id: untracked, no_invoice_required: true, payment_method: "cash" })).body.code, "JOB_NOT_COMPLETED");
    const withDraft = await completedJob(ws);
    await createInvoice(ws, withDraft);
    assert.deepEqual((await directPayment(ws, { appointment_id: withDraft, no_invoice_required: true, payment_method: "cash" })).body.code, "JOB_HAS_INVOICE");
    const linked = await completedJob(ws);
    await saveBilling(ws, { appointment_id: linked, invoice_number: "13500" });
    assert.deepEqual((await directPayment(ws, { appointment_id: linked, no_invoice_required: true, payment_method: "cash" })).body.code, "JOB_HAS_INVOICE_NUMBER");
    // And a job paid directly can't get an invoice until that is undone.
    await directPayment(ws, { appointment_id: job, no_invoice_required: true, payment_method: "cash" });
    assert.deepEqual((await createInvoice(ws, job)).body.code, "JOB_PAID_DIRECTLY");
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("Access", { skip: SKIP }, () => {
  test("employees and testers are refused (owner-only, like Billing); a restricted workspace is refused", async () => {
    const ws = await newWorkspace();
    const job = await completedJob(ws);
    const inv = (await createInvoice(ws, job)).body.invoice;

    session = { role: "employee", workspaceId: ws.workspaceId, employeeId: ws.employeeIds[0] };
    for (const r of [
      await send(invoicesRoute.POST, "POST", "/api/invoices", { appointment_id: job, request_id: randomUUID() }),
      await send(invoiceRoute.GET, "GET", `/api/invoices/${inv.id}`, undefined, inv.id),
      await send(pdfRoute.GET, "GET", `/api/invoices/${inv.id}/pdf`, undefined, inv.id),
      await send(directPaymentRoute.POST, "POST", "/api/billing/completed-jobs/direct-payment", { appointment_id: job, no_invoice_required: true, payment_method: "cash" }),
    ]) assert.equal(r.status, 403);

    capabilityAllowed = false;
    try {
      assert.equal((await issueInvoice(ws, inv.id, 1)).status, 403);
      assert.equal((await getInvoice(ws, inv.id)).status, 403);
    } finally {
      capabilityAllowed = true;
    }

    session = { role: "tester", workspaceId: ws.workspaceId };
    const demoJob = await completedJob(ws, { demo: true });
    assert.equal((await send(invoiceRoute.GET, "GET", `/api/invoices/${inv.id}`, undefined, inv.id)).status, 403);
    assert.equal((await send(invoicesRoute.POST, "POST", "/api/invoices", { appointment_id: demoJob, request_id: randomUUID() })).status, 403);
  });
});

// ---------------------------------------------------------------------------
// Rollout: cash jobs marked paid between applying 049 and deploying the app
// ---------------------------------------------------------------------------

describe("Rollout window check (test-db/049-window-cash-check.sql)", { skip: SKIP }, () => {
  test("counts exactly the cash jobs the OLD app marked paid after 049, without names; the new app's choices are not counted", async () => {
    const run = async () => Object.fromEntries((await c.query(readFileSync(path.join(ROOT, "test-db", "049-window-cash-check.sql"), "utf8"))).rows.map((r: any) => [r.check_name, r]));
    const ws = await newWorkspace();
    const before1 = await run();

    // The deployed (old) app marks two cash jobs paid with no number...
    const deployedSave = async (body: Record<string, unknown>) => {
      asOwner(ws);
      const res = await deployedBillingRoute.PATCH(new Request("http://localhost/api/billing/completed-jobs/update", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      return res.status;
    };
    const w1 = await completedJob(ws);
    const w2 = await completedJob(ws);
    assert.equal(await deployedSave({ appointment_id: w1, paid: true, payment_method: "cash" }), 200);
    assert.equal(await deployedSave({ appointment_id: w2, paid: true, payment_method: "cash" }), 200);
    // ...while a job confirmed through the new flow is not a window job.
    const confirmed = await completedJob(ws);
    await directPayment(ws, { appointment_id: confirmed, no_invoice_required: true, payment_method: "cash" });

    const after1 = await run();
    const countOf = (r: any) => Number(String(r.cash_paid_in_window.detail).split(" ")[0]);
    assert.equal(countOf(after1) - countOf(before1), 2);
    assert.equal(after1.cash_paid_in_window.ok, false);
    assert.match(after1.cash_paid_in_window.detail, /will show Needs invoice number after the deploy/);
    assert.ok(!JSON.stringify(after1).includes("Izabel"), "no names");

    // After the deploy the owner closes them with "No invoice needed".
    for (const j of [w1, w2]) await directPayment(ws, { appointment_id: j, no_invoice_required: true, payment_method: "cash" });
    assert.equal(countOf(await run()), countOf(before1));
  });
});
