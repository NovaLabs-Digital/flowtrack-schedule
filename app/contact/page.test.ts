// Source-level proof for app/contact/page.tsx. This is a .tsx file; Node's
// built-in test runner (this repo's only test runner) cannot load .tsx
// directly -- matching the established convention (see
// app/signup/page.test.ts, app/login/page.test.ts).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/contact/page.tsx -- required and optional fields", () => {
  test("collects name, email, subject, and message as required fields", () => {
    assert.ok(source.includes("[name, setName]"));
    assert.ok(source.includes('type="email"'));
    assert.ok(source.includes("[subject, setSubject]"));
    assert.ok(source.includes("[message, setMessage]"));
  });

  test("company is present but optional", () => {
    assert.ok(source.includes("[company, setCompany]"));
    assert.ok(source.includes("optional"));
  });

  test("client-side validation blocks submission when a required field is blank, before any fetch call", () => {
    for (const check of ["!name.trim()", "!email.trim()", "!subject.trim()", "!message.trim()"]) {
      assert.ok(source.includes(check), `expected a client-side check for ${check}`);
    }
  });

  test("every field respects a local CONTACT_FIELD_LIMITS via maxLength -- not imported from lib/contactMessage.ts (a server-only module, which cannot be imported from this client component)", () => {
    assert.ok(!source.includes('from "@/lib/contactMessage"'), "must not import the server-only module from this client component");
    assert.ok(source.includes("const CONTACT_FIELD_LIMITS ="));
    for (const field of ["name", "email", "company", "subject", "message"]) {
      assert.ok(source.includes(`maxLength={CONTACT_FIELD_LIMITS.${field}}`), `expected maxLength for ${field}`);
    }
  });

  test("the local limits mirror lib/contactMessage.ts's CONTACT_FIELD_LIMITS exactly", () => {
    const serverSource = fs.readFileSync(fileURLToPath(new URL("../../lib/contactMessage.ts", import.meta.url)), "utf8");
    const serverMatch = serverSource.match(/CONTACT_FIELD_LIMITS = \{([^}]*)\}/);
    const clientMatch = source.match(/CONTACT_FIELD_LIMITS = \{([^}]*)\}/);
    assert.ok(serverMatch && clientMatch);
    const parseLimits = (block: string) =>
      Object.fromEntries(
        [...block.matchAll(/(\w+):\s*(\d+)/g)].map(([, key, value]) => [key, Number(value)])
      );
    assert.deepEqual(parseLimits(clientMatch![1]), parseLimits(serverMatch![1]));
  });
});

describe("app/contact/page.tsx -- submission flow", () => {
  test("submits to POST /api/contact with the five real fields plus the honeypot", () => {
    assert.ok(source.includes('fetch("/api/contact"'));
    assert.ok(source.includes('method: "POST"'));
    const bodyMatch = source.match(/body: JSON\.stringify\(\{([^}]*)\}\)/);
    assert.ok(bodyMatch);
    for (const field of ["name:", "email:", "company:", "subject:", "message:", "website"]) {
      assert.ok(bodyMatch![1].includes(field), `expected ${field} in the submitted body`);
    }
  });

  test("has a loading/submitting state that disables the submit button", () => {
    assert.ok(source.includes("[loading, setLoading]"));
    assert.ok(source.includes("disabled={loading}"));
    assert.ok(source.includes("Sending..."));
  });

  test("has a distinct success confirmation state, replacing the form", () => {
    assert.ok(source.includes("[sent, setSent]"));
    assert.ok(source.includes("setSent(true)"));
    assert.ok(/sent \?/.test(source));
  });

  test("shows the server's error message on failure, and a distinct network-error fallback", () => {
    assert.ok(source.includes("data?.error"));
    assert.ok(source.includes("Network error"));
  });
});

describe("app/contact/page.tsx -- honeypot (bot protection), never visible to real visitors", () => {
  test("the honeypot field is visually hidden and excluded from assistive tech and autofill", () => {
    const idx = source.indexOf('name="website"');
    assert.notEqual(idx, -1);
    const block = source.slice(Math.max(0, idx - 400), idx + 100);
    assert.ok(block.includes('className="hidden"'));
    assert.ok(block.includes('aria-hidden="true"'));
    assert.ok(block.includes("tabIndex={-1}"));
    assert.ok(block.includes('autoComplete="off"'));
  });

  test("the honeypot is never required and has no maxLength/CONTACT_FIELD_LIMITS entry", () => {
    assert.ok(!source.includes("CONTACT_FIELD_LIMITS.website"));
  });
});

describe("app/contact/page.tsx -- no account/login required", () => {
  test("does not reference session, auth, or a login redirect anywhere in this file", () => {
    const lower = source.toLowerCase();
    assert.ok(!lower.includes("getsession"));
    assert.ok(!lower.includes("sft_session"));
    assert.ok(!lower.includes("requireowner"));
  });
});

describe("app/contact/page.tsx -- links back to the public site", () => {
  test("links to /terms, /privacy, and back Home to /", () => {
    assert.ok(source.includes('href="/terms"'));
    assert.ok(source.includes('href="/privacy"'));
    assert.ok(source.includes('href="/"'));
  });

  test("has no Support mailto link and no self-referential Contact Us link -- a link to the page you're already on has no purpose", () => {
    assert.ok(!source.includes("SUPPORT_MAILTO_URL"));
    assert.ok(!source.includes("@/lib/support"));
    assert.ok(!source.includes("support@scheduleflowtrack.com"));
    const footerStart = source.indexOf("safe-area-bottom");
    assert.notEqual(footerStart, -1);
    const footerBlock = source.slice(footerStart);
    assert.ok(!/>\s*Support\s*</.test(footerBlock));
    assert.ok(!footerBlock.includes('href="/contact"'), "the Contact Us page's own footer must not link back to itself");
  });
});
