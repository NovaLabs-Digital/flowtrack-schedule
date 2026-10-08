export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateClaimToken } from "@/lib/claimToken";
import { sendEmail, sendSms, describeProviderError, recordMessageSent, sanitizeCompanyName } from "@/lib/notify";
import { reminder24hTemplates } from "@/lib/templates";
import { isAuthorizedCronRequest } from "@/lib/cronAuth";
import { requireCapabilityForWorkspace } from "@/lib/entitlementServer";
import { effectiveTimezone } from "@/lib/timezone";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// SFT reminder claim protocol (migrations/036). Vercel's own cron docs are
// explicit that (a) an invocation that runs longer than the interval
// between runs can overlap with the next one, and (b) cron delivery is
// best-effort and can occasionally invoke the same scheduled run more than
// once -- so this route must tolerate both without ever double-sending a
// channel that already succeeded, and without ever permanently losing a
// reminder to one failed attempt.
//
// A lease (reminder_24h_claimed_at) plus a per-claim token
// (reminder_24h_claim_token) separate two previously-conflated concerns:
//   - the MUTEX ("is someone already working this row right now") --
//     claimed_at + claim_token, short-lived, never read anywhere else.
//   - the TERMINAL outcome ("has this appointment been fully reminded") --
//     reminder_24h_sent_at, unchanged in meaning from before this protocol,
//     set only once every applicable channel has actually succeeded.
// A claim older than this lease is treated as abandoned: Postgres's own
// row-level locking inside the claim UPDATE below makes "exactly one
// concurrent claimant wins" atomic without any external lock service, and
// the claim_token equality check on every later write to the same row means
// a worker whose lease already expired (and was reclaimed by a newer
// attempt) can never finalize OR release a claim it no longer owns, even if
// its own slow/stale attempt only finishes afterward.
const CLAIM_LEASE_MINUTES = 10;

