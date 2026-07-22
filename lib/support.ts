// Canonical, reusable customer-support destination. This is the ONE place
// the support address exists as a literal — every future UI component
// (the Phase 5.5D billing banner, and any later surface that needs a
// "contact support" action) must import from here rather than repeat the
// address inline. Deliberately not process.env: this is a fixed, public,
// non-secret product address, not configuration that varies by
// environment or deployment -- an environment variable would be the wrong
// tool for a constant that never changes between local/preview/production.
//
// No API call, no network request, no form, no database table: a mailto:
// link is the entire mechanism. Nothing here reads or references any
// workspace, session, subscription, billing, or entitlement data, so
// importing this module can never expose or leak any of that -- it has
// exactly one job, and no side effects.
export const SUPPORT_EMAIL = "support@scheduleflowtrack.com";

// A bare mailto: link with no subject/body/query string. Deliberately not
// pre-filled with any context (workspace name, billing state, account
// identifiers, etc.) -- prefilling would mean this module would need to
// accept exactly the kind of sensitive input it exists to avoid handling.
export const SUPPORT_MAILTO_URL = `mailto:${SUPPORT_EMAIL}`;
