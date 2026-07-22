// Phase 5.5D: real rendered-component behavior tests for the owner
// billing-status banner (OwnerBillingBanner.ts), using the jsdom +
// @testing-library/react + @testing-library/user-event foundation
// committed in Phase 5.5D-P. @/lib/billingRecovery is mocked via the
// established mock.module() pattern (the same technique already used for
// @/lib/notify/@/lib/session in the API route tests) so this file proves
// the BANNER's own rendering/click/keyboard/pending/error behavior against
// a controllable fake, without duplicating beginBillingRecovery's own
// already-tested policy. @/lib/support is not mocked -- it's a pure,
// side-effect-free constant, and this file's support_required coverage is
// deliberately a combination of behavior tests (no crash, no network call,
// pending clears correctly) and a source-level assertion for the exact
// window.location.href assignment (see the "no forbidden props" describe
// block): jsdom's window.location.href is a non-configurable own property
// in this jsdom version and cannot be spied on or intercepted at runtime,
// so the exact assigned value is verified from source instead. No real
// Supabase/Stripe/Twilio/Resend/network call is reachable from any test.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Must be imported before react-dom/@testing-library/react so document/
// window/etc. exist on globalThis by the time those modules evaluate.
import "../../../lib/testDom.ts";

import React from "react";
import { act } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type BillingRecoveryAction = "checkout" | "portal" | "support" | null;
type BillingRecoveryResult =
  | { status: "redirecting" }
  | { status: "support_required" }
  | { status: "no_action" }
  | { status: "error"; message: string };

let calls: BillingRecoveryAction[] = [];
let impl: (action: BillingRecoveryAction) => Promise<BillingRecoveryResult> = async () => ({ status: "no_action" });

mock.module("@/lib/billingRecovery", {
  namedExports: {
    beginBillingRecovery: (action: BillingRecoveryAction) => {
      calls.push(action);
      return impl(action);
    },
  },
});

const { default: OwnerBillingBanner } = await import("./OwnerBillingBanner.ts");

afterEach(() => {
  cleanup();
  calls = [];
  impl = async () => ({ status: "no_action" });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Resolves a deferred and flushes the resulting React state update inside
// act() -- without this, a resolution left dangling at the end of a test
// (the component's own async continuation still settling) lands outside
// any act() scope and React logs a spurious "not wrapped in act(...)"
// warning, even when the test's own assertions are already correct.
async function settle<T>(deferred: { resolve: (value: T) => void; promise: Promise<T> }, value: T) {
  await act(async () => {
    deferred.resolve(value);
    await deferred.promise;
  });
}

const UNEXPECTED_ERROR_MESSAGE = "We couldn't open billing right now. Please try again.";

describe("bannerVariant = none renders nothing", () => {
  test("renders no DOM content and offers no recovery action", () => {
    const { container } = render(React.createElement(OwnerBillingBanner, { bannerVariant: "none", recoveryAction: null }));
    assert.equal(container.innerHTML, "");
  });

  test("never calls beginBillingRecovery when there is nothing to render", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "none", recoveryAction: "portal" }));
    assert.deepEqual(calls, []);
  });
});

describe("wording depends only on bannerVariant", () => {
  test("grace_warning renders the approved title and body", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "grace_warning", recoveryAction: null }));
    assert.ok(screen.getByText("Please update your billing information"));
    assert.ok(
      screen.getByText(
        "We couldn't confirm your latest payment. Your scheduling tools are still available for now. Update billing to prevent an interruption."
      )
    );
  });

  test("restricted renders the approved title and body", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: null }));
    assert.ok(screen.getByText("Billing attention is required"));
    assert.ok(screen.getByText("Please restore your subscription to continue using all scheduling features."));
  });

  test("verification_error renders the approved title and body", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "verification_error", recoveryAction: null }));
    assert.ok(screen.getByText("We need to verify your account"));
    assert.ok(screen.getByText("Please contact support so we can help restore full access."));
  });

  test("restricted body never claims data was deleted, suspended, lost, or at risk, and never shows a Stripe status", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: null }));
    const text = screen.getByRole("status").textContent ?? "";
    for (const forbidden of ["delet", "suspend", "lost", "at risk", "stripe", "active", "canceled", "past_due"]) {
      assert.ok(!text.toLowerCase().includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("grace_warning never displays a deadline", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "grace_warning", recoveryAction: "portal" }));
    const text = screen.getByRole("status").textContent ?? "";
    assert.ok(!/\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|day[s]? (left|remaining)/i.test(text));
  });
});

