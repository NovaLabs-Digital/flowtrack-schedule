import type { Metadata } from "next";
import HostClient from "./HostClient";

// Start page for the Guided Demo Session host (Alberto). Who may host is
// enforced by the session API, not by this page.
export const metadata: Metadata = {
  title: "Guided Demo Session — ScheduleFlowTrack",
  robots: { index: false, follow: false },
};

export default function GuidedDemoHostPage() {
  return <HostClient />;
}
