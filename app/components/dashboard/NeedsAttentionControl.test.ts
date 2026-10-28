// RENDERED verification of NeedsAttentionControl -- renders the REAL
// component with REAL React into jsdom and drives it with real
// mouse/keyboard interaction. Only the network is faked: a scripted
// `fetch` stands in for GET /api/dashboard/needs-attention. Same pattern
// as app/components/dashboard/BillingPanel.test.ts.
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: NeedsAttentionControl } = await import("./NeedsAttentionControl.tsx");

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

const ENTRY_REVIEW = {
  appointmentId: "appt-review", clientName: "Petra Lindqvist", serviceType: "Window Washing", serviceDate: "2026-08-12",
  scheduledFor: "2026-08-12T13:00:00.000Z", issues: [{ kind: "worked_time_review", label: "Worked time needs review" }],
};
const ENTRY_BILLING = {
  appointmentId: "appt-billing", clientName: "Simon Aldercott", serviceType: "Lawn Mowing", serviceDate: "2026-08-13",
  scheduledFor: "2026-08-13T13:00:00.000Z", issues: [{ kind: "needs_invoicing", label: "Needs invoice number" }],
};
const ENTRY_PAYMENT_OUTSTANDING = {
  appointmentId: "appt-payment", clientName: "Holly Adebayo", serviceType: "Gutter Cleaning", serviceDate: "2026-08-15",
  scheduledFor: "2026-08-15T13:00:00.000Z", issues: [{ kind: "payment_outstanding", label: "Payment outstanding" }],
};
const ENTRY_MULTI = {
  appointmentId: "appt-multi", clientName: "Wren Castellan", serviceType: "Deep Clean", serviceDate: "2026-08-14",
  scheduledFor: "2026-08-14T13:00:00.000Z",
  issues: [
    { kind: "worked_time_review", label: "Worked time needs review" },
    { kind: "failed_message", label: "1 failed message" },
  ],
};

function renderControl(overrides: Partial<Parameters<typeof NeedsAttentionControl>[0]> = {}) {
  const onNavigateToAppointment = overrides.onNavigateToAppointment ?? (() => {});
  const onNavigateToBilling = overrides.onNavigateToBilling ?? (() => {});
  return render(
    React.createElement(NeedsAttentionControl, {
      onNavigateToAppointment,
      onNavigateToBilling,
      ...overrides,
    })
  );
}

