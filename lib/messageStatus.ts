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

// The literal "resend" is DELIBERATELY NOT treated as acceptance evidence,
// even though lib/notify.ts's sendEmail still writes it on a genuine
// confirmed-success response that happens to lack a `data.id`. Before this
// app's own fix to sendEmail's ambiguous-response handling (data: null AND
// error: null), that exact same literal string could ALSO have been written
// for a result that was never actually confirmed as accepted -- and a stored
// provider_id value carries no record of which branch produced it. This
// classifier has no row-age or row-version input (see the module header),
// so it cannot tell a pre-fix "resend" apart from a post-fix one; rather
// than risk relabeling an unconfirmed historical send as "Sent" without
// supporting evidence, EVERY "resend" value -- old or new -- is classified
// as Unknown. The cost (a genuine future no-id success also shows as
// Unknown) is accepted deliberately: it is strictly safer than the
// alternative of ever showing a false "Sent."
const DELIBERATELY_UNTRUSTED_EMAIL_VALUES = new Set(["resend"]);

// Validates provider_id against the SHAPE the channel's own provider
// actually produces -- not just "is it non-empty." A Twilio SID is never
// valid evidence for an email row, and vice versa: each channel only ever
// calls one provider, so an id from the other one, or one matching neither
// provider's real format, is never genuine acceptance evidence, however
// non-empty it looks.
function looksLikeAcceptedProviderId(trimmed: string, channel: "email" | "sms"): boolean {
  if (channel === "sms") return TWILIO_MESSAGE_SID_RE.test(trimmed);
  if (DELIBERATELY_UNTRUSTED_EMAIL_VALUES.has(trimmed)) return false;
  return RESEND_EMAIL_ID_RE.test(trimmed);
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

// "Needs attention" (item 3, failed messages): a failed send attempt that
// was later RETRIED and accepted must not remain actionable forever --
// messages_sent rows are never deleted or updated in place, so a single
// failed row from hours/days ago would otherwise flag an appointment
// indefinitely even after a subsequent attempt for the exact same thing
// succeeded. "The exact same thing" is defined identically to
// app/api/cron/reminders/route.ts's own pre-existing alreadyDelivered()
// dedup key -- appointment_id + channel + kind + scheduled_for (the
// migrations/037 occurrence snapshot) -- reused here rather than inventing
// a parallel notion of "the same message." scheduled_for is NULL for every
// non-reminder kind (confirmation/update/cancel never pass it, see
// lib/notify.ts's MessageSentRow comment), which groups every attempt of
// that kind for that appointment together -- there is no finer-grained
// occurrence signal available for those kinds, so that is the correct,
// honest granularity, not a workaround.
export type MessageAttemptRow = {
  appointment_id: string;
  channel: string;
  kind: string;
  scheduled_for: string | null;
  provider_id: string | null;
  created_at: string;
  id: string;
};

function messageAttemptGroupKey(row: MessageAttemptRow): string {
  const channel = row.channel === "sms" ? "sms" : "email";
  return `${row.appointment_id}::${channel}::${row.kind ?? ""}::${row.scheduled_for ?? ""}`;
}

// Within one group, only the chronologically LATEST attempt whose status is
// unambiguous (sent or failed) decides whether that group is still
// unresolved -- a later "unknown" or skipped row never resolves an earlier
// failure (this app can never treat Unknown as confirmed success, see
// classifyMessageStatus above), and is simply skipped when looking for the
// most recent unambiguous outcome. If the latest unambiguous attempt is a
// failure, it is genuinely unresolved and must stay actionable; if it is an
// accepted send, every earlier failure in the same group is resolved.
function latestUnambiguousStatus(rows: MessageAttemptRow[]): MessageStatusCode | null {
  const sorted = [...rows].sort((a, b) => {
    const byTime = (a.created_at ?? "").localeCompare(b.created_at ?? "");
    if (byTime !== 0) return byTime;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    const row = sorted[i];
    const channel = row.channel === "sms" ? "sms" : "email";
    const code = classifyMessageStatus(row.provider_id, channel).code;
    if (code === "sent" || code === "failed") return code;
  }
  return null;
}

// Counts, per appointment, the number of distinct (channel, kind,
// scheduled_for) groups whose most recent unambiguous attempt is a
// confirmed failure -- never a raw count of failed ROWS, which would
// double-count retries and ignore accepted resends. See the module comment
// above for why "the same group" is defined exactly as it is.
export function countUnresolvedFailedMessageGroupsByAppointment(
  rows: MessageAttemptRow[]
): Map<string, number> {
  const groups = new Map<string, MessageAttemptRow[]>();
  for (const row of rows) {
    const key = messageAttemptGroupKey(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  const counts = new Map<string, number>();
  for (const group of groups.values()) {
    if (latestUnambiguousStatus(group) !== "failed") continue;
    const appointmentId = group[0].appointment_id;
    counts.set(appointmentId, (counts.get(appointmentId) ?? 0) + 1);
  }
  return counts;
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