// The "failed" sentinel is the ONLY provider_id value that means "this
// channel still needs a real attempt" -- a real provider id, and the
// pre-existing "disabled"/"notifications-off" suppression sentinels
// (lib/notify.ts), all already meant "handled, do not retry" before this
// protocol existed, and continue to mean exactly that here.
//
// migrations/037: scoped by the EXACT scheduled occurrence (scheduledFor),
// not just appointment_id + channel + kind. messages_sent rows are never
// deleted, and the same appointment row is reused across reschedules (the
// claim/sent columns reset, but old audit rows stay) -- without this scope,
// an appointment that was ever successfully reminded would be treated as
// "already delivered" forever, even after being rescheduled to a completely
// different date. `.eq("scheduled_for", scheduledFor)` is an ordinary SQL
// `=` comparison, which never matches a NULL on either side -- so historical
// rows written before this migration (scheduled_for IS NULL) are correctly
// never treated as a match for the current occurrence.
async function alreadyDelivered(appointmentId: string, channel: "email" | "sms", scheduledFor: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("messages_sent")
    .select("id")
    .eq("appointment_id", appointmentId)
    .eq("channel", channel)
    .eq("kind", "reminder_24h")
    .eq("scheduled_for", scheduledFor)
    .neq("provider_id", "failed")
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Frees a held claim early (rather than leaving it to expire) when this
// worker decides not to attempt delivery after all -- ownership-checked via
// the same claim_token equality every other write to this row uses, so a
// worker whose lease already expired (and was reclaimed by someone else)
// can never release a claim it no longer owns.
async function releaseClaim(appointmentId: string, workspaceId: string, claimToken: string): Promise<void> {
  await supabaseAdmin
    .from("appointments")
    .update({ reminder_24h_claimed_at: null, reminder_24h_claim_token: null })
    .eq("id", appointmentId)
    .eq("workspace_id", workspaceId)
    .eq("reminder_24h_claim_token", claimToken);
}

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!isAuthorizedCronRequest(authHeader, process.env.CRON_SECRET)) {
      return json({ error: "Unauthorized" }, 401);
    }

    // A pure 23-25-hour absolute lookahead window -- Luxon's hour/minute/
    // second duration units are always exact elapsed time, never
    // calendar/DST-adjusted (unlike "days"/"months"), so which zone `now`
    // is displayed in has zero effect on the resulting UTC instants. The
    // window is therefore correct for every workspace at once, regardless
    // of that workspace's own saved timezone -- no per-workspace zone is
    // (or ever was, despite the old .setZone("America/New_York") here)
    // needed to compute it.
    const now = DateTime.now();
    const start = now.plus({ hours: 23 }).toUTC().toISO();
    const end = now.plus({ hours: 25 }).toUTC().toISO();
    // Numeric bounds for the same window, used by the per-row revalidation
    // below -- comparing resolved instants (via Date.getTime()) rather than
    // raw ISO strings, since Supabase's own "+00:00" suffix and Luxon's
    // ".toISO()" "Z" suffix are not guaranteed to sort identically as plain
    // strings even though they represent the same instants.
    const startMs = new Date(start!).getTime();
    const endMs = new Date(end!).getTime();

    // This single cron run spans every workspace at once — no workspace
    // filter here by design. Each appointment carries its own workspace_id,
    // and every downstream decision (notifications_enabled, the send calls
    // themselves) uses that appointment's own workspace, never a shared
    // default, so one workspace's settings can never leak into another's.
    // Demo appointments are excluded outright — reminders are a real-business
    // action, not something the demo experience needs to simulate.
    const appts = await supabaseAdmin
      .from("appointments")
      .select("id, scheduled_for, service_type, client_id, workspace_id")
      .eq("status", "scheduled")
      .eq("is_demo", false)
      .is("reminder_24h_sent_at", null)
      .gte("scheduled_for", start!)
      .lte("scheduled_for", end!);

    if (appts.error) throw appts.error;

    // Local, single-request cache — avoids re-querying the same workspace's
    // company_settings once per appointment when a cron run covers many
    // appointments for the same business. lib/notify.ts's sendEmail/sendSms
    // still perform their own authoritative notifications_enabled check on
    // every call; this is purely an optimization to skip attempting a send
    // we can already predict will no-op. company_name and timezone are
    // fetched in this same query (rather than a second per-workspace round
    // trip via lib/notify.ts's getCompanyName/getCompanyIdentity) since this
    // route already pays for one company_settings read per workspace here.
    // A single cron run can span many workspaces at once, each with its own
    // saved timezone (Workspace A: America/New_York, Workspace B:
    // America/Los_Angeles) -- this cache keeps each workspace's own
    // resolved zone isolated from every other's, exactly like `enabled`/
    // `companyName` already are.
    const workspaceInfoCache = new Map<string, { enabled: boolean; companyName: string; timezone: string }>();
    async function workspaceInfo(workspaceId: string): Promise<{ enabled: boolean; companyName: string; timezone: string }> {
      const cached = workspaceInfoCache.get(workspaceId);
      if (cached) return cached;
      const { data } = await supabaseAdmin
        .from("company_settings")
        .select("notifications_enabled, company_name, timezone")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      const info = {
        enabled: Boolean(data?.notifications_enabled),
        companyName: sanitizeCompanyName(data?.company_name),
        timezone: effectiveTimezone(data?.timezone),
      };
      workspaceInfoCache.set(workspaceId, info);
      return info;
    }

    // One entitlement check per unique workspace present in this run,
    // cached exactly like workspaceInfo above -- a single cron
    // invocation spans every workspace, so a restricted workspace must never
    // block, slow down, or share a decision with another workspace's
    // reminders. Uses requireCapabilityForWorkspace (never requireCapability
    // with a manufactured session -- this route has no session at all) with
    // the workspace_id already read off the candidate appointment row in the
    // discovery query above -- server-derived, never request input.
    const entitlementCache = new Map<string, boolean>();
    async function workspaceEntitled(workspaceId: string): Promise<boolean> {
      if (entitlementCache.has(workspaceId)) return entitlementCache.get(workspaceId)!;
      const capability = await requireCapabilityForWorkspace(workspaceId, "canSendNotifications");
      entitlementCache.set(workspaceId, capability.allowed);
      return capability.allowed;
    }

    let sent = 0;
    let entitlementSkipped = 0;

    for (const a of appts.data || []) {
      // Checked before the client lookup below (which reads real PII --
      // name/email/phone) so a restricted workspace's data is never touched
      // beyond the minimal id/workspace_id/scheduling fields already read in
      // the discovery query above. No content is constructed, no provider is
      // called, and reminder_24h_sent_at is never updated for a skipped
      // appointment -- it remains eligible to be picked up once the
      // workspace's entitlement is restored (subject to the existing 23-25h
      // window, unchanged).
      if (!(await workspaceEntitled(a.workspace_id))) {
        entitlementSkipped++;
        continue;
      }

      // 1. Atomic claim: the mutex. A conditional UPDATE, not a plain SELECT
      // -- Postgres's own row-level locking means two concurrent executions
      // racing the same row genuinely serialize, and the loser's WHERE
      // re-evaluates against the winner's now-committed, fresh
      // reminder_24h_claimed_at, so it correctly finds zero rows rather than
      // a stale snapshot. The staleness OR-branch is what lets an abandoned
      // claim (crashed process, killed function) become reclaimable again
      // without any explicit "unclaim" step from the worker that died.
      const claimToken = generateClaimToken();
      const leaseThreshold = new Date(Date.now() - CLAIM_LEASE_MINUTES * 60_000).toISOString();
      const claimRes = await supabaseAdmin
        .from("appointments")
        .update({ reminder_24h_claimed_at: new Date().toISOString(), reminder_24h_claim_token: claimToken })
        .eq("id", a.id)
        .eq("workspace_id", a.workspace_id)
        .eq("status", "scheduled")
        .eq("is_demo", false)
        .is("reminder_24h_sent_at", null)
        .gte("scheduled_for", start!)
        .lte("scheduled_for", end!)
        .or(`reminder_24h_claimed_at.is.null,reminder_24h_claimed_at.lt.${leaseThreshold}`)
        .select("id")
        .maybeSingle();
      if (claimRes.error || !claimRes.data) continue; // another execution already holds (or just finished) this claim

      // 2. Revalidate immediately before delivery: the claim's own WHERE
      // only proves eligibility AT THE INSTANT it was written. Nothing else
      // in THIS cron run can touch this row now (any concurrent claim
      // attempt on it will fail the mutex above), but a human action in the
      // dashboard (cancel, reschedule) is not gated by the claim at all and
      // could still land in the narrow gap between claiming and sending.
      // Re-check status/scheduled_for/claim ownership fresh, before any
      // client PII is read or any provider is called -- and release the
      // claim immediately (rather than leaving it to expire) whenever this
      // appointment turns out not to be worth attempting after all, so it
      // becomes retryable sooner than the lease would otherwise allow.
      const freshRes = await supabaseAdmin
        .from("appointments")
        .select("status, is_demo, service_type, scheduled_for, reminder_24h_sent_at, reminder_24h_claim_token")
        .eq("id", a.id)
        .eq("workspace_id", a.workspace_id)
        .maybeSingle();
      if (freshRes.error || !freshRes.data) {
        await releaseClaim(a.id, a.workspace_id, claimToken);
        continue;
      }
      const fresh = freshRes.data;
      const freshScheduledForMs = new Date(fresh.scheduled_for).getTime();
      if (
        fresh.status !== "scheduled" ||
        fresh.is_demo !== false ||
        fresh.reminder_24h_sent_at !== null ||
        fresh.reminder_24h_claim_token !== claimToken ||
        freshScheduledForMs < startMs ||
        freshScheduledForMs > endMs
      ) {
        await releaseClaim(a.id, a.workspace_id, claimToken);
        continue;
      }

      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone, auto_email, auto_sms")
        .eq("id", a.client_id)
        .eq("workspace_id", a.workspace_id)
        .single();

      if (clientRes.error) {
        await releaseClaim(a.id, a.workspace_id, claimToken);
        continue;
      }

      const { name, email, phone, auto_email, auto_sms } = clientRes.data;
      const { enabled: notifying, companyName, timezone } = await workspaceInfo(a.workspace_id);
      // The fresh row's own scheduled_for/service_type -- never the stale
      // discovery-query snapshot (`a`) -- so the message's own content can
      // never describe a schedule the appointment no longer has, even when
      // it changed to a different time that is STILL inside the window.
      const t = reminder24hTemplates(name, fresh.service_type, fresh.scheduled_for, companyName, timezone);

      // 3. Per-channel idempotency: a channel this appointment applies to
      // (opted in, notifications enabled) is "done" once it either doesn't
      // apply at all, or messages_sent already shows a genuine delivery
      // (anything but the "failed" sentinel -- "disabled"/"notifications-off"
      // already counted as handled before this protocol existed, and still
      // do). Checked fresh every time, never cached across appointments, so
      // a channel that succeeded on an earlier attempt (this run or a prior
      // one) is never re-sent just because its sibling channel is failing
      // and triggering a retry pass.
      let emailDone = !(notifying && email && auto_email);
      if (!emailDone) emailDone = await alreadyDelivered(a.id, "email", fresh.scheduled_for);
      if (!emailDone) {
        // Each channel is isolated in its own try/catch — matching the
        // pattern already used in create/update/delete — so one
        // appointment's (or one workspace's) provider failure can never
        // abort the rest of the run.
        try {
          // Deterministic per (appointment, occurrence, channel) --
          // migrations/037: scoped by fresh.scheduled_for, not just the
          // appointment id, so a reschedule always produces a new key
          // instead of colliding with (and being deduped against) the
          // previous occurrence's send within Resend's 24h idempotency-key
          // window. Closes the crash-between-provider-call-and-our-own-write
          // gap for the one channel Resend can dedupe for us: a retried call
          // with this same key returns the original send's result rather
          // than sending a second email. No equivalent exists for sendSms
          // below (Twilio's Messages API has no idempotency-key parameter)
          // -- see this route's own header comment and the design report
          // for why that residual gap is accepted rather than engineered
          // around.
          const providerId = await sendEmail(email, t.email.subject, t.email.body, a.workspace_id, companyName, `reminder_24h:${a.id}:${fresh.scheduled_for}:email`);
          await recordMessageSent({
            appointment_id: a.id,
            channel: "email",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: email,
            body: t.email.body,
            provider_id: providerId,
            scheduled_for: fresh.scheduled_for,
          });
          emailDone = true;
        } catch (err) {
          console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id: a.id,
            channel: "email",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: email,
            body: t.email.body,
            provider_id: "failed",
            scheduled_for: fresh.scheduled_for,
          });
        }
      }

      let smsDone = !(notifying && phone && auto_sms);
      if (!smsDone) smsDone = await alreadyDelivered(a.id, "sms", fresh.scheduled_for);
      if (!smsDone) {
        try {
          const providerId = await sendSms(phone, t.sms, a.workspace_id);
          await recordMessageSent({
            appointment_id: a.id,
            channel: "sms",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: phone,
            body: t.sms,
            provider_id: providerId,
            scheduled_for: fresh.scheduled_for,
          });
          smsDone = true;
        } catch (err) {
          console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id: a.id,
            channel: "sms",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: phone,
            body: t.sms,
            provider_id: "failed",
            scheduled_for: fresh.scheduled_for,
          });
        }
      }

      // 4. Finalize, conditional on actual outcome AND on still owning this
      // claim. Only every applicable channel having genuinely succeeded
      // marks the appointment as fully, permanently reminded -- a partial
      // failure leaves reminder_24h_sent_at untouched, so the next cron run
      // (the lease will have long expired by then) retries only whatever is
      // still outstanding, exactly as long as this appointment remains
      // inside the existing 23-25h window. The claim_token match in the
      // WHERE means a worker whose lease expired and was reclaimed by a
      // newer attempt in the meantime can never finalize here -- but that is
      // never a lost send: the delivery itself (and its messages_sent audit
      // row) already happened above regardless of who owns the row
      // afterward, and whichever attempt DOES still hold the claim will see
      // that success via the same alreadyDelivered() check and finalize it
      // correctly itself.
      if (emailDone && smsDone) {
        const finalizeRes = await supabaseAdmin
          .from("appointments")
          .update({ reminder_24h_sent_at: new Date().toISOString() })
          .eq("id", a.id)
          .eq("workspace_id", a.workspace_id)
          .eq("reminder_24h_claim_token", claimToken)
          .select("id")
          .maybeSingle();
        if (finalizeRes.error || !finalizeRes.data) {
          console.error("CRON_REMINDERS_FINALIZE_OWNERSHIP_LOST", { appointmentId: a.id });
        }
        sent++;
      }
    }

    return json({ ok: true, checked: appts.data?.length || 0, sent, entitlementSkipped });
  } catch (e: any) {
    console.error("CRON_REMINDERS_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
