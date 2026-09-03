// Public, non-secret display values for ScheduleFlowTrack Pro's price and
// trial length, used on marketing/signup pages before checkout. Distinct
// from the real Stripe Price ID (lib/stripe.ts, server-only, never exposed
// client-side) -- this is only the human-readable price shown to visitors.
export const SUBSCRIPTION_PRICE_DISPLAY = "$24.99";
export const SUBSCRIPTION_TRIAL_DAYS = 30;