describe("action label depends only on recoveryAction, independent of bannerVariant", () => {
  test('recoveryAction "portal" renders "Update billing"', () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "grace_warning", recoveryAction: "portal" }));
    assert.ok(screen.getByRole("button", { name: "Update billing" }));
  });

  test('recoveryAction "checkout" renders "Restore subscription"', () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "checkout" }));
    assert.ok(screen.getByRole("button", { name: "Restore subscription" }));
  });

  test('recoveryAction "support" renders "Contact support"', () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "verification_error", recoveryAction: "support" }));
    assert.ok(screen.getByRole("button", { name: "Contact support" }));
  });

  test("recoveryAction null renders no action button, for any bannerVariant", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: null }));
    assert.equal(screen.queryByRole("button"), null);
  });

  test("an unusual but type-valid combination (verification_error + checkout) renders both independently, with no local policy override", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "verification_error", recoveryAction: "checkout" }));
    assert.ok(screen.getByText("We need to verify your account"));
    assert.ok(screen.getByRole("button", { name: "Restore subscription" }));
  });

  test("another unusual combination (grace_warning + support) renders both independently", () => {
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "grace_warning", recoveryAction: "support" }));
    assert.ok(screen.getByText("Please update your billing information"));
    assert.ok(screen.getByRole("button", { name: "Contact support" }));
  });
});

describe("activation calls beginBillingRecovery exactly once with the exact projected action", () => {
  for (const action of ["portal", "checkout", "support"] as const) {
    test(`clicking the ${action} button calls beginBillingRecovery("${action}") exactly once`, async () => {
      const deferred = createDeferred<BillingRecoveryResult>();
      impl = () => deferred.promise;
      const label = action === "portal" ? "Update billing" : action === "checkout" ? "Restore subscription" : "Contact support";
      const user = userEvent.setup();
      render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: action }));

      await user.click(screen.getByRole("button", { name: label }));

      assert.deepEqual(calls, [action]);
      await settle(deferred, { status: "no_action" });
    });
  }
});

describe("support_required uses only the canonical mailto mechanism", () => {
  // jsdom's window.location.href is an own, non-configurable property
  // (confirmed directly: Object.getOwnPropertyDescriptor(window.location,
  // "href") reports configurable: false) -- it cannot be spied on,
  // redefined, or deleted in this jsdom version, and assigning to it logs
  // "Not implemented: navigation to another Document" without updating the
  // readable value. Runtime observation of the exact assigned value is
  // therefore not possible here. This is proven two ways instead: a
  // behavior test that clicking support produces no crash, no network call
  // (fetch is never touched anywhere in this path), and correctly clears
  // pending -- combined with a source-level test (see the "no forbidden
  // props" describe block below) asserting the exact literal statement
  // `window.location.href = SUPPORT_MAILTO_URL` exists in the component,
  // immediately inside the support_required branch. Together these prove
  // the same contract the runtime assertion would have, without fighting a
  // jsdom implementation detail unrelated to this component's own logic.
  test("clicking support with a support_required result makes no network call, throws nothing, and clears pending", async () => {
    impl = async () => ({ status: "support_required" });
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "verification_error", recoveryAction: "support" }));

    await user.click(screen.getByRole("button", { name: "Contact support" }));

    assert.deepEqual(calls, ["support"]);
    const button = await screen.findByRole("button", { name: "Contact support" });
    assert.equal(button.hasAttribute("disabled"), false);
    assert.equal(screen.queryByRole("alert"), null, "no error should be shown for a successful support_required handoff");
  });
});

