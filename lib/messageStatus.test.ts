import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyMessageStatus, describeMessageKind } from "./messageStatus.ts";

// Realistic, correctly-shaped ids for each provider -- a UUID (Resend) and a
// 34-character "SM" + 32 hex chars (Twilio Message SID), matching exactly
// what lib/notify.ts's sendEmail/sendSms return on success.
const REAL_RESEND_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const REAL_TWILIO_SID = "SMa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

describe("classifyMessageStatus", () => {
  test("a correctly-shaped Resend id on an email row is 'sent', with the delivery-unconfirmed qualifier never dropped", () => {
    assert.deepEqual(classifyMessageStatus(REAL_RESEND_ID, "email"), { code: "sent", label: "Sent — delivery unconfirmed" });
  });

  test("sendEmail's own degraded-success fallback ('resend', written when Resend's response had no id) is still 'sent'", () => {
    assert.deepEqual(classifyMessageStatus("resend", "email"), { code: "sent", label: "Sent — delivery unconfirmed" });
  });

  test("a correctly-shaped Twilio Message SID on an sms row is 'sent'", () => {
    assert.deepEqual(classifyMessageStatus(REAL_TWILIO_SID, "sms"), { code: "sent", label: "Sent — delivery unconfirmed" });
  });

  test("'failed' is Failed, on either channel", () => {
    assert.deepEqual(classifyMessageStatus("failed", "email"), { code: "failed", label: "Failed" });
    assert.deepEqual(classifyMessageStatus("failed", "sms"), { code: "failed", label: "Failed" });
  });

  test("'disabled' is skipped_disabled with an accurate, non-vague label", () => {
    assert.deepEqual(classifyMessageStatus("disabled", "email"), { code: "skipped_disabled", label: "Skipped — message sending was disabled" });
  });

  test("'notifications-off' is skipped_notifications_off with an accurate, non-vague label", () => {
    assert.deepEqual(classifyMessageStatus("notifications-off", "sms"), { code: "skipped_notifications_off", label: "Skipped — client notifications were off" });
  });

  test("null is Unknown, never guessed as sent or failed", () => {
    assert.deepEqual(classifyMessageStatus(null, "email"), { code: "unknown", label: "Unknown" });
  });

  test("undefined is Unknown", () => {
    assert.deepEqual(classifyMessageStatus(undefined, "email"), { code: "unknown", label: "Unknown" });
  });

  test("an empty string is Unknown, not treated as acceptance evidence", () => {
    assert.deepEqual(classifyMessageStatus("", "email"), { code: "unknown", label: "Unknown" });
  });

  test("a whitespace-only string is Unknown", () => {
    assert.deepEqual(classifyMessageStatus("   ", "sms"), { code: "unknown", label: "Unknown" });
  });

  test("a non-empty, plausible-looking but unrecognized string is Unknown -- non-empty alone never establishes acceptance", () => {
    for (const unexpected of ["unexpected-value", "re_abc123", "msg_12345", "random-garbage-string", "12345"]) {
      assert.deepEqual(
        classifyMessageStatus(unexpected, "email"),
        { code: "unknown", label: "Unknown" },
        `expected "${unexpected}" to be unknown -- it is not a real Resend id shape`
      );
      assert.deepEqual(
        classifyMessageStatus(unexpected, "sms"),
        { code: "unknown", label: "Unknown" },
        `expected "${unexpected}" to be unknown -- it is not a real Twilio SID shape`
      );
    }
  });

  test("known bug-artifact strings (stringified null/undefined/NaN/object) are Unknown, never Sent", () => {
    for (const bogus of ["null", "undefined", "NaN", "[object Object]"]) {
      assert.deepEqual(classifyMessageStatus(bogus, "email"), { code: "unknown", label: "Unknown" });
    }
  });

  test("channel context matters: a real Twilio SID is NOT acceptance evidence for an email row, and a real Resend id is NOT acceptance evidence for an sms row", () => {
    assert.deepEqual(
      classifyMessageStatus(REAL_TWILIO_SID, "email"),
      { code: "unknown", label: "Unknown" },
      "a Twilio SID must never validate an email row -- email only ever calls Resend"
    );
    assert.deepEqual(
      classifyMessageStatus(REAL_RESEND_ID, "sms"),
      { code: "unknown", label: "Unknown" },
      "a Resend id must never validate an sms row -- sms only ever calls Twilio"
    );
  });

  test("a near-miss Twilio SID (wrong prefix, or wrong hex length) is Unknown, not Sent", () => {
    assert.deepEqual(classifyMessageStatus("XX" + "a".repeat(32), "sms"), { code: "unknown", label: "Unknown" });
    assert.deepEqual(classifyMessageStatus("SM" + "a".repeat(31), "sms"), { code: "unknown", label: "Unknown" }); // one char short
    assert.deepEqual(classifyMessageStatus("SM" + "a".repeat(33), "sms"), { code: "unknown", label: "Unknown" }); // one char long
  });

  test("a near-miss Resend id (missing a hyphen group, non-hex characters) is Unknown, not Sent", () => {
    assert.deepEqual(classifyMessageStatus("4ef9a417-02e9-4d39-ad75", "email"), { code: "unknown", label: "Unknown" });
    assert.deepEqual(classifyMessageStatus("4ef9a417-02e9-4d39-ad75-9611e0fccXYZ", "email"), { code: "unknown", label: "Unknown" });
  });

  test("this classifier has no special-case for row age: a value written by the pre-existing send paths long before this Message History feature existed is classified by the exact same rules as a brand-new row", () => {
    // classifyMessageStatus takes only (providerId, channel) -- it has no
    // "when was this row written" input at all, so it is structurally
    // incapable of grandfathering an old row into a more permissive result.
    // A genuinely correctly-shaped legacy id (sendEmail/sendSms have always
    // produced this exact shape -- this feature changed classification and
    // display, never what gets written) still classifies as Sent...
    assert.deepEqual(classifyMessageStatus(REAL_RESEND_ID, "email"), { code: "sent", label: "Sent — delivery unconfirmed" });
    // ...while an unfamiliar legacy value (e.g. from a since-removed
    // provider, a manual data correction, or any value that simply doesn't
    // match either known provider's real shape) is Unknown, exactly like
    // any other unrecognized value -- never presumed Sent just because it
    // predates this UI.
    assert.deepEqual(classifyMessageStatus("legacy-system-ref-00482", "email"), { code: "unknown", label: "Unknown" });
  });

  test("never returns a Queued, Delivered, or Read status for any input -- this app has no evidence for any of them", () => {
    const codes: string[] = [];
    for (const input of [REAL_RESEND_ID, "failed", "disabled", "notifications-off", null, undefined, "", "   ", "unexpected-value"]) {
      codes.push(classifyMessageStatus(input as string | null | undefined, "email").code);
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
