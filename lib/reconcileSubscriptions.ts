import "server-only";
import type Stripe from "stripe";
import { safeEqual } from "@/lib/safeEqual";
import { DEMO_WORKSPACE_ID } from "@/lib/workspace";
import { buildSubscriptionPatchFromStripeSubscription } from "@/lib/stripeWebhook";

// Phase 5.4B — core reconciliation logic, split out from the route (which
// only does auth + the DB query + wiring) so this is unit-testable with
// fake deps the same way lib/stripeWebhook.ts's WebhookDeps makes the
// webhook handlers testable without a live Stripe/Supabase connection.

// A row is eligible once it's gone this long without being confirmed by
// EITHER a webhook or a prior reconciliation run. Deliberately not tied to
// Stripe's own ~3-day webhook retry window — reconciliation re-fetching
// live state mid-retry is harmless (see updateSubscriptionIfUnchanged's own
// doc comment), so there's no correctness reason to wait that long. 24h is
// long enough that a healthy, quiet subscription (which can legitimately go
// weeks between real Stripe events) isn't re-checked constantly, short
// enough that a genuinely missed webhook is caught within about a day once
// this route is scheduled externally (not done in this phase).
export const RECONCILE_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

// Conservative per-run cap: bounds both the number of Stripe API calls and
// the DB work per invocation. Ordering the eligibility query by `updated_at`
// ascending (oldest-unconfirmed-first) means repeated runs fairly cycle
// through a larger backlog instead of one batch of stale rows crowding out
// the rest forever.
export const RECONCILE_BATCH_LIMIT = 25;

export function isAuthorizedCronRequest(secretParam: string | null, envSecret: string | undefined): boolean {
  if (!secretParam || !envSecret) return false;
  return safeEqual(secretParam, envSecret);
}

export interface ReconcileRow {
  workspace_id: string;
  billing_mode: string;
  stripe_subscription_id: string | null;
  grace_until: string | null;
  last_event_created_at: string | null;
}

export interface ReconcileDeps {
  retrieveSubscription: (id: string) => Promise<Stripe.Subscription>;
  // Matches lib/stripeWebhook.ts's updateSubscriptionIfUnchanged signature
  // exactly — see that function's doc comment for why reconciliation writes
  // never go through updateSubscriptionIfNewer / never invent an
  // event.created-equivalent timestamp.
  applyPatch: (workspaceId: string, observedLastEventCreatedAt: string | null, patch: Record<string, unknown>) => Promise<boolean>;
}

export interface ReconcileResult {
  processed: number;
  synchronized: number;
  skipped: number;
  failed: number;
}

// Processes exactly the rows it's given — no additional querying, paging,
// or expansion happens in here. The caller (the route) is solely
// responsible for bounding how many rows this ever sees per invocation
// (RECONCILE_BATCH_LIMIT via the DB query's .limit()), and for excluding
// non-Stripe-billed rows at the query level (.eq("billing_mode", "stripe"));
// the per-row checks below are a second, defense-in-depth layer, not the
// only protection.
//
// One row's failure (a thrown Stripe/DB error) is caught locally and
// counted, never allowed to abort the loop — every remaining eligible row
// in the batch still gets a chance to process.
export async function reconcileRows(rows: ReconcileRow[], deps: ReconcileDeps): Promise<ReconcileResult> {
  let processed = 0;
  let synchronized = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    processed++;
    try {
      // Defense-in-depth: the eligibility query already filters to
      // billing_mode = 'stripe' and the demo workspace never has a row at
      // all, so neither branch below should ever actually trigger — but a
      // function that trusts its caller unconditionally is exactly how
      // "reconcile the wrong workspace" bugs happen (same philosophy as
      // lib/entitlement.ts's own defensive billing_mode check).
      if (row.billing_mode !== "stripe" || row.workspace_id === DEMO_WORKSPACE_ID) {
        console.error("STRIPE_RECONCILE_INELIGIBLE_ROW_SKIPPED");
        skipped++;
        continue;
      }

      if (!row.stripe_subscription_id) {
        // Nothing to reconcile against yet (e.g. a claimed-but-never-
        // completed checkout). No Stripe call, no patch — just mark this
        // row as checked so it doesn't monopolize every future batch ahead
        // of rows that actually need work.
        await deps.applyPatch(row.workspace_id, row.last_event_created_at, {});
        skipped++;
        continue;
      }

      let liveSubscription: Stripe.Subscription;
      try {
        liveSubscription = await deps.retrieveSubscription(row.stripe_subscription_id);
      } catch {
        // Fixed tag only — never the caught error's own message (could
        // contain request details). Deliberately does NOT mark this row as
        // checked (no applyPatch call), so it remains the most-stale row
        // and is retried on the very next run rather than waiting a full
        // threshold period again.
        console.error("STRIPE_RECONCILE_STRIPE_FETCH_ERROR");
        failed++;
        continue;
      }

      if (liveSubscription.id !== row.stripe_subscription_id) {
        // Structurally shouldn't happen (Stripe returns the object you
        // retrieved by id) — defensive parity with handleSubscriptionDeleted's
        // own id-match guard. Fail safe: don't write anything.
        console.error("STRIPE_RECONCILE_SUBSCRIPTION_ID_MISMATCH");
        skipped++;
        continue;
      }

      // Same canonical patch logic every webhook handler uses — including
      // the grace-episode decision (Phase 5.4B) — so reconciliation can
      // never produce a second interpretation of what a given Stripe status
      // means.
      const patch = buildSubscriptionPatchFromStripeSubscription(liveSubscription, row.grace_until);
      const applied = await deps.applyPatch(row.workspace_id, row.last_event_created_at, patch);
      if (applied) {
        synchronized++;
      } else {
        // The compare-and-swap in applyPatch matched zero rows — a webhook
        // updated this row's last_event_created_at between our read and our
        // write. Not a failure: the webhook's newer data already won, which
        // is exactly the intended outcome.
        console.log("STRIPE_RECONCILE_SUPERSEDED_BY_CONCURRENT_WEBHOOK");
        skipped++;
      }
    } catch {
      console.error("STRIPE_RECONCILE_ROW_ERROR");
      failed++;
    }
  }

  return { processed, synchronized, skipped, failed };
}
