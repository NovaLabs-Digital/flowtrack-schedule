import "server-only";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { StripeConfig } from "@/lib/stripe";

// How long an unfinished claim is trusted as "someone else is actively
// processing this" before a fresh delivery is allowed to reclaim it.
//
// This MUST stay longer than the webhook route's maximum possible execution
// duration, or a still-legitimately-running handler could be declared dead
// and reclaimed out from under itself. That route sets
// `export const maxDuration = 30` (app/api/stripe/webhook/route.ts) as an
// explicit, enforced ceiling — Vercel kills the function at 30s regardless
// of what it's doing. LEASE_TIMEOUT_MS (300s) is 10x that ceiling, so a
// handler can never still be genuinely running when its lease is judged
// expired.
export const LEASE_TIMEOUT_MS = 5 * 60 * 1000;

// How long a workspace keeps full access after a payment failure before
// falling back to read-only (see resolveEntitlement's past_due_in_grace
// branch in lib/entitlement.ts).
export const GRACE_PERIOD_DAYS = 3;

export type ClaimResult =
  | { outcome: "claimed"; claimToken: string }
  | { outcome: "already_processed" }
  | { outcome: "claimed_by_other" };

function toIso(unixSeconds: number | null | undefined): string | null {
  return unixSeconds === null || unixSeconds === undefined ? null : new Date(unixSeconds * 1000).toISOString();
}

function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

// checkout.session.completed / customer.subscription.* events carry
// metadata.workspace_id directly (we set it ourselves at Checkout-creation
// time — see app/api/stripe/checkout). invoice.* events don't (Stripe
// invoices don't carry our metadata), so this returns null for those and
// the workspace is resolved later, via a subscriptions lookup keyed by
// stripe_subscription_id, inside the invoice handlers themselves.
export function extractWorkspaceIdHint(event: Stripe.Event): string | null {
  const obj = event.data.object as { metadata?: Stripe.Metadata | null };
  const id = obj?.metadata?.workspace_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// ============================================================================
// Claim / lease primitives for stripe_webhook_events. See migration 015's
// "LEASE-OWNERSHIP INVARIANT" comment: every write below matches BOTH
// event_id AND the current claim_token, so a stale handler (one whose lease
// has since been reclaimed by someone else) can never corrupt a newer
// claimant's in-progress work — its writes simply match zero rows and
// no-op.
// ============================================================================

// Bare INSERT is the atomic claim primitive: event_id's PRIMARY KEY makes
// at most one concurrent insert succeed. The loser (a 23505 unique
// violation) falls through to inspect the winner's row and decide whether
// this delivery is a genuine duplicate (already processed), an in-flight
// duplicate (still within its lease — ask Stripe to retry later), or an
// abandoned claim eligible for reclaim.
export async function claimEvent(event: Stripe.Event, workspaceIdHint: string | null): Promise<ClaimResult> {
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("stripe_webhook_events")
    .insert({ event_id: event.id, event_type: event.type, workspace_id: workspaceIdHint })
    .select("claim_token")
    .maybeSingle();

  if (!insertErr && inserted) {
    return { outcome: "claimed", claimToken: inserted.claim_token };
  }

  if (insertErr && insertErr.code !== "23505") {
    throw insertErr;
  }

  const { data: existing, error: selectErr } = await supabaseAdmin
    .from("stripe_webhook_events")
    .select("claim_token, claimed_at, processed_at, attempt_count")
    .eq("event_id", event.id)
    .maybeSingle();

  if (selectErr) throw selectErr;
  if (!existing) {
    // Deleted between our insert-conflict and this select (a concurrent
    // graceful release) — treat as "try again shortly" rather than racing
    // a second insert in the same request.
    return { outcome: "claimed_by_other" };
  }

  if (existing.processed_at) {
    return { outcome: "already_processed" };
  }

  const leaseAgeMs = Date.now() - new Date(existing.claimed_at).getTime();
  if (leaseAgeMs <= LEASE_TIMEOUT_MS) {
    return { outcome: "claimed_by_other" };
  }

  // Lease expired — reclaim atomically. The WHERE clause requires the
  // claim_token to still match what we just read: if someone else reclaimed
  // (or completed) it between our SELECT and this UPDATE, zero rows match
  // and we correctly fall back to "claimed_by_other" rather than stomping
  // on their claim.
  const newClaimToken = crypto.randomUUID();
  const { data: reclaimed, error: reclaimErr } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({
      claim_token: newClaimToken,
      claimed_at: new Date().toISOString(),
      attempt_count: existing.attempt_count + 1,
    })
    .eq("event_id", event.id)
    .eq("claim_token", existing.claim_token)
    .is("processed_at", null)
    .select("claim_token")
    .maybeSingle();

  if (reclaimErr) throw reclaimErr;
  if (!reclaimed) {
    return { outcome: "claimed_by_other" };
  }
  return { outcome: "claimed", claimToken: reclaimed.claim_token };
}

// Marks an event fully processed. Returns false (a safe no-op, not an
// error) if this claim_token is stale — the lease was reclaimed by someone
// else after this handler started.
export async function completeClaim(eventId: string, claimToken: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("event_id", eventId)
    .eq("claim_token", claimToken)
    .select("event_id")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    console.error("STRIPE_WEBHOOK_STALE_CLAIM_COMPLETE_NOOP");
  }
  return !!data;
}

