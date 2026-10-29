// Browser-local public demo: the demo ENTRY gate.
//
// This is NOT authentication. It never touches the network, never calls
// /api/auth/login, and never creates a session or cookie. It only checks that
// the published public demo credentials shown in the "Try the Demo" modal
// (TryDemoButton.tsx) were the ones submitted, before routing the visitor to
// the fully in-browser /demo experience. Real sign-in lives entirely in
// app/api/auth/login/route.ts and is unrelated to this file.
export const DEMO_ENTRY_EMAIL = "demo@scheduleflowtrack.com";
export const DEMO_ENTRY_PASSWORD = "Demo2026!";

export function isValidDemoEntry(email: string, password: string): boolean {
  return email === DEMO_ENTRY_EMAIL && password === DEMO_ENTRY_PASSWORD;
}
