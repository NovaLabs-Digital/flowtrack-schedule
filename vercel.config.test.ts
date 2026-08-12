// Phase 5.6C: proves the root vercel.json cron configuration matches what
// app/api/cron/reminders/route.ts actually needs (a 2-hour selection window
// requires hourly execution -- see that route's own comments), that
// reconcile-subscriptions remains deliberately unscheduled, and that no
// secret is ever placed in the cron path (Vercel supplies CRON_SECRET via
// an Authorization header, never the URL -- see lib/cronAuth.ts).
//
// Block 2C-2C: also proves the added replenish-recurring-series schedule --
// daily (matching the audit's conclusion that a once-daily cadence keeps
// every series' rolling buffer safely above REPLENISH_THRESHOLD_DAYS
// between runs), at a deliberately off-the-hour, off-peak UTC time distinct
// from reminders' own hourly :00 cadence.
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

  test("schedules exactly two crons: /api/cron/reminders and /api/cron/replenish-recurring-series", () => {
    const paths = config.crons.map((c) => c.path);
    assert.deepEqual(paths, ["/api/cron/reminders", "/api/cron/replenish-recurring-series"]);
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

  test("reminders schedule is exactly unchanged by adding the replenishment cron", () => {
    const remindersCron = config.crons.find((c) => c.path === "/api/cron/reminders");
    assert.equal(remindersCron!.schedule, "0 * * * *");
  });

  test("replenish-recurring-series runs once daily, at a non-:00, off-peak UTC time distinct from reminders' own cadence", () => {
    const replenishCron = config.crons.find((c) => c.path === "/api/cron/replenish-recurring-series");
    assert.ok(replenishCron);
    const [minute, hour, dom, month, dow] = replenishCron!.schedule.split(" ");
    assert.equal(dom, "*");
    assert.equal(month, "*");
    assert.equal(dow, "*");
    assert.notEqual(minute, "0", "should not land on the exact top of the hour, distinct from reminders' :00 cadence");
    assert.ok(Number(hour) >= 0 && Number(hour) <= 23);
    assert.ok(Number(minute) >= 0 && Number(minute) <= 59);
  });

  test("the cron path carries no secret query parameter", () => {
    for (const cron of config.crons) {
      assert.ok(!cron.path.includes("secret"));
      assert.ok(!cron.path.includes("?"));
    }
  });
});