// Releases a claim after a *graceful* failure (a caught exception — the
// handler is still alive and returning a response right now), distinct
// from a hard crash (which relies on lease-timeout reclaim in claimEvent).
// Deletes the row outright rather than waiting out the lease timeout, so an
// immediate Stripe retry gets a completely fresh claim instead of being
// told "in progress" for up to LEASE_TIMEOUT_MS. Same lease-ownership match
// as every other write here — a stale caller's release cannot delete a
// newer claimant's row.
export async function releaseClaim(eventId: string, claimToken: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .delete()
    .eq("event_id", eventId)
    .eq("claim_token", claimToken);
  if (error) {
    console.error("STRIPE_WEBHOOK_RELEASE_ERROR");
  }
}

// Observability-only (see migration 015): invoice.* events don't carry
// workspace_id at claim time, so it's backfilled here once a handler
// resolves it via the subscriptions table. Never used for authorization or
// any subscription-state decision — purely for later auditing which
// workspace an event belonged to.
export async function backfillEventWorkspace(eventId: string, claimToken: string, workspaceId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({ workspace_id: workspaceId })
    .eq("event_id", eventId)
    .eq("claim_token", claimToken);
  if (error) {
    console.error("STRIPE_WEBHOOK_BACKFILL_WORKSPACE_ERROR");
  }
}

