// Phase 5.5E-E1A: real rendered-component behavior tests for
// CapabilityGatedButton.ts, using the jsdom + @testing-library/react +
// @testing-library/user-event foundation committed in Phase 5.5D-P, the
// same pattern already established by OwnerBillingBanner.test.ts
// (Phase 5.5D) and EmployeeJobActionButton.test.ts (Phase 5.5E-D). This is
// the ONE thing in this phase that needs real mouse/keyboard interaction
// proof; the primitive is dependency-free (no fetch, no session, no
// entitlementServer import), so no mock.module() is needed -- every
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

const { default: CapabilityGatedButton } = await import("./CapabilityGatedButton.ts");

afterEach(() => {
  cleanup();
});

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

function renderButton(props: {
  type?: "button" | "submit";
  allowed: boolean;
  disabled?: boolean;
  onClick?: () => void;
  ariaDescribedBy?: string;
  label?: string;
}) {
  const calls: number[] = [];
  const onClick = props.onClick ?? (() => calls.push(Date.now()));
  const { container } = render(
    React.createElement(CapabilityGatedButton, {
      type: props.type ?? "button",
      allowed: props.allowed,
      disabled: props.disabled ?? false,
      onClick,
      ariaDescribedBy: props.ariaDescribedBy,
      className: "some-existing-class",
    }, props.label ?? "Save")
  );
  return { calls, container };
}

