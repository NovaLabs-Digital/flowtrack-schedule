// Guided Demo Session reuse of the demo handlers (fetchInterceptor.ts):
// the server-side runner (runDemoRoute), the mutation allowlist, and the
// browser interceptor's session mode. The public /demo behavior itself is
// covered, unchanged, by fetchInterceptor.test.ts.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { generateDemoFixture, DEMO_TIMEZONE, type DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";
import { getSnapshot as browserSnapshot, setSnapshot as setBrowserSnapshot } from "@/lib/demoLocal/store";
import { installDemoFetchInterceptor, isDemoMutationRoute, runDemoRoute } from "@/lib/demoLocal/fetchInterceptor";
import { addDays } from "@/lib/recurrence";

const NOW = new Date();
const createBody = (snap: DemoFixtureBundle, days = 4) => ({
  client_id: snap.clients[0].id,
  service_type: "Window Washing",
  scheduled_for: addDays(NOW, days, DEMO_TIMEZONE).toISOString(),
  duration_minutes: 90,
  employee_ids: [snap.employees[0].id],
  price_cents: 12000,
});

describe("runDemoRoute -- the public demo's handlers, run against one session's dataset", () => {
  test("applies a change to a copy and returns the response and the new dataset; the input and the browser store are untouched", async () => {
    const bundle = generateDemoFixture(NOW);
    setBrowserSnapshot(generateDemoFixture(NOW));
    const browserBefore = JSON.stringify(browserSnapshot());
    const inputBefore = JSON.stringify(bundle);
    const result = await runDemoRoute(bundle, "POST", "/api/appointments/create", createBody(bundle));
    assert.ok(result);
    assert.equal(result!.status, 200);
    const id = (result!.data as { appointmentId: string }).appointmentId;
    assert.ok(result!.bundle.appointments.some((a) => a.id === id));
    assert.equal(result!.bundle.appointments.length, bundle.appointments.length + 1);
    assert.equal(JSON.stringify(bundle), inputBefore, "input dataset not mutated");
    assert.equal(JSON.stringify(browserSnapshot()), browserBefore, "browser store not touched");
  });

  test("the demo's own rules still refuse invalid changes, with nothing changed", async () => {
    const bundle = generateDemoFixture(NOW);
    const result = await runDemoRoute(bundle, "POST", "/api/appointments/create", { client_id: "nope" });
    assert.ok(result!.status >= 400);
    assert.equal(result!.bundle.appointments.length, bundle.appointments.length);
  });

  test("concurrent runs on different datasets never see each other's data", async () => {
    const a = generateDemoFixture(NOW);
    const b = { ...generateDemoFixture(NOW), appointments: [] };
    const [ra, rb] = await Promise.all([
      runDemoRoute(a, "POST", "/api/appointments/create", createBody(a, 3)),
      runDemoRoute(b, "POST", "/api/appointments/create", createBody(b, 5)),
    ]);
    assert.equal(ra!.bundle.appointments.length, a.appointments.length + 1);
    assert.equal(rb!.bundle.appointments.length, 1);
  });

  test("unknown routes return null", async () => {
    assert.equal(await runDemoRoute(generateDemoFixture(NOW), "POST", "/api/not-a-route", {}), null);
  });
});

describe("isDemoMutationRoute -- what a session controller may change", () => {
  test("handled non-GET demo routes only; never reads, logout, or unknown paths", () => {
    assert.equal(isDemoMutationRoute("POST", "/api/appointments/create"), true);
    assert.equal(isDemoMutationRoute("patch", "/api/appointments/update"), true);
    assert.equal(isDemoMutationRoute("DELETE", "/api/services"), true);
    assert.equal(isDemoMutationRoute("GET", "/api/services"), false);
    assert.equal(isDemoMutationRoute("POST", "/api/auth/logout"), false);
    assert.equal(isDemoMutationRoute("POST", "/api/stripe/checkout"), false);
    assert.equal(isDemoMutationRoute("POST", "/api/demo-session/x/op"), false);
  });
});

describe("installDemoFetchInterceptor -- session mode", () => {
  const network = mock.fn(async (_input: unknown, _init?: unknown) => new Response(JSON.stringify({ network: true }), { status: 200 }));
  const sessionData = generateDemoFixture(NOW);
  const forwarded: Array<{ method: string; path: string; body: unknown }> = [];
  (globalThis as any).window = { fetch: network, location: { origin: "http://localhost", pathname: "/demo/session/0b3c2f9e-5b7a-4c1d-9e2f-1a2b3c4d5e6f" } };
  installDemoFetchInterceptor({
    store: { getSnapshot: () => sessionData, setSnapshot: () => { throw new Error("reads never write"); }, notify: () => {} },
    forwardMutation: async (method, url, body) => {
      forwarded.push({ method, path: url.pathname, body });
      return new Response(JSON.stringify({ forwarded: true }), { status: 200 });
    },
  });
  const sessionFetch = (globalThis as any).window.fetch as typeof fetch;

  test("reads are answered locally from the session's dataset", async () => {
    const res = await sessionFetch("/api/services");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(JSON.stringify(data).includes(sessionData.services[0].name), true);
    assert.equal(network.mock.callCount(), 0);
  });

  test("every data change is forwarded to the session server with its parsed body, never applied locally", async () => {
    const res = await sessionFetch("/api/appointments/create", { method: "POST", body: JSON.stringify({ a: 1 }) });
    assert.deepEqual(await res.json(), { forwarded: true });
    assert.deepEqual(forwarded.at(-1), { method: "POST", path: "/api/appointments/create", body: { a: 1 } });
    assert.equal(network.mock.callCount(), 0);
  });

  test("the session API reaches the network; any other /api/ path still fails closed", async () => {
    await sessionFetch("/api/demo-session/0b3c2f9e-5b7a-4c1d-9e2f-1a2b3c4d5e6f/sync", { method: "POST", body: "{}" });
    assert.equal(network.mock.callCount(), 1);
    const blocked = await sessionFetch("/api/stripe/checkout", { method: "POST", body: "{}" });
    assert.equal(blocked.status, 404);
    assert.equal(network.mock.callCount(), 1);
  });
});