// Re-checks lease ownership immediately before a subscription-state
// mutation (and before any future billing-email side effect). A handler
// only reaches this point after already holding a valid claim, but a
// pathologically slow handler could in principle still be running after
// its lease was judged expired and reclaimed by someone else — this closes
// that gap by refusing to mutate unless our claim_token is still current
// AND unprocessed at the instant just before we write.
//
// This is a check-immediately-before-act guard, not a single atomic
// statement spanning both stripe_webhook_events and subscriptions (Postgres
// via PostgREST has no cross-table transaction available to this schema —
// see the Phase 5.3 review notes for the minimal SECURITY DEFINER RPC that
// would be needed to make it atomic instead of merely immediate). In
// practice the residual gap is not exploitable: a reclaim can only happen
// once leaseAgeMs > LEASE_TIMEOUT_MS is already true, and that can't
// transition from false to true in the sub-millisecond window between this
// check and the write that immediately follows it.
export async function verifyClaimOwnership(eventId: string, claimToken: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .select("event_id")
    .eq("event_id", eventId)
    .eq("claim_token", claimToken)
    .is("processed_at", null)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ============================================================================
// Out-of-order protection for the subscriptions row. PostgREST updates take
// plain values, not SQL expressions, and this schema has no RPC function —
// so rather than a literal SQL GREATEST(), the identical never-moves-
// backward guarantee is enforced with an atomic conditional UPDATE: the
// WHERE clause itself requires the stored last_event_created_at to be
// no newer than this event's timestamp (or absent), so a stale (strictly
// older) event can never overwrite newer state, and there is no
// read-then-write race — the comparison and the write happen in the same
// statement.
//
// Stripe's event.created has only second-level resolution, so two distinct
// events can legitimately share the same timestamp. The guard below uses
// >= (stored <= incoming), not >, specifically so a same-second event is
// never rejected just because the timestamps tie — rejecting it would
// silently drop real state changes (e.g. a payment_failed and a
// payment_succeeded landing in the same second). Writing
// last_event_created_at = incoming on a tie is exactly GREATEST(existing,
// incoming): when they're equal the value doesn't change, and the patch
// still applies.
// ============================================================================

export async function updateSubscriptionIfNewer(
  workspaceId: string,
  eventCreatedIso: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .update({ ...patch, last_event_created_at: eventCreatedIso })
    .eq("workspace_id", workspaceId)
    .or(`last_event_created_at.is.null,last_event_created_at.lte.${eventCreatedIso}`)
    .select("workspace_id")
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ============================================================================
// Phase 5.4B — the reconciliation write path. Deliberately NOT the same
// function as updateSubscriptionIfNewer above, and deliberately does not
// touch last_event_created_at at all. Full reasoning (see the Phase 5.4B
// investigation report for the demonstration this is based on):
//
// A reconciliation read is authoritative live Stripe state, but — unlike a
// webhook — it has no Stripe event.created timestamp of its own. Inventing
// one (e.g. "now," at read or write time) and forcing it through
// updateSubscriptionIfNewer would let reconciliation's own invented
// timestamp incorrectly BLOCK a genuinely newer webhook that arrives
// shortly after: Stripe's event.created has only second-level resolution
// and real delivery latency, so a legitimately newer event's timestamp can
// easily be EARLIER than reconciliation's own wall-clock "now" — exactly
// the scenario reconciliation exists to run into (Stripe's own retry
// backoff after an outage). That would silently drop a real update, which
// is worse than reconciliation doing nothing.
//
// Instead: reconciliation writes are gated by optimistic concurrency
// (compare-and-swap) on the row's last_event_created_at value AS OBSERVED
// AT READ TIME — the WHERE clause requires it to be EXACTLY unchanged since
// reconciliation read it a moment ago. If a webhook lands in that tiny
// window and advances last_event_created_at, this write matches zero rows
// and is safely skipped (reported as "superseded," not a failure) rather
// than overwriting the webhook's newer data. Crucially, the SET clause
// never includes last_event_created_at — a successful reconciliation write
// leaves that column exactly as it was, so it can never affect any future
// webhook's ordering comparison. The only thing to a reconciliation-touched
// row that changes is `updated_at`, which this function uses purely as a
// "last confirmed by reconciliation" bookkeeping marker driving the
// eligibility query in app/api/cron/reconcile-subscriptions — no webhook
// code reads or writes updated_at, so this has zero effect on webhook
// ordering/idempotency/conflict/recovery behavior.
export async function updateSubscriptionIfUnchanged(
  workspaceId: string,
  observedLastEventCreatedAt: string | null,
  patch: Record<string, unknown>
): Promise<boolean> {
  let query = supabaseAdmin
    .from("subscriptions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId);
  query =
    observedLastEventCreatedAt === null
      ? query.is("last_event_created_at", null)
      : query.eq("last_event_created_at", observedLastEventCreatedAt);
  const { data, error } = await query.select("workspace_id").maybeSingle();
  if (error) throw error;
  return !!data;
}

// ============================================================================
// Conflicting-subscription guard. If a workspace already has a live
// subscription (trialing/active/past_due) and a webhook reports a
// *different* subscription id for that workspace, that is evidence of a
// double-subscription scenario (e.g. two completed Checkout Sessions) —
// applying it would silently start tracking the new one while the old one
// keeps billing in the background, unnoticed. This never happens silently:
// it's logged under a fixed, greppable tag and the patch is not applied.
// Replacement is only permitted once the existing subscription has left
// that live set (canceled, unpaid, incomplete_expired, or none yet).
// ============================================================================

const LIVE_BLOCKING_STATUSES = new Set(["trialing", "active", "past_due"]);

export function isBlockingSubscriptionStatus(status: string | null): boolean {
  return !!status && LIVE_BLOCKING_STATUSES.has(status);
}

export function detectSubscriptionConflict(
  currentSubscriptionId: string | null,
  currentStatus: string | null,
  incomingSubscriptionId: string
): boolean {
  if (!currentSubscriptionId) return false;
  if (currentSubscriptionId === incomingSubscriptionId) return false;
  return isBlockingSubscriptionStatus(currentStatus);
}

// ============================================================================
// Event handlers. Each is a safe no-op (logs a fixed tag, returns
// normally — never throws) when it can't resolve a workspace/subscription
// it recognizes, per "unknown workspaces/subscriptions are safely ignored
// and marked processed." Throwing is reserved for genuine infrastructure
// failures (a DB error, a Stripe API error) that should cause the event to
// be retried.
// ============================================================================

// ============================================================================
// Grace-period episode logic (Phase 5.4B). Approved policy: the 3-day grace
// window begins with the FIRST payment failure of a continuous past_due
// episode; repeated failures within that same episode must not extend or
// reset it; any authoritative transition out of past_due clears it
// immediately; a later genuinely new past_due episode may start a fresh one.
//
// The episode boundary is grace_until itself: it is only ever non-null while
// a past_due episode is open (cleared to null the instant status moves away
// from past_due, by the branch below), so "grace_until is currently null"
// and "no past_due episode is open right now" are the same fact. This is
// the ONLY grace calculation in the codebase — both the webhook handlers and
// the Phase 5.4B reconciliation route funnel through this one function via
// buildSubscriptionPatchFromStripeSubscription, so there is exactly one
// interpretation of "does a fresh grace window need to start."
function computeGracePatchField(liveStatus: string, currentGraceUntil: string | null): { grace_until?: string | null } {
  if (liveStatus !== "past_due") {
    // Any authoritative transition out of past_due (recovery to
    // active/trialing, cancellation, pause, etc.) clears grace immediately.
    return { grace_until: null };
  }
  if (currentGraceUntil === null) {
    // No episode currently open — this is the first known past_due signal
    // since grace was last cleared. Start exactly one fresh 3-day window.
    return { grace_until: new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString() };
  }
  if (!isValidDate(new Date(currentGraceUntil))) {
    // Can't confirm whether an episode is genuinely already open. Fail safe
    // by NOT granting a fresh window — leave the malformed value in place
    // (omit grace_until from the patch entirely) so Phase 5.4A's own
    // malformed-state handling (resolveEntitlement) applies instead of this
    // module silently extending access.
    console.error("STRIPE_SYNC_GRACE_UNTIL_MALFORMED");
    return {};
  }
  // A valid grace_until already exists — still the same open episode.
  // Preserve it exactly: omit grace_until from the patch so the stored
  // value is left completely untouched, not extended, not reset.
  return {};
}

export function buildSubscriptionPatchFromStripeSubscription(
  sub: Stripe.Subscription,
  currentGraceUntil: string | null
): Record<string, unknown> {
  const currentPeriodEnd = sub.items?.data?.[0]?.current_period_end ?? null;
  const patch: Record<string, unknown> = {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_status: sub.status,
    trial_start: toIso(sub.trial_start),
    trial_end: toIso(sub.trial_end),
    current_period_end: toIso(currentPeriodEnd),
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: toIso(sub.canceled_at),
  };
  Object.assign(patch, computeGracePatchField(sub.status, currentGraceUntil));
  return patch;
}

export interface WebhookDeps {
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>;
}

function defaultDeps(config: StripeConfig): WebhookDeps {
  return { retrieveSubscription: (id: string) => config.client.subscriptions.retrieve(id) };
}

// checkout.session.completed fate documentation (see also app/api/stripe/checkout):
//   - open:      no event fires; the row stays exactly as Checkout left it
//                (pending, stripe_customer_id set, no subscription yet).
//   - expired:   Stripe auto-expires an unpaid session ~24h later; no event
//                is emitted for this by default and none is handled here —
//                the row remains pending and the owner can simply retry
//                Checkout (the checkout route's own open-session lookup and
//                idempotency key handle generating a fresh session safely —
//                see app/api/stripe/checkout).
//   - completed: handled below. subscription_data.metadata.workspace_id
//                also flows onto the created subscription itself, so every
//                later customer.subscription.* event for it is
//                self-describing too.
//   - canceled:  the owner closing/abandoning Checkout produces no webhook
//                event either; cancel_url only affects what the browser
//                shows, not any DB state.
export async function handleCheckoutSessionCompleted(
  event: Stripe.Event,
  config: StripeConfig,
  claimToken: string,
  deps: WebhookDeps = defaultDeps(config)
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const workspaceId = session.metadata?.workspace_id;
  if (!workspaceId) {
    console.error("STRIPE_WEBHOOK_CHECKOUT_MISSING_WORKSPACE_METADATA");
    return;
  }
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!subscriptionId) {
    console.error("STRIPE_WEBHOOK_CHECKOUT_MISSING_SUBSCRIPTION_ID");
    return;
  }

  const { data: row, error } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, stripe_subscription_id, stripe_status, grace_until")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.error("STRIPE_WEBHOOK_CHECKOUT_UNKNOWN_WORKSPACE");
    return;
  }

  // Never trust the session payload's own snapshot of the subscription —
  // always re-fetch the live object.
  const subscription = await deps.retrieveSubscription(subscriptionId);

  if (detectSubscriptionConflict(row.stripe_subscription_id, row.stripe_status, subscription.id)) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_CONFLICT_REQUIRES_INVESTIGATION");
    return;
  }

  const patch = buildSubscriptionPatchFromStripeSubscription(subscription, row.grace_until);
  if (!(await verifyClaimOwnership(event.id, claimToken))) {
    console.error("STRIPE_WEBHOOK_CLAIM_LOST_BEFORE_MUTATION");
    return;
  }
  await updateSubscriptionIfNewer(workspaceId, toIso(event.created)!, patch);
}

