import "server-only";
import type Stripe from "stripe";
import {
  buildSubscriptionPatchFromStripeSubscription,
  computeTrialConsumedPatchField,
  computeAccessEndedPatchField,
} from "@/lib/stripeWebhook";

// Phase 5.6D — the application-controlled "cancel my trial right now" flow.
// Exists because the approved policy requires trial cancellation to be
// IMMEDIATE, while paid cancellation must remain effective at the end of the
// billing period -- a distinction the Stripe Customer Portal's own
// Dashboard-configured cancellation behavior cannot be relied on to apply
// correctly (it is one uniform setting, external to this repository). This
// module owns only the trial-immediate-cancel path; the existing Customer
// Portal (app/api/stripe/portal/route.ts) is left completely unchanged and
// remains the correct surface for a paid subscription's cancel-at-period-end
// flow.
//
// Deliberately mirrors lib/reconcileSubscriptions.ts's own shape: this is
// NOT a genuine Stripe webhook event (no event.created of its own), so it
// reuses the exact same shared patch-building helpers
// (buildSubscriptionPatchFromStripeSubscription /
// computeTrialConsumedPatchField / computeAccessEndedPatchField) and the
// exact same compare-and-swap write primitive (updateSubscriptionIfUnchanged,
// injected as `applyPatch` below) that reconciliation already uses for the
// identical "trusted server write, no real webhook event" situation -- see
// lib/stripeWebhook.ts's own extensive comment on why a synthetic
// last_event_created_at must never be invented and forced through
// updateSubscriptionIfNewer instead. This is a deliberate reuse of the
// existing trusted subscription lifecycle, not a second, divergent
// persistence path.

export interface TrialCancelSubscriptionRow {
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  grace_until: string | null;
  trial_consumed_at: string | null;
  access_ended_at: string | null;
  last_event_created_at: string | null;
}

export interface TrialCancelDeps {
  cancelSubscription: (id: string) => Promise<Stripe.Subscription>;
  applyPatch: (workspaceId: string, observedLastEventCreatedAt: string | null, patch: Record<string, unknown>) => Promise<boolean>;
  // Injectable purely for testability, same pattern as ReconcileDeps.now --
  // every real caller omits this and gets the true wall clock.
  now?: () => Date;
}

export type TrialCancelOutcome =
  | { outcome: "canceled" }
  // The cancellation genuinely happened at Stripe (irreversible from here)
  // but this request lost a compare-and-swap race against a concurrent
  // webhook/reconciliation write. Not a failure to report to the owner --
  // the eventual webhook for this same cancellation persists the identical
  // terminal state, so the workspace still ends up correctly locked.
  | { outcome: "conflict" }
  // row.stripe_status is not "trialing" -- the caller is asked to use the
  // existing billing portal instead. Also covers "already canceled" from a
  // repeated click after the first one already succeeded and was persisted.
  | { outcome: "not_trialing" }
  // row.stripe_status is "trialing" but there is no stripe_subscription_id
  // to act on -- an inconsistent row this function refuses to guess about.
  | { outcome: "no_subscription" };

// Only ever acts on a subscription this workspace's OWN stored row reports
// as currently "trialing" -- the caller is responsible for resolving `row`
// from the authenticated session's own workspaceId (see
// app/api/stripe/cancel-trial/route.ts), never from any client-supplied
// value. Idempotent in practice: a second call after the first succeeded
// sees stripe_status no longer "trialing" (already "canceled" from the first
// call's own write, or from the webhook that followed it) and returns
// "not_trialing" without calling Stripe a second time through this path --
// the caller's own Stripe idempotency key (see the route) additionally
// protects the narrow window where two requests both read "trialing" before
// either write lands.
export async function cancelTrialSubscription(
  row: TrialCancelSubscriptionRow,
  workspaceId: string,
  deps: TrialCancelDeps
): Promise<TrialCancelOutcome> {
  if (row.stripe_status !== "trialing") {
    return { outcome: "not_trialing" };
  }
  if (!row.stripe_subscription_id) {
    return { outcome: "no_subscription" };
  }

  // Cancels immediately (Stripe's DELETE /v1/subscriptions/{id}) -- never
  // cancel_at_period_end. Never touches the Stripe customer object, never
  // touches any business-data table.
  const canceled = await deps.cancelSubscription(row.stripe_subscription_id);

  const basePatch = buildSubscriptionPatchFromStripeSubscription(canceled, row.grace_until);
  const observedAtIso = (deps.now ?? (() => new Date()))().toISOString();
  const patch = {
    ...basePatch,
    // trial_consumed_at is first-write-wins and was already set the moment
    // this trial began (checkout.session.completed) -- this call can only
    // ever leave it exactly as it was, never clear or move it, so no second
    // trial is ever possible for this workspace.
    ...computeTrialConsumedPatchField(canceled, row.trial_consumed_at),
    ...computeAccessEndedPatchField(canceled.status, row.access_ended_at, observedAtIso),
  };

  const applied = await deps.applyPatch(workspaceId, row.last_event_created_at, patch);
  return applied ? { outcome: "canceled" } : { outcome: "conflict" };
}