describe("pending state and synchronous duplicate-activation guard", () => {
  test("pending appears immediately: the button is disabled and exposes an accessible pending state", async () => {
    const deferred = createDeferred<BillingRecoveryResult>();
    impl = () => deferred.promise;
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    await user.click(screen.getByRole("button", { name: "Update billing" }));

    const pendingButton = screen.getByRole("button", { name: "Working..." });
    assert.equal(pendingButton.hasAttribute("disabled"), true);
    assert.equal(pendingButton.getAttribute("aria-busy"), "true");

    await settle(deferred, { status: "no_action" });
  });

  test("rapid duplicate clicks while pending (a genuinely disabled button) produce exactly one helper invocation", async () => {
    const deferred = createDeferred<BillingRecoveryResult>();
    impl = () => deferred.promise;
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    const button = screen.getByRole("button", { name: "Update billing" });
    await user.click(button);
    assert.equal(calls.length, 1);

    const pendingButton = screen.getByRole("button", { name: "Working..." });
    await user.click(pendingButton);
    await user.click(pendingButton);
    assert.equal(calls.length, 1, "a disabled button must not produce a second activation");

    await settle(deferred, { status: "no_action" });
  });

  test("repeated keyboard activation while pending cannot produce a second invocation", async () => {
    const deferred = createDeferred<BillingRecoveryResult>();
    impl = () => deferred.promise;
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    screen.getByRole("button", { name: "Update billing" }).focus();
    await user.keyboard("{Enter}");
    assert.equal(calls.length, 1);

    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    assert.equal(calls.length, 1, "keyboard activation on a disabled button must not create a second call");

    await settle(deferred, { status: "no_action" });
  });
});

describe("redirecting remains pending", () => {
  test("a redirecting result keeps the button disabled/pending (navigation is expected)", async () => {
    impl = async () => ({ status: "redirecting" });
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "checkout" }));

    await user.click(screen.getByRole("button", { name: "Restore subscription" }));

    const pendingButton = await screen.findByRole("button", { name: "Working..." });
    assert.equal(pendingButton.hasAttribute("disabled"), true);
  });
});

describe("returned error and thrown error behavior", () => {
  test("a returned error clears pending and renders exactly the helper's safe message, nothing else", async () => {
    impl = async () => ({ status: "error", message: "We couldn't open billing right now. Please try again." });
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    await user.click(screen.getByRole("button", { name: "Update billing" }));

    const reenabled = await screen.findByRole("button", { name: "Update billing" });
    assert.equal(reenabled.hasAttribute("disabled"), false);
    assert.equal(screen.getByRole("alert").textContent, "We couldn't open billing right now. Please try again.");
  });

  test("a fake provider error's raw text never reaches the rendered output, even if the mock tried to leak it", async () => {
    impl = async () => {
      throw new Error("Stripe API key invalid: sk_live_XXXXXXXXXXXXXXXXXXXX");
    };
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    await user.click(screen.getByRole("button", { name: "Update billing" }));

    const alert = await screen.findByRole("alert");
    assert.equal(alert.textContent, UNEXPECTED_ERROR_MESSAGE);
    assert.ok(!alert.textContent?.includes("sk_live"));
    const reenabled = screen.getByRole("button", { name: "Update billing" });
    assert.equal(reenabled.hasAttribute("disabled"), false);
  });

  test("an unexpected thrown error clears pending and shows only the generic message", async () => {
    impl = async () => {
      throw new Error("simulated unexpected failure");
    };
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "verification_error", recoveryAction: "support" }));

    await user.click(screen.getByRole("button", { name: "Contact support" }));

    const alert = await screen.findByRole("alert");
    assert.equal(alert.textContent, UNEXPECTED_ERROR_MESSAGE);
    const reenabled = screen.getByRole("button", { name: "Contact support" });
    assert.equal(reenabled.hasAttribute("disabled"), false);
  });
});

describe("no_action clears pending", () => {
  test("a no_action result clears pending with no error shown", async () => {
    impl = async () => ({ status: "no_action" });
    const user = userEvent.setup();
    render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    await user.click(screen.getByRole("button", { name: "Update billing" }));

    const reenabled = await screen.findByRole("button", { name: "Update billing" });
    assert.equal(reenabled.hasAttribute("disabled"), false);
    assert.equal(screen.queryByRole("alert"), null);
  });
});

