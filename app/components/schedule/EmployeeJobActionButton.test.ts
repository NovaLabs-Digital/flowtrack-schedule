// Phase 5.5E-D: real rendered-component behavior tests for
// EmployeeJobActionButton.ts, using the jsdom + @testing-library/react +
// @testing-library/user-event foundation committed in Phase 5.5D-P, the
// same pattern already established by OwnerBillingBanner.test.ts
// (Phase 5.5D). This is the ONE control this phase governs; the button is
// a pure, dependency-free component (no fetch, no session, no
// entitlementServer import), so no mock.module() is needed at all -- every
// scenario is driven purely by the props under test. No real
// Supabase/Stripe/Twilio/Resend/network call is reachable from any test.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

// Must be imported before react-dom/@testing-library/react so document/
// window/etc. exist on globalThis by the time those modules evaluate.
import "../../../lib/testDom.ts";

import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { default: EmployeeJobActionButton } = await import("./EmployeeJobActionButton.ts");

afterEach(() => {
  cleanup();
});

const NEUTRAL_MESSAGE = "This action is temporarily unavailable. Please contact the office.";

function renderButton(props: {
  action: "start" | "complete";
  loading?: boolean;
  canUseJobTracking: boolean;
  onActivate?: () => void;
}) {
  const calls: number[] = [];
  const onActivate = props.onActivate ?? (() => calls.push(Date.now()));
  render(
    React.createElement(EmployeeJobActionButton, {
      action: props.action,
      loading: props.loading ?? false,
      canUseJobTracking: props.canUseJobTracking,
      onActivate,
    })
  );
  return { calls };
}

