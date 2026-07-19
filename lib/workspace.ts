// Fixed workspace IDs from the Phase 1 tenant-foundation migration. There is
// no lookup for these — every business row in the database was backfilled to
// exactly one of these two, and every session now carries one of them too.
// Phase 3+ (real multi-tenant signup) will replace fixed constants like this
// with a real resolution step; until then, every route in the app resolves
// to one of these two values, never anything else.
export const REAL_WORKSPACE_ID = "c6053b32-8c71-498f-8f13-218579805d4d";
export const DEMO_WORKSPACE_ID = "e3e8f3a7-c114-4d4c-9f15-590188a654b6";
