// Phase 5.7D-R17: real rendered-component behavior tests for
// PasswordInput.tsx, using the same jsdom + @testing-library/react +
// @testing-library/user-event foundation as CapabilityGatedButton.test.ts.
// Dependency-free component (no fetch, no session) -- every scenario is
// driven purely by props/DOM interaction. No real Supabase/network call is
// reachable from any test.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

// Must be imported before react-dom/@testing-library/react so document/
// window/etc. exist on globalThis by the time those modules evaluate.
import "../../lib/testDom.ts";

import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { default: PasswordInput } = await import("./PasswordInput.ts");

afterEach(() => {
  cleanup();
});

function Controlled({ initialValue = "" }: { initialValue?: string }) {
  const [value, setValue] = React.useState(initialValue);
  return React.createElement(PasswordInput, {
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
    placeholder: "Enter password",
  });
}

describe("PasswordInput -- hidden by default", () => {
  test("renders type=password initially, never pre-revealed", () => {
    render(React.createElement(Controlled, {}));
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    assert.equal(input.type, "password");
  });

  test("the toggle button's initial accessible label is 'Show password'", () => {
    render(React.createElement(Controlled, {}));
    assert.ok(screen.getByRole("button", { name: "Show password" }));
  });
});

describe("PasswordInput -- show/hide toggle", () => {
  test("clicking the eye switches the field to type=text and the label to 'Hide password'", async () => {
    render(React.createElement(Controlled, {}));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show password" }));
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    assert.equal(input.type, "text");
    assert.ok(screen.getByRole("button", { name: "Hide password" }));
  });

  test("clicking again switches back to type=password and the label back to 'Show password'", async () => {
    render(React.createElement(Controlled, {}));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show password" }));
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    assert.equal(input.type, "password");
  });

  test("aria-pressed reflects the current visibility state", async () => {
    render(React.createElement(Controlled, {}));
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Show password" });
    assert.equal(button.getAttribute("aria-pressed"), "false");
    await user.click(button);
    assert.equal(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed"), "true");
  });

  test("toggling visibility never changes the field's value", async () => {
    render(React.createElement(Controlled, { initialValue: "hunter2" }));
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    assert.equal(input.value, "hunter2");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    assert.equal(input.value, "hunter2");
  });

  test("typing into the field behaves exactly like a normal controlled input", async () => {
    render(React.createElement(Controlled, {}));
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    await user.type(input, "abc123");
    assert.equal(input.value, "abc123");
  });
});

describe("PasswordInput -- independent per-field behavior", () => {
  test("two separate instances (password + confirm) toggle independently", async () => {
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(PasswordInput, { value: "a", onChange: () => {}, placeholder: "Password" }),
        React.createElement(PasswordInput, { value: "b", onChange: () => {}, placeholder: "Confirm Password" })
      )
    );
    const user = userEvent.setup();
    const passwordField = screen.getByPlaceholderText("Password") as HTMLInputElement;
    const confirmField = screen.getByPlaceholderText("Confirm Password") as HTMLInputElement;
    assert.equal(passwordField.type, "password");
    assert.equal(confirmField.type, "password");

    // Reveal only the first field's eye button (scoped by its accessible name
    // among the two identical "Show password" buttons via getAllByRole).
    const showButtons = screen.getAllByRole("button", { name: "Show password" });
    assert.equal(showButtons.length, 2);
    await user.click(showButtons[0]);

    assert.equal(passwordField.type, "text");
    assert.equal(confirmField.type, "password", "the confirm field must remain hidden -- toggles are independent per field");
  });
});

describe("PasswordInput -- keyboard accessibility", () => {
  test("the toggle can be reached by Tab and activated with Enter", async () => {
    render(React.createElement(Controlled, {}));
    const user = userEvent.setup();
    await user.tab(); // into the text input
    await user.tab(); // into the toggle button
    assert.equal(screen.getByRole("button", { name: "Show password" }), document.activeElement);
    await user.keyboard("{Enter}");
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    assert.equal(input.type, "text");
  });

  test("the toggle can be activated with Space", async () => {
    render(React.createElement(Controlled, {}));
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    await user.keyboard(" ");
    const input = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    assert.equal(input.type, "text");
  });

  test("the toggle button has type=button so it can never submit an enclosing form", () => {
    render(React.createElement(Controlled, {}));
    assert.equal(screen.getByRole("button", { name: "Show password" }).getAttribute("type"), "button");
  });
});
