"use client";

import { useEffect } from "react";
import { useDemoExperienceContext } from "./DemoExperienceProvider";
import { notifyDemoAction } from "./demoExperienceBus";

// Renders the real Mobile Admin (MobileDashboard) inside a same-origin
// iframe, framed like a phone, only during the mobile-experience tour step.
// The iframe shares the tester's existing session cookie automatically
// (same origin — no second login), so this is the actual mobile app, not a
// shrunk-down copy of the desktop UI.
export default function MobileExperiencePreview() {
  const { active, currentStep } = useDemoExperienceContext();
  const show = active && currentStep?.id === "mobile-experience";

  useEffect(() => {
    if (!show) return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "sft-mobile-tab-changed") {
        notifyDemoAction("open-mobile-tab");
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [show]);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center pointer-events-none">
      <div
        data-tour="mobile-preview"
        className="relative pointer-events-auto rounded-[2.5rem] border-[10px] border-slate-900 bg-slate-900 shadow-2xl"
        style={{ width: 340, height: 700 }}
      >
        <div className="absolute left-1/2 top-0 -translate-x-1/2 w-28 h-5 bg-slate-900 rounded-b-2xl z-10" />
        <iframe
          key="mobile-preview-frame"
          src="/dashboard"
          title="Mobile Admin preview"
          className="w-full h-full rounded-[2rem] bg-white"
          style={{ border: "none" }}
        />
      </div>
    </div>
  );
}
