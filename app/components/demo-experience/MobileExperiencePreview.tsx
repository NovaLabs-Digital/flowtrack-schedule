"use client";

import { useEffect, useState } from "react";
import { useDemoExperienceContext } from "./DemoExperienceProvider";
import { notifyDemoAction } from "./demoExperienceBus";

// Renders the real Mobile Admin (MobileDashboard) inside a same-origin
// iframe, framed like a phone, only during the mobile-experience tour step.
//
// Real shared-backend tester session (isLocalDemo false, the default): the
// iframe loads /dashboard, sharing the tester's existing session cookie
// automatically (same origin — no second login) — unchanged behavior.
//
// Browser-local public demo (isLocalDemo true): there is no session cookie
// at all (by design — see app/demo/page.tsx), so an iframe pointed at
// /dashboard hits middleware.ts's auth gate and redirects to /login instead
// of showing the mobile app — a real bug found live. The iframe loads /demo
// instead, which needs no cookie; sessionStorage (where the fixture lives)
// is shared with the parent tab for a same-origin, same-tab iframe, so the
// iframe picks up the exact same fictional data already on screen, and its
// own module-scope `installDemoFetchInterceptor()`/`initStore()` calls
// (app/demo/DemoPageClient.tsx) run again in the iframe's own separate JS
// realm, exactly as they do on first load of /demo itself.
const PHONE_WIDTH = 340;
const PHONE_HEIGHT = 700;

// The phone keeps its real size, scaled down only when the window is too
// short (a small laptop, or browser zoom) so its bottom bar stays on screen.
function phoneScale(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(1, (window.innerHeight - 32) / PHONE_HEIGHT, (window.innerWidth - 32) / PHONE_WIDTH);
}

// The step asks for Schedule or Clients; other tabs still work but don't complete it.
const STEP_TABS = new Set(["schedule", "clients"]);

export default function MobileExperiencePreview({ isLocalDemo = false }: { isLocalDemo?: boolean }) {
  const { active, currentStep } = useDemoExperienceContext();
  const show = active && currentStep?.id === "mobile-experience";
  const [scale, setScale] = useState(phoneScale);

  useEffect(() => {
    if (!show) return;
    const onResize = () => setScale(phoneScale());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [show]);

  useEffect(() => {
    if (!show) return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "sft-mobile-tab-changed") {
        notifyDemoAction(STEP_TABS.has(event.data.tab) ? "open-mobile-tab" : "open-mobile-other-tab");
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
        style={{ width: PHONE_WIDTH, height: PHONE_HEIGHT, transform: scale < 1 ? `scale(${scale})` : undefined }}
      >
        <div className="absolute left-1/2 top-0 -translate-x-1/2 w-28 h-5 bg-slate-900 rounded-b-2xl z-10" />
        <iframe
          key="mobile-preview-frame"
          src={isLocalDemo ? "/demo" : "/dashboard"}
          title="Mobile Admin preview"
          className="w-full h-full rounded-[2rem] bg-white"
          style={{ border: "none" }}
        />
      </div>
    </div>
  );
}