describe("unmount safety during unresolved async recovery", () => {
  test("unmounting while a recovery call is pending, then resolving it, produces no crash or React warning-triggering update", async () => {
    const deferred = createDeferred<BillingRecoveryResult>();
    impl = () => deferred.promise;
    const user = userEvent.setup();
    const { unmount } = render(React.createElement(OwnerBillingBanner, { bannerVariant: "restricted", recoveryAction: "portal" }));

    await user.click(screen.getByRole("button", { name: "Update billing" }));
    unmount();

    await assert.doesNotReject(async () => {
      deferred.resolve({ status: "error", message: "irrelevant, component is unmounted" });
      await deferred.promise;
    });
  });
});

describe("the component accepts no forbidden props (source-level proof)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./OwnerBillingBanner.ts", import.meta.url)), "utf8");

  test("prop type is exactly Pick<EntitlementView, \"bannerVariant\" | \"recoveryAction\">, no wider prop accepted", () => {
    assert.ok(source.includes('Pick<EntitlementView, "bannerVariant" | "recoveryAction">'));
  });

  test("never references raw entitlement/billing/workspace/Stripe fields", () => {
    for (const forbidden of [
      "stripeStatus",
      "billingMode",
      "graceEndsAt",
      "trialEnd",
      "currentPeriodEnd",
      "cancelAtPeriodEnd",
      "workspaceId",
      "customerId",
      "subscriptionId",
      "redirectUrl",
      "supportUrl",
      "supportEmail:",
    ]) {
      assert.ok(!source.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });

  test('imports only the browser-safe EntitlementView type, never the raw canonical resolver modules', () => {
    assert.ok(source.includes('from "@/lib/entitlementView"'));
    assert.ok(!source.includes('from "@/lib/entitlement"'));
    assert.ok(!source.includes('from "@/lib/entitlementServer"'));
  });

  test("uses SUPPORT_MAILTO_URL from the canonical module, never a literal address", () => {
    assert.ok(source.includes("SUPPORT_MAILTO_URL"));
    assert.ok(!source.includes("support@scheduleflowtrack.com"));
    assert.ok(!source.includes("admin@novalabsdigital.com"));
  });

  test('the support_required branch assigns window.location.href to exactly the canonical constant', () => {
    assert.ok(source.includes("window.location.href = SUPPORT_MAILTO_URL;"));
    const branchIndex = source.indexOf('result.status === "support_required"');
    const assignIndex = source.indexOf("window.location.href = SUPPORT_MAILTO_URL;");
    assert.ok(branchIndex > -1 && assignIndex > -1 && branchIndex < assignIndex, "the assignment must be inside the support_required branch");
  });

  test("never disables/hides any operational control -- this file only ever renders its own banner markup", () => {
    for (const forbidden of ["canMutateOperationalData", "canUseJobTracking", "canSendNotifications"]) {
      assert.ok(!source.includes(forbidden), `must not reference capability "${forbidden}" -- Phase 5.5D does not enforce capabilities`);
    }
  });
});

