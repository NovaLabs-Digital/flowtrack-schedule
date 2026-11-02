"use client";

import { useState } from "react";

// Shown exactly once, right after new recovery codes are created (two-step
// sign-in turned on, a first or replacement authenticator set up, or new
// codes requested). The codes exist only in this page's memory: they are
// never stored in the browser, and the server keeps only their hashes.
export default function RecoveryCodesNotice({ codes, destination }: { codes: string[]; destination: string }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([`Schedule FlowTrack recovery codes\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "schedule-flowtrack-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="text-center mb-4">
        <h1 className="text-lg font-semibold text-slate-900">Save your recovery codes</h1>
        <p className="mt-1 text-xs text-slate-500">
          If you lose your authenticator, one of these codes and your password let you set up a new one. Each code works
          once. This is the only time they are shown.
        </p>
      </div>
      <ul className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="text-center">
            {c}
          </li>
        ))}
      </ul>
      <div className="mb-4 flex gap-2">
        <button type="button" onClick={copy} className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
          {copied ? "Copied" : "Copy codes"}
        </button>
        <button type="button" onClick={download} className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
          Download
        </button>
      </div>
      <label className="mb-4 flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I&apos;ve saved these codes somewhere safe</span>
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={() => window.location.assign(destination)}
        className="w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
      >
        Continue
      </button>
    </div>
  );
}