export async function handleSubscriptionUpsert(
  event: Stripe.Event,
  config: StripeConfig,
  claimToken: string,
  deps: WebhookDeps = defaultDeps(config)
): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const workspaceId = sub.metadata?.workspace_id;
  if (!workspaceId) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_MISSING_WORKSPACE_METADATA");
    return;
  }

  const { data: row, error } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, stripe_subscription_id, stripe_status, grace_until")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_UNKNOWN_WORKSPACE");
    return;
  }

  const subscription = await deps.retrieveSubscription(sub.id);

  if (detectSubscriptionConflict(row.stripe_subscription_id, row.stripe_status, subscription.id)) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_CONFLICT_REQUIRES_INVESTIGATION");
    return;
  }

  const patch = buildSubscriptionPatchFromStripeSubscription(subscription, row.grace_until);
  if (!(await verifyClaimOwnership(event.id, claimToken))) {
    console.error("STRIPE_WEBHOOK_CLAIM_LOST_BEFORE_MUTATION");
    return;
  }
  await updateSubscriptionIfNewer(workspaceId, toIso(event.created)!, patch);
}

// Deliberately does NOT re-retrieve from Stripe: a deleted subscription's
// terminal state (status='canceled') is already exactly what the event
// payload carries, and Stripe still lets you retrieve a canceled
// subscription, so a re-fetch would add an API call without changing the
// outcome. The one thing this handler must get right instead is refusing
// to let a deletion for an OLD, already-superseded subscription clobber a
// NEWER one recorded for the same workspace — see the stripe_subscription_id
// match check below, which is a stronger, id-based guarantee than the
// generic last_event_created_at ordering guard alone (that guard protects
// against literal out-of-order delivery; this protects against a deletion
// whose event.created happens to be *newer* than the replacement
// subscription's creation event, which can happen when an old subscription
// is canceled moments after a new one replaces it).
export async function handleSubscriptionDeleted(event: Stripe.Event, claimToken: string): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const workspaceId = sub.metadata?.workspace_id;
  if (!workspaceId) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_DELETE_MISSING_WORKSPACE_METADATA");
    return;
  }

  const { data: row, error } = await supabaseAdmin
    .from("subscriptions")
    .select("stripe_subscription_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_DELETE_UNKNOWN_WORKSPACE");
    return;
  }

  if (row.stripe_subscription_id !== sub.id) {
    console.log("STRIPE_WEBHOOK_SUBSCRIPTION_DELETE_STALE_IGNORED");
    return;
  }

  if (!(await verifyClaimOwnership(event.id, claimToken))) {
    console.error("STRIPE_WEBHOOK_CLAIM_LOST_BEFORE_MUTATION");
    return;
  }
  await updateSubscriptionIfNewer(workspaceId, toIso(event.created)!, {
    stripe_status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: toIso(sub.canceled_at),
    // Deletion is a terminal transition out of past_due (status becomes
    // 'canceled') — the approved grace policy clears grace_until on ANY
    // authoritative transition out of past_due, including this one. Set
    // unconditionally: a deleted subscription can never legitimately still
    // have an open grace episode.
    grace_until: null,
  });
}

