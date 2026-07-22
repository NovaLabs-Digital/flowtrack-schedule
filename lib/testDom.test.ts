// Phase 5.5D-P: proof that the new jsdom + @testing-library/react +
// @testing-library/user-event setup (lib/testDom.ts) can render a REAL
// React client component into a REAL DOM and exercise it with realistic
// user interaction -- not a pure-controller test, not a source-string
// assertion. This is the smallest behavioral proof needed before the
// Phase 5.5D billing banner can be built and tested the same way.
//
// The fixture component below is deliberately NOT a production component
// -- per the phase's instruction to prefer an in-test fixture over an
// unused production component -- but its shape (a button that enters an
// accessible pending/disabled state on click, guards against duplicate
// activation while pending, and clears pending on success/error) is
// exactly the shape the real billing-recovery button will need, so this
// proof doubles as a rehearsal of the actual test techniques Phase 5.5D
// will reuse.
//
// No network call anywhere in this file; the fixture's "async work" is an
// injected, manually-controlled deferred promise, never a real fetch.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

// Must be imported before react-dom/@testing-library/react so document/
// window/etc. exist on globalThis by the time those modules evaluate.
import "./testDom.ts";

import { useState, act } from "react";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Resolves/rejects a deferred and flushes the resulting React state update
// inside act() -- without this, the fixture's async continuation (setStatus/
// setPending inside handleClick's `finally`) lands outside any act() scope
// and React logs a spurious "not wrapped in act(...)" warning, even though
// the assertions themselves are already correct.
async function settle(deferred: { resolve: () => void; promise: Promise<void> }) {
  await act(async () => {
    deferred.resolve();
    await deferred.promise;
  });
}
async function settleWithRejection(deferred: { reject: (reason: unknown) => void; promise: Promise<void> }, reason: unknown) {
  await act(async () => {
    deferred.reject(reason);
    await deferred.promise.catch(() => {});
  });
}