describe("NeedsAttentionControl -- collapsed button", () => {
  test("shows a plain \"Needs attention\" label (no count) when there are zero items, and fetches on mount", async () => {
    responses = [json(200, { entries: [], totalCount: 0, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await waitFor(() => assert.equal(calls.length, 1));
    assert.match(calls[0].url, /\/api\/dashboard\/needs-attention\?/);
    await screen.findByRole("button", { name: "Needs attention" });
  });

  test("shows \"Needs attention · N\" once actionable items exist", async () => {
    responses = [json(200, { entries: [ENTRY_REVIEW, ENTRY_BILLING], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await screen.findByRole("button", { name: "Needs attention · 2" });
  });

  test("the dropdown is not rendered until the button is clicked -- collapsed by default", async () => {
    responses = [json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await screen.findByRole("button", { name: "Needs attention · 1" });
    assert.equal(screen.queryByText("Petra Lindqvist"), null);
    assert.equal(document.querySelector('[role="group"][aria-label="Needs attention"]'), null);
  });
});

describe("NeedsAttentionControl -- opening and closing", () => {
  test("clicking the button opens the dropdown, sets aria-expanded, and refetches", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    assert.equal(button.getAttribute("aria-expanded"), "false");
    const u = userEvent.setup();
    await u.click(button);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    await screen.findByText("Petra Lindqvist");
    await waitFor(() => assert.equal(calls.length, 2), undefined); // refetched on open
  });

  test("empty state inside the dropdown reads \"No items need attention\" and the control stays compact (no count badge)", async () => {
    responses = [
      json(200, { entries: [], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention" });
    const u = userEvent.setup();
    await u.click(button);
    await screen.findByText("No items need attention.");
  });

  // Regression: unresolved work/billing no longer has a rolling cutoff --
  // the scope explanation must say so explicitly, and must not read as if
  // the WHOLE list (including worked-time-review/invoicing/payment) is
  // still limited to the disclosed range, which now describes ONLY the
  // failed-message check.
  test("the dropdown explains that worked-time/invoicing/payment cover all history, and discloses the failed-message window formatted MM/DD/YY -- never the raw API \"YYYY-MM-DD\" string", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    await screen.findByText(/full history/i);
    await screen.findByText(/Failed-message checks cover 06\/22\/26 to 08\/20\/26/);
    assert.equal(screen.queryByText(/Showing issues from/), null, "the old wording implying the whole list shares one bounded range must be gone");
  });

  test("each entry's own service date is formatted MM/DD/YY too -- consistent with the date range above it", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    // ENTRY_REVIEW.serviceDate is "2026-08-12"
    await screen.findByText("Window Washing · 08/12/26");
    assert.equal(screen.queryByText(/2026-08-12/), null, "the raw ISO string must never be shown to the owner");
  });

  test("clicking the button again (toggling) closes the dropdown", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await screen.findByText("Petra Lindqvist");
    await u.click(button);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(screen.queryByText("Petra Lindqvist"), null);
  });

  test("Escape closes the dropdown and returns focus to the trigger button", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await screen.findByText("Petra Lindqvist");
    await u.keyboard("{Escape}");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(screen.queryByText("Petra Lindqvist"), null);
    assert.equal(document.activeElement, button, "focus must return to the trigger button");
  });

  test("clicking outside the control closes the dropdown", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
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
      assert.equal(screen.queryByText("Petra Lindqvist"), null);
    } finally {
      outside.remove();
    }
  });

  test("clicking INSIDE the dropdown (e.g. its own background, not an item) does not close it", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    const heading = await screen.findByText("Petra Lindqvist");
    await u.click(heading);
    assert.equal(button.getAttribute("aria-expanded"), "true", "clicking non-actionable content inside stays open");
  });
});

describe("NeedsAttentionControl -- overlay does not affect layout", () => {
  test("the dropdown is absolutely positioned, anchored under the button, never part of normal document flow", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    const dropdown = document.querySelector('[role="group"][aria-label="Needs attention"]') as HTMLElement;
    assert.ok(dropdown);
    assert.ok(dropdown.className.includes("absolute"));
    assert.ok(dropdown.className.includes("top-full"));
    assert.ok(dropdown.className.includes("left-0") && dropdown.className.includes("right-0"), "spans the full width of its resizable ancestor, tracking sidebar width automatically");
  });

  test("the dropdown has a bounded max-height with its own independent scroll, so it stays inside the viewport", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    const dropdown = document.querySelector('[role="group"][aria-label="Needs attention"]') as HTMLElement;
    assert.ok(dropdown.className.includes("max-h-"));
    assert.ok(dropdown.className.includes("overflow-y-auto"));
  });
});