function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

// invoice.payment_failed / invoice.payment_succeeded both resolve the
// subscription id off the invoice, then retrieve the authoritative live
// subscription and sync the same full patch every other handler uses —
// status is never inferred from the invoice event type itself, only read
// from what Stripe's subscriptions API reports right now. Grace handling is
// no longer specific to either direction (Phase 5.4B): it's fully embedded
// in buildSubscriptionPatchFromStripeSubscription's episode logic, driven
// entirely by (live status, currently stored grace_until) — so both
// handlers below are now identical thin wrappers, kept as separate exported
// names for API stability rather than collapsed into one.
async function syncSubscriptionFromInvoiceEvent(
  event: Stripe.Event,
  claimToken: string,
  config: StripeConfig,
  deps: WebhookDeps
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const subscriptionId = extractInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    console.log("STRIPE_WEBHOOK_INVOICE_NO_SUBSCRIPTION");
    return;
  }

  const { data: row, error } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, stripe_subscription_id, stripe_status, grace_until")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    console.error("STRIPE_WEBHOOK_INVOICE_UNKNOWN_SUBSCRIPTION");
    return;
  }

  await backfillEventWorkspace(event.id, claimToken, row.workspace_id);

  const subscription = await deps.retrieveSubscription(subscriptionId);

  if (detectSubscriptionConflict(row.stripe_subscription_id, row.stripe_status, subscription.id)) {
    console.error("STRIPE_WEBHOOK_SUBSCRIPTION_CONFLICT_REQUIRES_INVESTIGATION");
    return;
  }

  const patch = buildSubscriptionPatchFromStripeSubscription(subscription, row.grace_until);

  if (!(await verifyClaimOwnership(event.id, claimToken))) {
    console.error("STRIPE_WEBHOOK_CLAIM_LOST_BEFORE_MUTATION");
    return;
  }
  await updateSubscriptionIfNewer(row.workspace_id, toIso(event.created)!, patch);
}