describe("allowed (canUseJobTracking: true) -- existing behavior preserved exactly", () => {
  test("Start Job renders enabled with its existing label", () => {
    renderButton({ action: "start", canUseJobTracking: true });
    const button = screen.getByRole("button", { name: "Start Job" });
    assert.equal(button.hasAttribute("disabled"), false);
  });

  test("Complete Job renders enabled with its existing label", () => {
    renderButton({ action: "complete", canUseJobTracking: true });
    const button = screen.getByRole("button", { name: "Complete Job" });
    assert.equal(button.hasAttribute("disabled"), false);
  });

  test("clicking an enabled Start Job button calls onActivate exactly once", async () => {
    let calls = 0;
    render(
      React.createElement(EmployeeJobActionButton, {
        action: "start",
        loading: false,
        canUseJobTracking: true,
        onActivate: () => { calls++; },
      })
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start Job" }));
    assert.equal(calls, 1);
  });

  test("keyboard activation (Tab + Enter) calls onActivate exactly once", async () => {
    let calls = 0;
    render(
      React.createElement(EmployeeJobActionButton, {
        action: "complete",
        loading: false,
        canUseJobTracking: true,
        onActivate: () => { calls++; },
      })
    );
    const user = userEvent.setup();
    await user.tab();
    assert.equal(screen.getByRole("button", { name: "Complete Job" }), document.activeElement);
    await user.keyboard("{Enter}");
    assert.equal(calls, 1);
  });

  test("keyboard activation via Space also calls onActivate exactly once", async () => {
    let calls = 0;
    render(
      React.createElement(EmployeeJobActionButton, {
        action: "start",
        loading: false,
        canUseJobTracking: true,
        onActivate: () => { calls++; },
      })
    );
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard(" ");
    assert.equal(calls, 1);
  });

  test("loading=true shows the existing 'Starting...'/'Completing...' label and disables the button, matching pre-existing behavior", () => {
    renderButton({ action: "start", canUseJobTracking: true, loading: true });
    const button = screen.getByRole("button", { name: "Starting..." });
    assert.equal(button.hasAttribute("disabled"), true);

    cleanup();
    renderButton({ action: "complete", canUseJobTracking: true, loading: true });
    const button2 = screen.getByRole("button", { name: "Completing..." });
    assert.equal(button2.hasAttribute("disabled"), true);
  });

  test("clicking while loading (duplicate-submit protection) does not call onActivate", async () => {
    let calls = 0;
    render(
      React.createElement(EmployeeJobActionButton, {
        action: "start",
        loading: true,
        canUseJobTracking: true,
        onActivate: () => { calls++; },
      })
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Starting..." }));
    assert.equal(calls, 0);
  });

  test("no neutral-unavailable notice is rendered when allowed", () => {
    renderButton({ action: "start", canUseJobTracking: true });
    assert.equal(screen.queryByText(NEUTRAL_MESSAGE), null);
  });
});

describe("restricted (canUseJobTracking: false) -- no mutation can be initiated", () => {
  test("Start Job renders disabled", () => {
    renderButton({ action: "start", canUseJobTracking: false });
    const button = screen.getByRole("button", { name: "Start Job" });
    assert.equal(button.hasAttribute("disabled"), true);
    assert.equal(button.getAttribute("aria-disabled"), "true");
  });

  test("Complete Job renders disabled", () => {
    renderButton({ action: "complete", canUseJobTracking: false });
    const button = screen.getByRole("button", { name: "Complete Job" });
    assert.equal(button.hasAttribute("disabled"), true);
  });

  test("mouse click does not call onActivate", async () => {
    const { calls } = renderButton({ action: "start", canUseJobTracking: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start Job" }));
    assert.equal(calls.length, 0);
  });

  test("keyboard activation (Tab + Enter) does not call onActivate", async () => {
    const { calls } = renderButton({ action: "complete", canUseJobTracking: false });
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");
    assert.equal(calls.length, 0);
  });

  test("keyboard activation via Space does not call onActivate", async () => {
    const { calls } = renderButton({ action: "start", canUseJobTracking: false });
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard(" ");
    assert.equal(calls.length, 0);
  });

  test("repeated clicking never calls onActivate", async () => {
    const { calls } = renderButton({ action: "start", canUseJobTracking: false });
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Start Job" });
    await user.click(button);
    await user.click(button);
    await user.click(button);
    assert.equal(calls.length, 0);
  });

  test("neutral wording is visible and accessibly associated with the restricted button via aria-describedby", () => {
    renderButton({ action: "start", canUseJobTracking: false });
    const button = screen.getByRole("button", { name: "Start Job" });
    const describedBy = button.getAttribute("aria-describedby");
    assert.ok(describedBy, "button must be aria-described by the notice");
    const notice = document.getElementById(describedBy!);
    assert.ok(notice, "the referenced notice element must exist");
    assert.equal(notice!.textContent, NEUTRAL_MESSAGE);
    assert.equal(screen.getByText(NEUTRAL_MESSAGE), notice);
  });

  test("no billing, subscription, Stripe, entitlement-reason, grace-date, or workspace detail appears anywhere in the rendered output", () => {
    renderButton({ action: "start", canUseJobTracking: false });
    const text = document.body.textContent ?? "";
    for (const forbidden of [
      "subscription", "Subscription", "billing", "Billing", "Stripe", "stripe",
      "plan", "Plan", "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "unpaid", "malformed", "checkout", "portal",
    ]) {
      assert.ok(!text.includes(forbidden), `rendered output must not contain "${forbidden}"`);
    }
  });

  test("the button remains present (not hidden/removed) so the employee can see the control and its explanation", () => {
    renderButton({ action: "complete", canUseJobTracking: false });
    assert.ok(screen.getByRole("button", { name: "Complete Job" }));
  });
});

describe("projection integrity", () => {
  test("behavior is driven only by the canUseJobTracking prop -- no internal fetch, session, or entitlement lookup exists", async () => {
    const fs = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = fs.readFileSync(fileURLToPath(new URL("./EmployeeJobActionButton.ts", import.meta.url)), "utf8");
    for (const forbidden of ["fetch(", "supabaseAdmin", "getSession", "fetchEntitlementForWorkspace", "workspace_id", "workspaceId"]) {
      assert.ok(!source.includes(forbidden), `EmployeeJobActionButton.ts must not reference "${forbidden}"`);
    }
  });

  test("a canUseJobTracking value of true behaves identically regardless of caller (e.g. demo/tester or a genuinely active real workspace) -- the component has no special-case logic for either", () => {
    // The component takes a plain boolean with no reason/state field at
    // all (by EmployeeEntitlementView's own design, lib/entitlementView.ts)
    // -- there is structurally no way for it to distinguish *why*
    // canUseJobTracking is true, which is exactly the point: demo/tester
    // workspaces (always FULL capabilities, per lib/entitlement.ts) and a
    // genuinely active real workspace produce identical, unrestricted
    // rendering here. Demo/tester's own projection plumbing is proven in
    // lib/entitlementView.test.ts and app/api/appointments/job/
    // route.test.ts; this test only confirms this component adds no
    // separate special-casing of its own.
    renderButton({ action: "start", canUseJobTracking: true });
    assert.equal(screen.getByRole("button", { name: "Start Job" }).hasAttribute("disabled"), false);
  });

  test("a verification-error or any other restricted reason collapses to the same restricted UX -- the component cannot distinguish reasons because it never receives one", () => {
    // EmployeeEntitlementView (lib/entitlementView.ts) intentionally carries
    // only canUseJobTracking, never state/reason -- query_error, malformed,
    // past_due_expired, canceled, etc. are already proven (in
    // lib/entitlement.test.ts / lib/entitlementView.test.ts) to all
    // resolve canUseJobTracking to false. This component's restricted
    // rendering is identical no matter which of those produced the false
    // value it was handed.
    renderButton({ action: "complete", canUseJobTracking: false });
    assert.equal(screen.getByRole("button", { name: "Complete Job" }).hasAttribute("disabled"), true);
  });
});
