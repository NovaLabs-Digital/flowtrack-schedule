// Message History: the single source of truth for turning a stored
// messages_sent.provider_id value into something honest to show an owner.
//
// provider_id's real meaning (lib/notify.ts): a non-sentinel string is the
// id/SID the provider (Resend/Twilio) handed back at the moment it ACCEPTED
// the message for sending -- never proof of delivery or reading. This
// codebase has no delivery-webhook integration with either provider (no
// Twilio status callback, no Resend webhook endpoint exist anywhere in this
// app), so "delivered" or "read" can never be truthfully shown -- only that
// the provider accepted the send attempt, or that it failed, or that it was
// deliberately skipped.
//
// Every row is written AFTER the attempt completes (success, thrown error,
// or skip check) -- recordMessageSent is never called before a provider call
// is made, so a stored row never represents a "queued, not yet attempted"
// state either. There is no "Queued" state to show.
export type MessageStatusCode =
  | "sent"
  | "failed"
  | "skipped_disabled"
  | "skipped_notifications_off"
  | "unknown";

export type MessageStatus = {
  code: MessageStatusCode;
  label: string;
};

// Strings that could appear in this column only as the artifact of some
// future bug coercing a non-string into one (`String(undefined)`,
// `String(null)`, a mis-handled object/array, `String(NaN)`) -- never as a
// genuine value either provider actually returns, and never written by any
// code path in this app today. Checked case-insensitively. Being non-empty
// is NOT, by itself, enough to count as acceptance evidence -- a value in
// this set must still fall through to "unknown" rather than being presumed
// "sent" merely because it has characters in it.
const NOT_ACCEPTANCE_EVIDENCE = new Set(["null", "undefined", "nan", "[object object]"]);

// The three sentinel strings every send call site in lib/notify.ts writes
// instead of a real provider id -- "failed" (the provider call threw),
// "disabled" (the DISABLE_MESSAGES kill switch), "notifications-off" (the
// owner's own Settings -> Automation toggle was off at send time).
export function classifyMessageStatus(providerId: string | null | undefined): MessageStatus {
  if (providerId === "failed") {
    return { code: "failed", label: "Failed" };
  }
  if (providerId === "disabled") {
    return { code: "skipped_disabled", label: "Skipped — message sending was disabled" };
  }
  if (providerId === "notifications-off") {
    return { code: "skipped_notifications_off", label: "Skipped — client notifications were off" };
  }
  const trimmed = typeof providerId === "string" ? providerId.trim() : "";
  // A real provider id/SID: the only evidence this app can ever have of
  // acceptance. Never shown as plain "Sent" -- the qualifier is load-bearing,
  // not decorative. This function never tries to validate the POSITIVE shape
  // of a real id (providers don't publish one), but it does reject the small,
  // known set of bug-artifact strings above -- non-empty alone is
  // insufficient.
  if (trimmed.length > 0 && !NOT_ACCEPTANCE_EVIDENCE.has(trimmed.toLowerCase())) {
    return { code: "sent", label: "Sent — delivery unconfirmed" };
  }
  // null, undefined, an empty/whitespace-only string, or one of the
  // bug-artifact strings above: never guessed into "sent" or "failed" --
  // shown plainly as unknown.
  return { code: "unknown", label: "Unknown" };
}

// Message History: a readable label for messages_sent.kind, the free-text
// value every notify call site writes ("confirmation" | "update" | "cancel"
// | "reminder_24h" today). An unrecognized future kind is shown verbatim
// rather than hidden or mislabeled -- this is display-only and never used to
// gate or branch any logic.
export function describeMessageKind(kind: string): string {
  switch (kind) {
    case "confirmation": return "Appointment Confirmation";
    case "update": return "Appointment Update";
    case "cancel": return "Cancellation Notice";
    case "reminder_24h": return "24-Hour Reminder";
    default: return kind;
  }
}