describe("NeedsAttentionControl -- navigation", () => {
  test("clicking a worked-time-review issue calls onNavigateToAppointment with the right appointmentId AND issue kind \"worked_time_review\", and closes the dropdown", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    let navigated: { id: string; issueKind: string } | null = null;
    renderControl({ onNavigateToAppointment: (id: string, issueKind: string) => { navigated = { id, issueKind }; } });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await u.click(await screen.findByRole("button", { name: "Worked time needs review" }));
    assert.deepEqual(navigated, { id: "appt-review", issueKind: "worked_time_review" });
    assert.equal(button.getAttribute("aria-expanded"), "false", "selecting an item closes the dropdown");
  });

  // Regression: this must land on the appointment's own Message History
  // card specifically, not just "select the appointment" -- the issue kind
  // is how DashboardShell/AppointmentDetailPanel know which section to
  // scroll into view.
  test("clicking a failed-message issue calls onNavigateToAppointment with issue kind \"failed_message\" -- distinct from worked-time-review", async () => {
    responses = [
      json(200, { entries: [ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    let navigated: { id: string; issueKind: string } | null = null;
    renderControl({ onNavigateToAppointment: (id: string, issueKind: string) => { navigated = { id, issueKind }; } });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await u.click(await screen.findByRole("button", { name: "1 failed message" }));
    assert.deepEqual(navigated, { id: "appt-multi", issueKind: "failed_message" });
  });

  test("clicking a needs-invoicing issue calls onNavigateToBilling with the appointmentId AND serviceDate", async () => {
    responses = [
      json(200, { entries: [ENTRY_BILLING], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_BILLING], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    let navigated: { id: string; date: string } | null = null;
    renderControl({ onNavigateToBilling: (id: string, date: string) => { navigated = { id, date }; } });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await u.click(await screen.findByRole("button", { name: "Needs invoice number" }));
    assert.deepEqual(navigated, { id: "appt-billing", date: "2026-08-13" });
  });

  // Regression: "Payment outstanding" is a DISTINCT issue kind from
  // "Needs invoice number" (lib/needsAttention.ts never generates both for
  // the same job), but both must open and highlight the same Billing row
  // via the identical onNavigateToBilling destination.
  test("clicking a payment-outstanding issue ALSO calls onNavigateToBilling with the appointmentId AND serviceDate, same destination as needs-invoicing", async () => {
    responses = [
      json(200, { entries: [ENTRY_PAYMENT_OUTSTANDING], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_PAYMENT_OUTSTANDING], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    let navigated: { id: string; date: string } | null = null;
    let appointmentNavigated = false;
    renderControl({
      onNavigateToBilling: (id: string, date: string) => { navigated = { id, date }; },
      onNavigateToAppointment: () => { appointmentNavigated = true; },
    });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    await u.click(await screen.findByRole("button", { name: "Payment outstanding" }));
    assert.deepEqual(navigated, { id: "appt-payment", date: "2026-08-15" });
    assert.equal(appointmentNavigated, false, "a billing issue must never also call onNavigateToAppointment");
  });

  test("an appointment with multiple issues renders one clearly labelled, independently clickable action per issue", async () => {
    responses = [
      json(200, { entries: [ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_MULTI], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    const navigatedAppointments: string[] = [];
    renderControl({ onNavigateToAppointment: (id: string) => { navigatedAppointments.push(id); } });
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    const u = userEvent.setup();
    await u.click(button);
    assert.ok(await screen.findByRole("button", { name: "Worked time needs review" }));
    assert.ok(screen.getByRole("button", { name: "1 failed message" }));
  });
});

describe("NeedsAttentionControl -- refresh", () => {
  test("refreshToken changing triggers a refetch without the control being reopened", async () => {
    responses = [
      json(200, { entries: [], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    const { rerender } = renderControl({ refreshToken: 0 });
    await screen.findByRole("button", { name: "Needs attention" });
    rerender(React.createElement(NeedsAttentionControl, { onNavigateToAppointment: () => {}, onNavigateToBilling: () => {}, refreshToken: 1 }));
    await screen.findByRole("button", { name: "Needs attention · 1" });
    assert.equal(calls.length, 2);
  });
});

describe("NeedsAttentionControl -- bounded pagination / totalCount independent of the loaded page", () => {
  test("the collapsed button shows the server's totalCount, even when only a partial first page has loaded", async () => {
    responses = [json(200, { entries: [ENTRY_REVIEW], totalCount: 47, hasMore: true, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" })];
    renderControl();
    await screen.findByRole("button", { name: "Needs attention · 47" });
  });

  test("a \"Load more\" control appears when hasMore is true, and fetches the next page with an increasing offset", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], totalCount: 2, hasMore: true, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }), // mount
      json(200, { entries: [ENTRY_REVIEW], totalCount: 2, hasMore: true, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }), // refetch on open
      json(200, { entries: [ENTRY_BILLING], totalCount: 2, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }), // load more
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 2" });
    await userEvent.setup().click(button);
    await screen.findByText("Petra Lindqvist");
    const loadMore = await screen.findByRole("button", { name: /Load more/ });
    await userEvent.setup().click(loadMore);
    await screen.findByText("Simon Aldercott");
    assert.ok(calls[2].url.includes("offset=1"), `expected the second page's offset to be 1, got: ${calls[2]?.url}`);
    assert.equal(screen.queryByRole("button", { name: /Load more/ }), null, "hasMore is now false");
  });

  test("no \"Load more\" control is rendered when hasMore is false", async () => {
    responses = [
      json(200, { entries: [ENTRY_REVIEW], totalCount: 1, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
      json(200, { entries: [ENTRY_REVIEW], totalCount: 1, hasMore: false, rangeStart: "2026-06-22", rangeEnd: "2026-08-20" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention · 1" });
    await userEvent.setup().click(button);
    await screen.findByText("Petra Lindqvist");
    assert.equal(screen.queryByRole("button", { name: /Load more/ }), null);
  });
});

describe("NeedsAttentionControl -- error state", () => {
  test("a load error is shown inline inside the dropdown, never thrown", async () => {
    responses = [
      json(500, { error: "Server error" }),
      json(500, { error: "Server error" }),
    ];
    renderControl();
    const button = await screen.findByRole("button", { name: "Needs attention" });
    await userEvent.setup().click(button);
    await screen.findByText("Server error");
  });
});
