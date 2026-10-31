import type { Metadata } from "next";
import SessionClient from "./SessionClient";

// Guided Demo Session. Access is decided by the session API on every call
// (host: owner session + DEMO_HOST_AUTH_USER_ID; visitor: invitation
// cookie), so this page itself carries no data and needs no server checks.
export const metadata: Metadata = {
  title: "Guided Demo Session — ScheduleFlowTrack",
  robots: { index: false, follow: false },
};

export default function GuidedDemoSessionPage() {
  return <SessionClient />;
}
