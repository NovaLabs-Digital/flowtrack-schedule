import type { Metadata } from "next";
import DemoPageClient from "@/app/demo/DemoPageClient";

// This repo enforces exactly one layout.tsx under app/ (app/layout.test.ts),
// so the route's no-index metadata can't live in a second layout.tsx the way
// an earlier draft of this route did -- it lives here instead. This thin
// server wrapper is the one deliberate exception to "no server code in the
// /demo route": it exports metadata and renders the real client page, and
// does nothing else -- no session, no Supabase, no data of any kind.
export const metadata: Metadata = {
  title: "Demo — Schedule FlowTrack",
  description: "Interactive ScheduleFlowTrack demo with a fictional business. Runs entirely in your browser.",
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return <DemoPageClient />;
}
