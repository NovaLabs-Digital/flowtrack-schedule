import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMessageStatus,
  describeMessageKind,
  countUnresolvedFailedMessageGroupsByAppointment,
  type MessageAttemptRow,
} from "./messageStatus.ts";

// Realistic, correctly-shaped ids for each provider -- a UUID (Resend) and a
// 34-character "SM" + 32 hex chars (Twilio Message SID), matching exactly
// what lib/notify.ts's sendEmail/sendSms return on success.
const REAL_RESEND_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const REAL_TWILIO_SID = "SMa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

describe("classifyMessageStatus", () => {
  test("a correctly-shaped Resend id on an email row is 'sent', with the delivery-unconfirmed qualifier never dropped", () => {
    assert.deepEqual(classifyMessageStatus(REAL_RESEND_ID, "email"), { code: "sent", label: "Sent — delivery unconfirmed" });
  });

  test("the literal 'resend' is Unknown, NEVER Sent -- a stored row can't prove whether it came from sendEmail's genuine no-id success fallback or from the (now-fixed) ambiguous-response branch that used to write the same literal", () => {
    assert.deepEqual(classifyMessageStatus("resend", "email"), { code: "unknown", label: "Unknown" });
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

describe("countUnresolvedFailedMessageGroupsByAppointment", () => {
  const REAL_RESEND_ID_2 = "7a1b2c3d-4e5f-4a1b-9c3d-4e5f6a1b2c3d";
  const REAL_TWILIO_SID_2 = "SMb2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5";

  function row(overrides: Partial<MessageAttemptRow> = {}): MessageAttemptRow {
    return {
      appointment_id: "appt-1",
      channel: "sms",
      kind: "confirmation",
      scheduled_for: null,
      provider_id: "failed",
      created_at: "2026-08-10T00:00:00.000Z",
      id: "m1",
      ...overrides,
    };
  }

  test("a single failed attempt with no retry is unresolved -- counted", () => {
    const counts = countUnresolvedFailedMessageGroupsByAppointment([row()]);
    assert.equal(counts.get("appt-1"), 1);
  });

  test("a failed attempt followed by a later ACCEPTED retry for the exact same appointment/channel/kind/occurrence is resolved -- not counted", () => {
    const failed = row({ id: "m1", created_at: "2026-08-10T00:00:00.000Z", provider_id: "failed" });
    const retried = row({ id: "m2", created_at: "2026-08-10T01:00:00.000Z", provider_id: REAL_RESEND_ID_2, channel: "email" });
    // same group key requires matching channel too -- make both email.
    const counts = countUnresolvedFailedMessageGroupsByAppointment([
      { ...failed, channel: "email" },
      retried,
    ]);
    assert.equal(counts.get("appt-1"), undefined, "the retry resolved it");
  });

  test("a failed attempt followed by a later retry that is itself ALSO failed stays unresolved", () => {
    const first = row({ id: "m1", created_at: "2026-08-10T00:00:00.000Z", provider_id: "failed" });
    const second = row({ id: "m2", created_at: "2026-08-10T01:00:00.000Z", provider_id: "failed" });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([first, second]);
    assert.equal(counts.get("appt-1"), 1, "still exactly one unresolved group, not two");
  });

  test("a later UNKNOWN-status row never resolves an earlier failure -- Unknown is never inferred as success", () => {
    const failed = row({ id: "m1", created_at: "2026-08-10T00:00:00.000Z", provider_id: "failed" });
    const ambiguous = row({ id: "m2", created_at: "2026-08-10T01:00:00.000Z", provider_id: "some-unrecognized-value" });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([failed, ambiguous]);
    assert.equal(counts.get("appt-1"), 1, "the failure is still unresolved -- Unknown never counts as a resolving retry");
  });

  test("a failed attempt followed by an accepted retry for a DIFFERENT channel does not resolve it -- channel is part of the group key", () => {
    const failedSms = row({ id: "m1", channel: "sms", created_at: "2026-08-10T00:00:00.000Z", provider_id: "failed" });
    const acceptedEmail = row({ id: "m2", channel: "email", created_at: "2026-08-10T01:00:00.000Z", provider_id: REAL_RESEND_ID_2 });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([failedSms, acceptedEmail]);
    assert.equal(counts.get("appt-1"), 1, "the sms failure is a different group from the email success");
  });

  test("a failed attempt followed by an accepted retry for a DIFFERENT scheduled occurrence (reminder) does not resolve it", () => {
    const failedFirstOccurrence = row({
      id: "m1", kind: "reminder_24h", scheduled_for: "2026-08-12T13:00:00.000Z",
      created_at: "2026-08-11T13:00:00.000Z", provider_id: "failed",
    });
    const acceptedRescheduledOccurrence = row({
      id: "m2", kind: "reminder_24h", scheduled_for: "2026-08-20T13:00:00.000Z",
      created_at: "2026-08-19T13:00:00.000Z", provider_id: REAL_RESEND_ID_2, channel: "email",
    });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([
      { ...failedFirstOccurrence, channel: "email" },
      acceptedRescheduledOccurrence,
    ]);
    assert.equal(counts.get("appt-1"), 1, "a reschedule's new occurrence is a different group -- the old failure stands on its own");
  });

  test("two independent failed groups (different kinds) for the same appointment both count, as a group count not a row count", () => {
    const confirmationFailed = row({ id: "m1", kind: "confirmation", provider_id: "failed" });
    const cancelFailed = row({ id: "m2", kind: "cancel", provider_id: "failed" });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([confirmationFailed, cancelFailed]);
    assert.equal(counts.get("appt-1"), 2);
  });

  test("ties within a group break on id, deterministically -- never crashes or picks arbitrarily when created_at is identical", () => {
    const a = row({ id: "m-a", created_at: "2026-08-10T00:00:00.000Z", provider_id: "failed" });
    const b = row({ id: "m-b", created_at: "2026-08-10T00:00:00.000Z", provider_id: REAL_TWILIO_SID_2 });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([a, b]);
    assert.equal(counts.get("appt-1"), undefined, "id 'm-b' sorts after 'm-a', so the accepted row wins the tie");
  });

  test("an appointment with no failed groups at all is absent from the map, never a zero entry", () => {
    const sentOnly = row({ provider_id: REAL_RESEND_ID_2 });
    const counts = countUnresolvedFailedMessageGroupsByAppointment([sentOnly]);
    assert.equal(counts.has("appt-1"), false);
  });

  test("an empty input returns an empty map", () => {
    assert.equal(countUnresolvedFailedMessageGroupsByAppointment([]).size, 0);
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
