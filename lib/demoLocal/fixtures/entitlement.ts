// Browser-local public demo: the fixed entitlement the local demo passes to
// DashboardShell in place of a server-resolved one.
//
// Mirrors exactly what the real app resolves for the demo workspace today:
// lib/entitlement.ts's resolveWorkspaceEntitlement short-circuits the demo
// workspace to buildResult("demo", "demo_workspace", FULL_CAPABILITIES), and
// lib/entitlementView.ts's projectEntitlementForOwner maps state "demo" to
// bannerVariant "none" / recoveryAction null, with isTrialing false and both
// date fields null (neither is needed by a "none" banner). Full capabilities,
// no billing banner, no recovery action.
//
// Type-only import: lib/entitlementView.ts is `import "server-only"`, so a
// value import would break the client bundle -- `import type` is erased.
import type { EntitlementView } from "@/lib/entitlementView";

export const DEMO_ENTITLEMENT: EntitlementView = Object.freeze({
  canMutateOperationalData: true,
  canUseJobTracking: true,
  canSendNotifications: true,
  isTrialing: false,
  bannerVariant: "none",
  recoveryAction: null,
  finalAccessDate: null,
  readOnlyEndsAt: null,
}) as EntitlementView;
