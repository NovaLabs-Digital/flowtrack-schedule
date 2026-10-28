// RENDERED verification of MobileNeedsAttentionControl -- renders the REAL
// component with REAL React into jsdom and drives it with real
// mouse/keyboard interaction. Only the network is faked: a scripted
// `fetch` stands in for GET /api/dashboard/needs-attention. Same pattern
// as app/components/dashboard/NeedsAttentionControl.test.ts.
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: MobileNeedsAttentionControl } = await import("./MobileNeedsAttentionControl.tsx");

type Call = { url: string };
let calls: Call[] = [];
let responses: Array<() => Promise<Response> | Response> = [];
const originalFetch = globalThis.fetch;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted fetch to ${String(input)}`);
    return next();
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const ENTRY_SINGLE = {
  appointmentId: "appt-review", clientName: "Petra Lindqvist", serviceType: "Window Washing", serviceDate: "2026-08-12",
  scheduledFor: "2026-08-12T13:00:00.000Z", issues: [{ kind: "worked_time_review", label: "Worked time needs review" }],
};
const ENTRY_MULTI = {
  appointmentId: "appt-multi", clientName: "Wren Castellan", serviceType: "Deep Clean", serviceDate: "2026-08-14",
  scheduledFor: "2026-08-14T13:00:00.000Z",
  issues: [
    { kind: "needs_invoicing", label: "Needs invoice number" },
    { kind: "failed_message", label: "1 failed message" },
  ],
};

function renderControl(onSelectAppointment: (id: string) => void = () => {}) {
  return render(React.createElement(MobileNeedsAttentionControl, { onSelectAppointment }));
}

describe("MobileNeedsAttentionControl -- collapsed button", () => {
  test("shows a plain \"Needs attention\" label when there are zero items, and fetches on mount, requesting the mobile surface", async () => {
    responses = [json(200, { entries: [], totalCount: 0, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await waitFor(() => assert.equal(calls.length, 1));
    assert.match(calls[0].url, /\/api\/dashboard\/needs-attention\?/);
    assert.ok(calls[0].url.includes("surface=mobile"), "the mobile control must request surface=mobile so the server never generates a needs_invoicing issue");
    await screen.findByRole("button", { name: "Needs attention" });
  });

  test("shows \"Needs attention · N\" once actionable items exist, collapsed (no list) until tapped", async () => {
    responses = [json(200, { entries: [ENTRY_SINGLE, ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await screen.findByRole("button", { name: "Needs attention · 2" });
    assert.equal(screen.queryByText("Petra Lindqvist"), null);
  });
});

describe("MobileNeedsAttentionControl -- open/close", () => {
  test("tapping opens the list, sets aria-expanded, refetches, and shows the date range", async () => {
    responses = [
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    assert.equal(button.getAttribute("aria-expanded"), "false");
    const u = userEvent.setup();
    await u.click(button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    await screen.findByText("Petra Lindqvist");
    await screen.findByText(/Showing issues from 2026-06-22 to 2026-08-20/);
    await waitFor(() => assert.equal(calls.length, 2));
  });

  test("empty state reads \"No items need attention\"", async () => {
    responses = [
      json(200, { entries: [], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention" });
    await userEvent.setup().click(button);
    await screen.findByText("No items need attention.");
  });

  test("Escape closes the list and returns focus to the trigger button", async () => {
    responses = [
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await screen.findByText("Petra Lindqvist");
    await u.keyboard("{Escape}");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, button);
  });

  test("tapping outside closes the list", async () => {
    responses = [
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    const outside = document.createElement("div");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    try {
      renderControl();
      const button = await screen.findByRole("button", { name: "Needs attention · 1" });
      const u = userEvent.setup();
      await u.click(button);
      await screen.findByText("Petra Lindqvist");
      await u.click(outside);
      assert.equal(button.getAttribute("aria-expanded"), "false");
    } finally {
      outside.remove();
    }
  });
});

describe("MobileNeedsAttentionControl -- navigation (single action per appointment, regardless of issue count)", () => {
  test("tapping an entry calls onSelectAppointment with its appointmentId and closes the list", async () => {
    responses = [
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_SINGLE], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    let selected: string | null = null;
    renderControl((id) => { selected = id; });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await u.click(await screen.findByText("Petra Lindqvist"));
    assert.equal(selected, "appt-review");
    assert.equal(button.getAttribute("aria-expanded"), "false");
  });

  test("an appointment with multiple issues shows all issue labels, but is still a SINGLE tappable entry (one destination, not several)", async () => {
    responses = [
      json(200, { entries: [ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    let selected: string | null = null;
    renderControl((id) => { selected = id; });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    await screen.findByText("Needs invoice number");
    assert.ok(screen.getByText("1 failed message"));
    // Exactly one tappable row-level button for this appointment, not one
    // per issue label.
    const rowButtons = screen.getAllByRole("button").filter((b) => b.textContent?.includes("Wren Castellan"));
    assert.equal(rowButtons.length, 1);
    await userEvent.setup().click(rowButtons[0]);
    assert.equal(selected, "appt-multi");
  });
});

describe("MobileNeedsAttentionControl -- billing-desktop-only disclosure", () => {
  test("opening the list always shows a note that billing review is desktop-only, since needs-invoicing is never offered here", async () => {
    responses = [
      json(200, { entries: [ENTRY_SINGLE], totalCount: 1, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_SINGLE], totalCount: 1, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    await screen.findByText("Billing review is available on desktop.");
  });
});

describe("MobileNeedsAttentionControl -- bounded pagination / totalCount independent of the loaded page", () => {
  test("the collapsed button shows the server's totalCount even with only a partial first page loaded", async () => {
    responses = [json(200, { entries: [ENTRY_SINGLE], totalCount: 12, hasMore: true, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await screen.findByRole("button", { name: "Needs attention · 12" });
  });

  test("a \"Load more\" control appears when hasMore is true and loads the next page", async () => {
    responses = [
      json(200, { entries: [ENTRY_SINGLE], totalCount: 2, hasMore: true, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_SINGLE], totalCount: 2, hasMore: true, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_MULTI], totalCount: 2, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 2" });
    await userEvent.setup().click(button);
    await screen.findByText("Petra Lindqvist");
    const loadMore = await screen.findByRole("button", { name: /Load more/ });
    await userEvent.setup().click(loadMore);
    await screen.findByText("Wren Castellan");
    assert.equal(screen.queryByRole("button", { name: /Load more/ }), null);
  });
});

describe("MobileNeedsAttentionControl -- error state", () => {
  test("a load error is shown inline, never thrown", async () => {
    responses = [json(500, { error: "Server error" }), json(500, { error: "Server error" })];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention" });
    await userEvent.setup().click(button);
    await screen.findByText("Server error");
  });
});