export async function handleInvoicePaymentFailed(
  event: Stripe.Event,
  claimToken: string,
  config: StripeConfig,
  deps: WebhookDeps = defaultDeps(config)
): Promise<void> {
  await syncSubscriptionFromInvoiceEvent(event, claimToken, config, deps);
}

export async function handleInvoicePaymentSucceeded(
  event: Stripe.Event,
  claimToken: string,
  config: StripeConfig,
  deps: WebhookDeps = defaultDeps(config)
): Promise<void> {
  await syncSubscriptionFromInvoiceEvent(event, claimToken, config, deps);
}

// Acknowledged only. The actual owner notification (via billing_email_log)
// is Phase 5.7 — no subscription-state field is affected by this event, so
// there is nothing to write yet. (When that side effect is added, it must
// be gated by the same verifyClaimOwnership check used above — a stale
// claimant must not be allowed to trigger it either.)
export async function handleTrialWillEnd(): Promise<void> {
  console.log("STRIPE_WEBHOOK_TRIAL_WILL_END_ACKNOWLEDGED");
}

export async function processWebhookEvent(event: Stripe.Event, config: StripeConfig, claimToken: string): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(event, config, claimToken);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionUpsert(event, config, claimToken);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event, claimToken);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event, claimToken, config);
    case "invoice.payment_succeeded":
      return handleInvoicePaymentSucceeded(event, claimToken, config);
    case "customer.subscription.trial_will_end":
      return handleTrialWillEnd();
    default:
      // Defensive default: if the Stripe dashboard's endpoint is ever
      // configured to send a broader event set than section 7 lists, an
      // unrecognized type is safely acknowledged rather than retried
      // forever.
      console.log("STRIPE_WEBHOOK_UNHANDLED_EVENT_TYPE");
      return;
  }
}
