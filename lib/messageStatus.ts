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

// Resend email id -- lib/notify.ts's sendEmail returns `data?.id`, which
// Resend documents as a UUID (e.g. "4ef9a417-02e9-4d39-ad75-9611e0fcc33c").
// Same pattern already used by lib/claimToken.test.ts and
// lib/recurrenceChange.ts's own UUID_RE for this exact shape, for
// consistency with the rest of this codebase.
const RESEND_EMAIL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Twilio Message SID -- lib/notify.ts's sendSms returns `msg.sid`, a 34-
// character value: a literal "SM" prefix followed by 32 hex characters.
const TWILIO_MESSAGE_SID_RE = /^SM[0-9a-f]{32}$/i;

// sendEmail's own degraded-success fallback (lib/notify.ts: `data?.id ||
// "resend"`) -- written only on the SAME success path as a real Resend id,
// when Resend's response happened not to include one. Still genuine
// acceptance evidence, not a guess.
const EMAIL_FALLBACK_ID = "resend";

// Validates provider_id against the SHAPE the channel's own provider
// actually produces -- not just "is it non-empty." A Twilio SID is never
// valid evidence for an email row, and vice versa: each channel only ever
// calls one provider, so an id from the other one, or one matching neither
// provider's real format, is never genuine acceptance evidence, however
// non-empty it looks.
function looksLikeAcceptedProviderId(trimmed: string, channel: "email" | "sms"): boolean {
  if (channel === "sms") return TWILIO_MESSAGE_SID_RE.test(trimmed);
  return trimmed === EMAIL_FALLBACK_ID || RESEND_EMAIL_ID_RE.test(trimmed);
}

// The three sentinel strings every send call site in lib/notify.ts writes
// instead of a real provider id -- "failed" (the provider call threw),
// "disabled" (the DISABLE_MESSAGES kill switch), "notifications-off" (the
// owner's own Settings -> Automation toggle was off at send time).
export function classifyMessageStatus(providerId: string | null | undefined, channel: "email" | "sms"): MessageStatus {
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
  // The only evidence this app can ever have of acceptance: a value that
  // actually matches the shape THIS channel's own provider returns on
  // success. Non-empty alone is never sufficient -- an arbitrary string, a
  // value from the wrong channel's provider, or a legacy/malformed row that
  // doesn't match either known shape all fall through to "unknown" below,
  // never presumed "sent." Never shown as plain "Sent" either way -- the
  // "delivery unconfirmed" qualifier is load-bearing, not decorative.
  if (trimmed.length > 0 && looksLikeAcceptedProviderId(trimmed, channel)) {
    return { code: "sent", label: "Sent — delivery unconfirmed" };
  }
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
