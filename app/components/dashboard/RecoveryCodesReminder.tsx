"use client";

import { useEffect, useState } from "react";

// Migration 045: a dismissible reminder for an owner who has two-step sign-in
// on but no recovery codes yet (every owner who set up their authenticator
// before recovery codes existed). It reads only whether codes exist -- codes
// are never shown again after they are created. Real owners only; dismissing
// hides it in this browser (Settings > Sign-in Security keeps saying so).
const dismissKey = (userId: string) => `sft:recovery-codes-reminder-dismissed:${userId}`;

export default function RecoveryCodesReminder({ userId, onOpen }: { userId: string; onOpen: () => void }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(dismissKey(userId)) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed) return;
    let cancelled = false;
    fetch("/api/auth/security", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.status === "on" && data.codesTotal === 0) setShow(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!show) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(dismissKey(userId), "1");
    } catch {
      // Private mode or blocked storage: hidden for now, may show again later.
    }
    setShow(false);
  }

  function open() {
    onOpen();
    // The card appears once Settings has rendered.
    const started = Date.now();
    const scroll = () => {
      const card = document.getElementById("sign-in-security-card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      else if (Date.now() - started < 3000) requestAnimationFrame(scroll);
    };
    requestAnimationFrame(scroll);
  }

  return (
    <div role="status" data-recovery-codes-reminder className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-amber-900">
      <span className="flex-1 min-w-[12rem]">
        Create recovery codes so you can still sign in if you lose your phone.
      </span>
      <button type="button" onClick={open} className="rounded-lg bg-amber-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 transition-colors">
        Open Sign-in Security
      </button>
      <button type="button" onClick={dismiss} className="rounded-lg px-2 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 transition-colors">
        Dismiss
      </button>
    </div>
  );
}
