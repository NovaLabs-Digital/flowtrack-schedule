// Test-only DOM bootstrap (never imported by production code -- follows
// the same "test-only lib/ module" convention already established by
// lib/testSupport.ts). Installs a minimal jsdom environment onto
// globalThis so @testing-library/react can render real React components
// and @testing-library/user-event can dispatch real click/keyboard
// events, entirely within this project's existing `node --test` runner --
// no second test runner, no browser process, no Next.js dev server.
//
// Deliberately NOT registered through scripts/test-register.mjs's
// --import hook: that hook applies to the single `node --test
// <files...>` invocation covering the whole suite, but each listed file
// still executes in its own process, so only a test file that explicitly
// imports this module ever gets a DOM. Every existing non-DOM test (route
// handlers, pure resolver logic, the global.fetch spy in
// lib/billingRecovery.test.ts) imports nothing new here and sees no new
// global -- this module has zero effect on any file that doesn't import it.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  // Enables requestAnimationFrame/cancelAnimationFrame, which React's
  // scheduler uses -- without this jsdom leaves them unimplemented.
  pretendToBeVisual: true,
});

const { window } = dom;

// The specific set of globals React DOM, @testing-library/react, and
// @testing-library/user-event actually read directly off `globalThis`
// (testing-library prefers `document.defaultView` where it can, but a few
// checks still fall back to bare globals) -- an explicit, narrow list
// rather than copying every property jsdom's window exposes, so this
// setup can never accidentally shadow an unrelated Node global.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Object.defineProperty rather than plain assignment: Node already
// defines its own read-only-by-default `navigator` global (a minimal
// Navigator-like object reporting "Node.js"), so a bare `globalThis.navigator
// = ...` throws ("Cannot set property navigator of #<Object> which has
// only a getter"). Defining every entry the same way keeps this setup
// robust to any other Node global that follows the same getter-only
// pattern, present or future.
function installGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

installGlobal("window", window);
installGlobal("document", window.document);
installGlobal("navigator", window.navigator);
installGlobal("HTMLElement", window.HTMLElement);
installGlobal("Element", window.Element);
installGlobal("Node", window.Node);
installGlobal("Event", window.Event);
installGlobal("MouseEvent", window.MouseEvent);
installGlobal("KeyboardEvent", window.KeyboardEvent);
installGlobal("getComputedStyle", window.getComputedStyle.bind(window));
installGlobal("requestAnimationFrame", window.requestAnimationFrame.bind(window));
installGlobal("cancelAnimationFrame", window.cancelAnimationFrame.bind(window));

// React 18+ requires this explicit opt-in before act() runs without a
// "not configured to support act(...)" warning. @testing-library/react
// normally sets it automatically on import, but setting it here too makes
// this module a complete, self-contained bootstrap regardless of import
// order relative to @testing-library/react.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