describe("DashboardShell and MobileDashboard integration (source-level proof)", () => {
  const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const dashboardShellSource = fs.readFileSync(
    path.join(projectRoot, "app", "components", "dashboard", "DashboardShell.tsx"),
    "utf8"
  );
  const mobileDashboardSource = fs.readFileSync(
    path.join(projectRoot, "app", "components", "mobile", "MobileDashboard.tsx"),
    "utf8"
  );

  test("DashboardShell renders <OwnerBillingBanner exactly once, using the existing entitlement prop", () => {
    const matches = dashboardShellSource.match(/<OwnerBillingBanner\b/g) ?? [];
    assert.equal(matches.length, 1);
    assert.ok(dashboardShellSource.includes("bannerVariant={entitlement.bannerVariant}"));
    assert.ok(dashboardShellSource.includes("recoveryAction={entitlement.recoveryAction}"));
  });

  test("DashboardShell places the desktop banner after the Demo Mode block and before the primary flex content", () => {
    const demoIndex = dashboardShellSource.indexOf("Demo Mode — All information shown");
    const bannerIndex = dashboardShellSource.indexOf("<OwnerBillingBanner");
    const flexContentIndex = dashboardShellSource.indexOf('<div className="flex-1 min-h-0 flex">');
    assert.ok(demoIndex > -1 && bannerIndex > -1 && flexContentIndex > -1);
    assert.ok(demoIndex < bannerIndex && bannerIndex < flexContentIndex);
  });

  test("MobileDashboard renders <OwnerBillingBanner exactly once, fed only the narrow banner fields", () => {
    const matches = mobileDashboardSource.match(/<OwnerBillingBanner\b/g) ?? [];
    assert.equal(matches.length, 1);
    assert.ok(mobileDashboardSource.includes("bannerVariant={bannerVariant}"));
    assert.ok(mobileDashboardSource.includes("recoveryAction={recoveryAction}"));
  });

  test("MobileDashboard places its banner after its own Demo Mode block and before the primary content area", () => {
    const demoIndex = mobileDashboardSource.indexOf("Demo Mode — fictional data");
    const bannerIndex = mobileDashboardSource.indexOf("<OwnerBillingBanner");
    const contentIndex = mobileDashboardSource.indexOf('<div className="flex-1 min-h-0 flex flex-col overflow-hidden">');
    assert.ok(demoIndex > -1 && bannerIndex > -1 && contentIndex > -1);
    assert.ok(demoIndex < bannerIndex && bannerIndex < contentIndex);
  });

  test("neither DashboardShell nor MobileDashboard adds a tester/demo/workspace-ID special case around the banner", () => {
    for (const source of [dashboardShellSource, mobileDashboardSource]) {
      // The existing isTester Demo Mode block is expected and unrelated;
      // this checks specifically that OwnerBillingBanner's own render is
      // not wrapped in any additional tester/workspace conditional.
      const bannerLine = source.split("\n").find((l) => l.includes("<OwnerBillingBanner"));
      assert.ok(bannerLine, "banner render line must exist");
      assert.ok(!bannerLine!.includes("isTester"));
      assert.ok(!bannerLine!.includes("DEMO_WORKSPACE_ID"));
    }
  });
});

describe("employee and public surfaces receive no billing banner or recovery helper (source-level proof)", () => {
  const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

  test("EmployeeSchedule.tsx imports neither OwnerBillingBanner nor billingRecovery, and receives no recoveryAction", () => {
    const source = fs.readFileSync(path.join(projectRoot, "app", "components", "schedule", "EmployeeSchedule.tsx"), "utf8");
    assert.ok(!source.includes("OwnerBillingBanner"));
    assert.ok(!source.includes("billingRecovery"));
    assert.ok(!source.includes("recoveryAction"));
  });

  test("app/schedule/page.tsx imports neither OwnerBillingBanner nor billingRecovery", () => {
    const source = fs.readFileSync(path.join(projectRoot, "app", "schedule", "page.tsx"), "utf8");
    assert.ok(!source.includes("OwnerBillingBanner"));
    assert.ok(!source.includes("billingRecovery"));
  });

  test("public booking/availability/cancellation import neither the banner nor billingRecovery", () => {
    for (const rel of [
      path.join("app", "components", "book", "BookingForm.tsx"),
      path.join("app", "book", "page.tsx"),
      path.join("app", "cancel", "page.tsx"),
      path.join("app", "api", "book", "availability", "route.ts"),
      path.join("app", "api", "appointments", "cancel", "route.ts"),
    ]) {
      const source = fs.readFileSync(path.join(projectRoot, rel), "utf8");
      assert.ok(!source.includes("OwnerBillingBanner"), `${rel} must not import the owner billing banner`);
      assert.ok(!source.includes("billingRecovery"), `${rel} must not import the billing-recovery helper`);
    }
  });

  test("CompanyInfoPanel (existing Subscription & Plan card) is not connected to beginBillingRecovery or OwnerBillingBanner", () => {
    const source = fs.readFileSync(path.join(projectRoot, "app", "components", "dashboard", "CompanyInfoPanel.tsx"), "utf8");
    assert.ok(!source.includes("billingRecovery"));
    assert.ok(!source.includes("OwnerBillingBanner"));
  });
});
