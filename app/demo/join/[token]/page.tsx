import type { Metadata } from "next";
import JoinClient from "./JoinClient";

// A visitor joins a Guided Demo Session with the host's invitation link. No
// account is needed; the invitation is checked (single use, 30 minutes,
// live session) when they press Join.
export const metadata: Metadata = {
  title: "Join a Guided Demo — ScheduleFlowTrack",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function JoinGuidedDemoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinClient token={token} />;
}
