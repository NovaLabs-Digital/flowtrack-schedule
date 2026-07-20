-- 015: Phase 5.1 — billing schema only.
--
-- Creates three new tables (subscriptions, stripe_webhook_events,
-- billing_email_log) and backfills exactly one row: an explicit
-- billing_mode='internal' subscription for the existing original workspace.
--
-- No application code is wired to these tables yet (Phase 5.3+). No
-- existing table, row, policy, grant, or Stripe/Auth object is touched by
-- this migration. RLS is enabled on all three new tables at creation time,
-- with no policies — matching the deny-all-for-anon/authenticated,
-- service-role-only pattern already established and verified for every
-- other business/tenant table (see docs/SECURITY.md, "Database Access &
-- Row Level Security", and migration 014).
--
-- Wrapped in an explicit transaction: unlike prior migrations in this
-- project (which are pure DDL and individually auto-commit per statement),
-- this one includes conditional backfill logic that can legitimately abort
-- partway (see the DO block below). BEGIN/COMMIT here guarantees the new
-- tables and the backfill either both land or neither does — no
-- half-applied state.
--
-- Safely re-runnable: every CREATE TABLE/INDEX uses IF NOT EXISTS, and the
-- backfill DO block checks before writing and never overwrites a mismatch
-- (see below).

BEGIN;

-- =============================================================================
-- subscriptions — one row per real (owner-bearing) workspace. Never a row
-- for the demo workspace: tester-role access is an explicit, auditable
-- bypass in application code (Phase 5.3), not something this table needs
-- to represent. A workspace with NO row here must fail closed to
-- read-only when application code checks entitlement — never silently
-- treated as full access. That invariant is enforced in application code
-- (Phase 5.2+), not by anything in this schema alone, and must be tested
-- explicitly there.
-- =============================================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE RESTRICT,
  billing_mode           text NOT NULL CHECK (billing_mode IN ('internal', 'stripe')),
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_status          text,
  trial_start            timestamptz,
  trial_end              timestamptz,
  current_period_end     timestamptz,
  grace_until            timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  -- Guards against an older Stripe event overwriting newer subscription
  -- state when webhook events are delivered out of order. See the invoice/
  -- subscription-event handling design (Phase 5 corrected design) — this
  -- column is not itself Stripe data, it's our own bookkeeping of "what's
  -- the newest event.created timestamp we've applied so far."
  last_event_created_at  timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- An 'internal' row (Nova Labs' own workspaces, not Stripe-billed) must
  -- never carry any live Stripe/trial/period data — structurally
  -- impossible for an internal workspace to accidentally look
  -- Stripe-billed. A 'stripe' row is intentionally unconstrained here: it
  -- legitimately moves through all-NULL (pending, before checkout) through
  -- every populated lifecycle state without restriction.
  CONSTRAINT subscriptions_internal_mode_has_no_stripe_data CHECK (
    billing_mode != 'internal'
    OR (
      stripe_customer_id IS NULL AND
      stripe_subscription_id IS NULL AND
      stripe_status IS NULL AND
      trial_start IS NULL AND
      trial_end IS NULL AND
      current_period_end IS NULL AND
      grace_until IS NULL AND
      canceled_at IS NULL AND
      last_event_created_at IS NULL
    )
  )
);

-- Prevents two different workspaces from ever sharing the same Stripe
-- customer/subscription. Partial (WHERE ... IS NOT NULL) so any number of
-- still-pending 'stripe' rows can coexist before their first checkout.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer_id
  ON subscriptions(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription_id
  ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
-- No policies — deny-all for anon/authenticated. Business logic reads/
-- writes this table only through the service-role client, exactly like
-- every other table listed in migration 014. Do not add a permissive
-- policy or disable RLS to silence a Supabase dashboard warning.

-- =============================================================================
-- stripe_webhook_events — idempotency/claim ledger for inbound Stripe
-- webhook deliveries. One row per Stripe event id.
--
-- LEASE-OWNERSHIP INVARIANT (read before writing any application code
-- against this table): claim_token is regenerated on every fresh claim and
-- on every reclaim of an expired lease. Every later write this table
-- receives from application code — marking processed_at, releasing a
-- claim after a graceful failure, or reclaiming after a lease timeout —
-- MUST match both the row's key (event_id) AND its CURRENT claim_token in
-- the WHERE clause. A write that matches only event_id (ignoring
-- claim_token) can silently corrupt state from a stale, already-superseded
-- claim attempt. This is the same invariant for billing_email_log below.
-- =============================================================================

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id      text PRIMARY KEY,
  event_type    text NOT NULL,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  -- Nullable: for invoice.* events, workspace_id isn't known at claim time
  -- (invoices don't carry our metadata directly) and is backfilled by a
  -- separate UPDATE once resolved, purely for observability/audit — the
  -- actual subscription mutation is always keyed by stripe_subscription_id
  -- on the subscriptions table, never by this column.
  claim_token   uuid NOT NULL DEFAULT gen_random_uuid(),
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  attempt_count integer NOT NULL DEFAULT 1
);

-- Speeds the lease-reclaim lookup (finding stale, still-unprocessed claims).
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_unprocessed
  ON stripe_webhook_events(claimed_at) WHERE processed_at IS NULL;

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies — deny-all for anon/authenticated, service-role only.

-- =============================================================================
-- billing_email_log — idempotency/claim ledger for owner-facing billing
-- emails (trial-ending, payment-failed), separate from stripe_webhook_events
-- because one Stripe event can in principle need more than one downstream
-- effect tracked independently. Same lease-ownership invariant as above.
-- =============================================================================

CREATE TABLE IF NOT EXISTS billing_email_log (
  stripe_event_id   text NOT NULL REFERENCES stripe_webhook_events(event_id) ON DELETE RESTRICT,
  kind              text NOT NULL CHECK (kind IN ('trial_will_end', 'payment_failed')),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  claim_token       uuid NOT NULL DEFAULT gen_random_uuid(),
  claimed_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  resend_message_id text,
  attempt_count     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (stripe_event_id, kind)
);

-- Speeds the lease-reclaim lookup (finding stale, still-unsent claims).
CREATE INDEX IF NOT EXISTS idx_billing_email_log_unsent
  ON billing_email_log(claimed_at) WHERE sent_at IS NULL;

ALTER TABLE billing_email_log ENABLE ROW LEVEL SECURITY;
-- No policies — deny-all for anon/authenticated, service-role only.

-- =============================================================================
-- Backfill: exactly one subscriptions row, for the existing original
-- workspace only. Defensive — verifies the workspace exists first, and if
-- a subscriptions row already exists for it, verifies that row is exactly
-- the expected internal row before treating the migration as already
-- applied. Never overwrites a mismatch; aborts (and, inside this
-- transaction, rolls back the whole migration) instead.
--
-- The demo workspace is never referenced here and receives no row, by
-- design — see the subscriptions table comment above.
-- =============================================================================

DO $$
DECLARE
  v_workspace_id CONSTANT uuid := 'c6053b32-8c71-498f-8f13-218579805d4d';
  v_workspace_exists boolean;
  v_existing subscriptions%ROWTYPE;
BEGIN
  SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = v_workspace_id) INTO v_workspace_exists;
  IF NOT v_workspace_exists THEN
    RAISE EXCEPTION 'Migration 015 aborted: expected original workspace % not found', v_workspace_id;
  END IF;

  SELECT * INTO v_existing FROM subscriptions WHERE workspace_id = v_workspace_id;

  IF NOT FOUND THEN
    INSERT INTO subscriptions (workspace_id, billing_mode)
    VALUES (v_workspace_id, 'internal');
  ELSIF v_existing.billing_mode IS DISTINCT FROM 'internal'
     OR v_existing.stripe_customer_id IS NOT NULL
     OR v_existing.stripe_subscription_id IS NOT NULL
     OR v_existing.stripe_status IS NOT NULL
     OR v_existing.trial_start IS NOT NULL
     OR v_existing.trial_end IS NOT NULL
     OR v_existing.current_period_end IS NOT NULL
     OR v_existing.grace_until IS NOT NULL
     OR v_existing.cancel_at_period_end IS DISTINCT FROM false
     OR v_existing.canceled_at IS NOT NULL
     OR v_existing.last_event_created_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Migration 015 aborted: existing subscriptions row for workspace % does not match the expected internal row — refusing to overwrite', v_workspace_id;
  END IF;
  -- Else: a prior run of this migration already inserted exactly the
  -- expected internal row (safe re-run) — nothing further to do.
END $$;

COMMIT;
