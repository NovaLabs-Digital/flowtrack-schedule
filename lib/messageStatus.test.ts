import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyMessageStatus, describeMessageKind } from "./messageStatus.ts";

describe("classifyMessageStatus", () => {
  test("a real provider id/SID is 'sent', with the delivery-unconfirmed qualifier never dropped", () => {
    assert.deepEqual(classifyMessageStatus("re_abc123"), { code: "sent", label: "Sent — delivery unconfirmed" });
    assert.deepEqual(classifyMessageStatus("SM1234567890abcdef1234567890abcdef"), { code: "sent", label: "Sent — delivery unconfirmed" });
  });

  test("'failed' is Failed", () => {
    assert.deepEqual(classifyMessageStatus("failed"), { code: "failed", label: "Failed" });
  });

  test("'disabled' is skipped_disabled with an accurate, non-vague label", () => {
    assert.deepEqual(classifyMessageStatus("disabled"), { code: "skipped_disabled", label: "Skipped — message sending was disabled" });
  });

  test("'notifications-off' is skipped_notifications_off with an accurate, non-vague label", () => {
    assert.deepEqual(classifyMessageStatus("notifications-off"), { code: "skipped_notifications_off", label: "Skipped — client notifications were off" });
  });

  test("null is Unknown, never guessed as sent or failed", () => {
    assert.deepEqual(classifyMessageStatus(null), { code: "unknown", label: "Unknown" });
  });

  test("undefined is Unknown", () => {
    assert.deepEqual(classifyMessageStatus(undefined), { code: "unknown", label: "Unknown" });
  });

  test("an empty string is Unknown, not treated as acceptance evidence", () => {
    assert.deepEqual(classifyMessageStatus(""), { code: "unknown", label: "Unknown" });
  });

  test("a whitespace-only string is Unknown", () => {
    assert.deepEqual(classifyMessageStatus("   "), { code: "unknown", label: "Unknown" });
  });

  test("non-empty alone is NOT sufficient acceptance evidence: known bug-artifact strings (stringified null/undefined/NaN/object) are Unknown, never Sent", () => {
    for (const bogus of ["null", "undefined", "NaN", "[object Object]", "UNDEFINED", "Null"]) {
      assert.deepEqual(classifyMessageStatus(bogus), { code: "unknown", label: "Unknown" }, `expected "${bogus}" to be unknown, not sent merely for being non-empty`);
    }
  });

  test("a genuine-looking provider id is still Sent -- the bug-artifact check doesn't over-reject real ids", () => {
    assert.deepEqual(classifyMessageStatus("re_9f3c2a"), { code: "sent", label: "Sent — delivery unconfirmed" });
    assert.deepEqual(classifyMessageStatus("SM1234567890abcdef1234567890abcdef"), { code: "sent", label: "Sent — delivery unconfirmed" });
    assert.deepEqual(classifyMessageStatus("resend"), { code: "sent", label: "Sent — delivery unconfirmed" });
  });

  test("never returns a Queued, Delivered, or Read status for any input -- this app has no evidence for any of them", () => {
    const codes: string[] = [];
    for (const input of ["re_x", "failed", "disabled", "notifications-off", null, undefined, "", "   ", "anything-else"]) {
      codes.push(classifyMessageStatus(input as string | null | undefined).code);
    }
    for (const c of codes) {
      assert.ok(!["queued", "delivered", "read"].includes(c));
    }
  });
});

describe("describeMessageKind", () => {
  test("maps every known kind to a readable label", () => {
    assert.equal(describeMessageKind("confirmation"), "Appointment Confirmation");
    assert.equal(describeMessageKind("update"), "Appointment Update");
    assert.equal(describeMessageKind("cancel"), "Cancellation Notice");
    assert.equal(describeMessageKind("reminder_24h"), "24-Hour Reminder");
  });

  test("an unrecognized kind is shown verbatim, never hidden", () => {
    assert.equal(describeMessageKind("some_future_kind"), "some_future_kind");
  });
});