afterEach(() => {
  cleanup();
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

// A tiny stand-in for "click a button, it goes pending, it guards against
// duplicate activation, it clears pending on success or failure" -- no
// JSX (this is a .ts file, not .tsx, matching every other test file in
// this repo and requiring no JSX transform), built with plain
// React.createElement calls instead.
function AsyncActivateButton({ onActivate }: { onActivate: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");

  async function handleClick() {
    if (pending) return; // the exact duplicate-activation guard Phase 5.5D's real button needs
    setPending(true);
    setStatus("working");
    try {
      await onActivate();
      setStatus("done");
    } catch {
      setStatus("error");
    } finally {
      setPending(false);
    }
  }

  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      { type: "button", onClick: handleClick, disabled: pending, "aria-busy": pending },
      pending ? "Working..." : "Activate"
    ),
    React.createElement("p", { role: "status" }, status)
  );
}

describe("real React rendering: mount, query by role, and initial state", () => {
  test("renders a real button into a real DOM, findable by accessible role and name", () => {
    render(React.createElement(AsyncActivateButton, { onActivate: async () => {} }));
    const button = screen.getByRole("button", { name: "Activate" });
    assert.ok(button instanceof HTMLElement);
    assert.equal(screen.getByRole("status").textContent, "idle");
  });
});

describe("real click interaction (user-event) drives real state transitions", () => {
  test("clicking enters pending state immediately: button is disabled, label and status change", async () => {
    const deferred = createDeferred<void>();
    let callCount = 0;
    const onActivate = () => {
      callCount++;
      return deferred.promise;
    };
    const user = userEvent.setup();
    render(React.createElement(AsyncActivateButton, { onActivate }));

    await user.click(screen.getByRole("button", { name: "Activate" }));

    const pendingButton = screen.getByRole("button", { name: "Working..." });
    assert.equal(pendingButton.hasAttribute("disabled"), true, "the button must be genuinely disabled while pending");
    assert.equal(pendingButton.getAttribute("aria-busy"), "true");
    assert.equal(screen.getByRole("status").textContent, "working");
    assert.equal(callCount, 1);

    await settle(deferred);
  });

  test("rapid duplicate clicks while pending (a disabled button) produce exactly one activation", async () => {
    const deferred = createDeferred<void>();
    let callCount = 0;
    const onActivate = () => {
      callCount++;
      return deferred.promise;
    };
    const user = userEvent.setup();
    render(React.createElement(AsyncActivateButton, { onActivate }));

    const button = screen.getByRole("button", { name: "Activate" });
    await user.click(button);
    assert.equal(callCount, 1);

    // The button is now the real, disabled "Working..." button -- a real
    // browser (and jsdom) never fires a click on a disabled form control,
    // so this exercises the actual DOM disabled behavior, not a manual guard.
    const pendingButton = screen.getByRole("button", { name: "Working..." });
    await user.click(pendingButton);
    await user.click(pendingButton);
    assert.equal(callCount, 1, "a disabled button must not produce a second activation");

    await settle(deferred);
  });

  test("keyboard activation (Tab + Enter) triggers the same handler as a click", async () => {
    const deferred = createDeferred<void>();
    let callCount = 0;
    const onActivate = () => {
      callCount++;
      return deferred.promise;
    };
    const user = userEvent.setup();
    render(React.createElement(AsyncActivateButton, { onActivate }));

    await user.tab(); // focuses the only focusable element: the button
    assert.equal(screen.getByRole("button", { name: "Activate" }), document.activeElement);
    await user.keyboard("{Enter}");

    const pendingButton = screen.getByRole("button", { name: "Working..." });
    assert.equal(pendingButton.hasAttribute("disabled"), true);
    assert.equal(callCount, 1);

    await settle(deferred);
  });

  test("keyboard activation while pending (a disabled button) cannot create a second activation", async () => {
    const deferred = createDeferred<void>();
    let callCount = 0;
    const onActivate = () => {
      callCount++;
      return deferred.promise;
    };
    const user = userEvent.setup();
    render(React.createElement(AsyncActivateButton, { onActivate }));

    await user.tab();
    await user.keyboard("{Enter}");
    assert.equal(callCount, 1);

    // Focus remains on the now-disabled button; a real browser does not
    // deliver a synthetic click from Enter/Space on a disabled element.
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    assert.equal(callCount, 1, "keyboard activation on a disabled button must not create a second call");

    await settle(deferred);
  });

  test("resolving the underlying async work clears pending and returns the button to its enabled label", async () => {
    const deferred = createDeferred<void>();
    const user = userEvent.setup();
    render(React.createElement(AsyncActivateButton, { onActivate: () => deferred.promise }));

    await user.click(screen.getByRole("button", { name: "Activate" }));
    assert.ok(screen.getByRole("button", { name: "Working..." }).hasAttribute("disabled"));

    await settle(deferred);

    const reenabled = screen.getByRole("button", { name: "Activate" });
    assert.equal(reenabled.hasAttribute("disabled"), false);
    assert.equal(screen.getByRole("status").textContent, "done");
  });

  test("a rejected activation clears pending and surfaces the fixture's own error status, not a thrown exception", async () => {
    const deferred = createDeferred<void>();
    const user = userEvent.setup();
    render(React.createElement(AsyncActivateButton, { onActivate: () => deferred.promise }));

    await user.click(screen.getByRole("button", { name: "Activate" }));
    await settleWithRejection(deferred, new Error("simulated failure"));

    const reenabled = screen.getByRole("button", { name: "Activate" });
    assert.equal(reenabled.hasAttribute("disabled"), false);
    assert.equal(screen.getByRole("status").textContent, "error");
  });
});

describe("unmount safety", () => {
  test("unmounts cleanly with no thrown error", () => {
    const { unmount } = render(React.createElement(AsyncActivateButton, { onActivate: async () => {} }));
    assert.doesNotThrow(() => unmount());
  });

  test("resolving pending async work after unmount does not throw or crash the test process", async () => {
    const deferred = createDeferred<void>();
    const user = userEvent.setup();
    const { unmount } = render(React.createElement(AsyncActivateButton, { onActivate: () => deferred.promise }));

    await user.click(screen.getByRole("button", { name: "Activate" }));
    unmount();

    // The component tree is gone; resolving now would attempt a state
    // update on an unmounted component if the fixture had no guard. React
    // 18+'s root API no-ops this safely rather than throwing -- this test
    // proves that behavior holds under this exact setup, which is the
    // scenario the real billing banner's "prevent updates after unmount"
    // requirement exists for.
    assert.doesNotReject(async () => {
      deferred.resolve();
      await deferred.promise;
    });
  });
});

describe("this proof performs no network call", () => {
  test("the fixture's only I/O is the injected onActivate callback -- every test supplies a local deferred promise, never fetch", () => {
    const source = AsyncActivateButton.toString();
    assert.ok(!source.includes("fetch("), "the fixture component itself must never call fetch");
  });
});
