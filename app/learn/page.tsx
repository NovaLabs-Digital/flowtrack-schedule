import type { Metadata } from "next";
import Link from "next/link";
import LearningCenterSearch from "@/app/components/learn/LearningCenterSearch";
import { GUIDES } from "@/lib/learningCenter";

export const metadata: Metadata = {
  title: "Learning Center — Schedule FlowTrack",
  description: "Learn how to use ScheduleFlowTrack with step-by-step guides and short videos.",
};

// Phase 1 Learning Center -- a server component (static content, no session
// or database read needed) that renders the client-side search/browse UI
// (LearningCenterSearch, "use client") below its own nav/hero/footer. Same
// per-page nav+footer pattern app/terms/page.tsx and app/privacy/page.tsx
// already use (no shared public layout exists in this codebase yet -- see
// LearningCenterSearch.ts's own header comment).
export default function LearnPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </Link>
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            ← Back to Home
          </Link>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">ScheduleFlowTrack Learning Center</h1>
          <p className="mt-3 text-sm text-slate-600 leading-relaxed">
            Learn how to use ScheduleFlowTrack with step-by-step guides and short videos.
          </p>
        </div>

        <div className="mt-8">
          <LearningCenterSearch guides={GUIDES} />
        </div>

        <div className="mt-16 text-center text-xs text-slate-500">
          Can&apos;t find what you&apos;re looking for?{" "}
          <Link href="/contact" className="text-blue-700 hover:underline">
            Contact us
          </Link>
          .
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <span>Schedule FlowTrack</span>
          <div className="flex items-center gap-4">
            <Link href="/terms" className="hover:text-slate-700 transition-colors">
              Terms of Service
            </Link>
            <Link href="/privacy" className="hover:text-slate-700 transition-colors">
              Privacy Policy
            </Link>
            <Link href="/contact" className="hover:text-slate-700 transition-colors">
              Contact Us
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