describe("allowed -- existing behavior preserved exactly", () => {
  test("renders enabled with the given label and className", () => {
    renderButton({ allowed: true, label: "Save Changes" });
    const button = screen.getByRole("button", { name: "Save Changes" });
    assert.equal(button.hasAttribute("disabled"), false);
    assert.equal(button.className, "some-existing-class");
  });

  test("preserves the given type attribute (submit)", () => {
    renderButton({ allowed: true, type: "submit" });
    const button = screen.getByRole("button", { name: "Save" });
    assert.equal(button.getAttribute("type"), "submit");
  });

  test("mouse click invokes onClick exactly once", async () => {
    let calls = 0;
    render(
      React.createElement(CapabilityGatedButton, {
        allowed: true,
        onClick: () => { calls++; },
        className: "c",
      }, "Go")
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Go" }));
    assert.equal(calls, 1);
  });

  test("keyboard activation (Tab + Enter) invokes onClick exactly once", async () => {
    let calls = 0;
    render(
      React.createElement(CapabilityGatedButton, {
        allowed: true,
        onClick: () => { calls++; },
        className: "c",
      }, "Go")
    );
    const user = userEvent.setup();
    await user.tab();
    assert.equal(screen.getByRole("button", { name: "Go" }), document.activeElement);
    await user.keyboard("{Enter}");
    assert.equal(calls, 1);
  });

  test("keyboard activation via Space invokes onClick exactly once", async () => {
    let calls = 0;
    render(
      React.createElement(CapabilityGatedButton, {
        allowed: true,
        onClick: () => { calls++; },
        className: "c",
      }, "Go")
    );
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard(" ");
    assert.equal(calls, 1);
  });

  test("existing loading-disabled behavior (the `disabled` prop) is preserved when allowed", async () => {
    const { calls } = renderButton({ allowed: true, disabled: true, label: "Saving..." });
    const button = screen.getByRole("button", { name: "Saving..." });
    assert.equal(button.hasAttribute("disabled"), true);
    const user = userEvent.setup();
    await user.click(button);
    assert.equal(calls.length, 0);
  });

  test("no aria-describedby is set when allowed, even if a describedBy id is supplied", () => {
    renderButton({ allowed: true, ariaDescribedBy: "some-notice" });
    const button = screen.getByRole("button", { name: "Save" });
    assert.equal(button.getAttribute("aria-describedby"), null);
  });
});

describe("restricted -- no click can initiate a request", () => {
  test("renders disabled and aria-disabled", () => {
    renderButton({ allowed: false });
    const button = screen.getByRole("button", { name: "Save" });
    assert.equal(button.hasAttribute("disabled"), true);
    assert.equal(button.getAttribute("aria-disabled"), "true");
  });

  test("mouse click invokes onClick zero times", async () => {
    const { calls } = renderButton({ allowed: false });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    assert.equal(calls.length, 0);
  });

  test("keyboard activation (Tab + Enter) invokes onClick zero times", async () => {
    const { calls } = renderButton({ allowed: false });
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard("{Enter}");
    assert.equal(calls.length, 0);
  });

  test("keyboard activation via Space invokes onClick zero times", async () => {
    const { calls } = renderButton({ allowed: false });
    const user = userEvent.setup();
    await user.tab();
    await user.keyboard(" ");
    assert.equal(calls.length, 0);
  });

  test("repeated interaction (multiple clicks) invokes onClick zero times", async () => {
    const { calls } = renderButton({ allowed: false });
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Save" });
    await user.click(button);
    await user.click(button);
    await user.click(button);
    assert.equal(calls.length, 0);
  });

  test("aria-describedby is set to the caller-supplied notice id", () => {
    renderButton({ allowed: false, ariaDescribedBy: "shared-restricted-notice" });
    const button = screen.getByRole("button", { name: "Save" });
    assert.equal(button.getAttribute("aria-describedby"), "shared-restricted-notice");
  });

  test("aria-describedby is omitted (not just empty) when the caller supplies no notice id", () => {
    renderButton({ allowed: false });
    const button = screen.getByRole("button", { name: "Save" });
    assert.equal(button.hasAttribute("aria-describedby"), false);
  });

  test("the button itself renders no notice text -- it is the caller's responsibility, proven by exactly one element (the button) inside this render's own container", () => {
    const { container } = renderButton({ allowed: false });
    // Exactly one element inside THIS render's container (excluding
    // @testing-library/react's own container wrapper, which is not part of
    // what CapabilityGatedButton renders): the button. Confirms this
    // component never self-renders a notice/wrapper that could break an
    // existing flex/stack layout at the call site.
    assert.equal(container.querySelectorAll("*").length, 1);
    assert.equal(container.firstElementChild?.tagName, "BUTTON");
  });

  test("the approved wording, when rendered by the caller and linked via aria-describedby, is visible and accessibly associated -- proving the intended integration contract", () => {
    // This simulates exactly how AppointmentModal.tsx uses this primitive:
    // one shared notice element elsewhere in the DOM, referenced by id.
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(CapabilityGatedButton, {
          allowed: false,
          onClick: () => {},
          className: "c",
          ariaDescribedBy: "notice-1",
        }, "Save"),
        React.createElement("div", { id: "notice-1" }, APPROVED_WORDING)
      )
    );
    const button = screen.getByRole("button", { name: "Save" });
    const describedBy = button.getAttribute("aria-describedby");
    assert.equal(describedBy, "notice-1");
    const notice = document.getElementById(describedBy!);
    assert.equal(notice?.textContent, APPROVED_WORDING);
    assert.equal(screen.getByText(APPROVED_WORDING), notice);
  });

  test("no billing, subscription, Stripe, entitlement-reason, grace-date, or workspace detail appears anywhere in the rendered output", () => {
    renderButton({ allowed: false, ariaDescribedBy: "n" });
    const text = document.body.textContent ?? "";
    for (const forbidden of [
      "subscription", "Subscription", "billing", "Billing", "Stripe", "stripe",
      "plan", "Plan", "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "unpaid", "malformed", "checkout", "portal",
    ]) {
      assert.ok(!text.includes(forbidden), `rendered output must not contain "${forbidden}"`);
    }
  });

  test("the button remains present (not hidden/removed) so the owner can see the control and its explanation", () => {
    renderButton({ allowed: false, label: "Create Appointment" });
    assert.ok(screen.getByRole("button", { name: "Create Appointment" }));
  });
});

describe("projection integrity", () => {
  test("behavior is driven only by the allowed/disabled props -- no internal fetch, session, or entitlement lookup exists", async () => {
    const fs = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = fs.readFileSync(fileURLToPath(new URL("./CapabilityGatedButton.ts", import.meta.url)), "utf8");
    for (const forbidden of ["fetch(", "supabaseAdmin", "getSession", "fetchEntitlementForWorkspace", "workspace_id", "workspaceId"]) {
      assert.ok(!source.includes(forbidden), `CapabilityGatedButton.ts must not reference "${forbidden}"`);
    }
  });

  test("a verification-error or any other restricted reason collapses to the same restricted rendering -- the component cannot distinguish reasons because it never receives one", () => {
    // Mirrors EntitlementView's own design: canMutateOperationalData is a
    // plain boolean with no accompanying state/reason field, so this
    // component structurally cannot distinguish *why* it's false --
    // query_error, malformed, past_due_expired, canceled, etc. all already
    // resolve to the same boolean (proven in lib/entitlement.test.ts /
    // lib/entitlementView.test.ts); this test only confirms the component
    // adds no separate special-casing of its own.
    renderButton({ allowed: false });
    assert.equal(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"), true);
  });
});
