// Phase 5.6C: proves the root vercel.json cron configuration matches what
// app/api/cron/reminders/route.ts actually needs (a 2-hour selection window
// requires hourly execution -- see that route's own comments), that
// reconcile-subscriptions remains deliberately unscheduled, and that no
// secret is ever placed in the cron path (Vercel supplies CRON_SECRET via
// an Authorization header, never the URL -- see lib/cronAuth.ts).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const raw = fs.readFileSync(fileURLToPath(new URL("./vercel.json", import.meta.url)), "utf8");

describe("vercel.json -- cron configuration", () => {
  test("is valid JSON", () => {
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  const config = JSON.parse(raw) as { crons: Array<{ path: string; schedule: string }> };

  test("schedules exactly one cron: /api/cron/reminders", () => {
    const paths = config.crons.map((c) => c.path);
    assert.deepEqual(paths, ["/api/cron/reminders"]);
  });

  test("does not schedule /api/cron/reconcile-subscriptions", () => {
    const paths = config.crons.map((c) => c.path);
    assert.ok(!paths.includes("/api/cron/reconcile-subscriptions"));
  });

  test("reminders cadence is hourly, matching the route's 2-hour (23h-25h) selection window", () => {
    const remindersCron = config.crons.find((c) => c.path === "/api/cron/reminders");
    assert.ok(remindersCron);
    assert.equal(remindersCron!.schedule, "0 * * * *");
  });

  test("the cron path carries no secret query parameter", () => {
    for (const cron of config.crons) {
      assert.ok(!cron.path.includes("secret"));
      assert.ok(!cron.path.includes("?"));
    }
  });
});
