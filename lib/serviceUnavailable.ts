import "server-only";
import { NextResponse } from "next/server";

// Shared by lib/entitlementServer.ts and lib/sessionEpoch.ts (Phase 5.7D) --
// factored out into its own module specifically so the two can both reuse
// this exact denial shape without a circular import between them
// (entitlementServer's requireCapability/requireFullAccess call into
// sessionEpoch's requireCurrentOwnerSession, and sessionEpoch needs this
// same 503 shape for its own transient-query-failure case). Never a
// distinct "read-only"/lifecycle-reason message, and never a raw DB error
// detail -- a transient failure to verify something (entitlement OR
// session identity) is not authoritative evidence of anything and must
// never be presented as one.
export const SERVICE_UNAVAILABLE_BODY = {
  error: "We're having trouble verifying your account right now. Please try again shortly.",
  code: "ENTITLEMENT_SERVICE_UNAVAILABLE",
} as const;

export function serviceUnavailableDenial(): NextResponse {
  return NextResponse.json(SERVICE_UNAVAILABLE_BODY, { status: 503 });
}
