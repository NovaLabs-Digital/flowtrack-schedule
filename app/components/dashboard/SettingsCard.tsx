"use client";

// Shared card shell for the Settings page — one card answers one question
// about the business ("who are we", "how do clients reach us", ...).
// Kept intentionally small: title/helper header, a body slot, and an
// optional footer (typically Save/Cancel + a dirty-state hint).
export default function SettingsCard({
  id,
  title,
  badge,
  helper,
  headerRight,
  footer,
  children,
}: {
  id?: string;
  title: string;
  badge?: React.ReactNode;
  helper?: string;
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden scroll-mt-4">
      <div className="p-6 pb-0 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-slate-900">{title}</div>
            {badge}
          </div>
          {helper && <div className="mt-1 text-xs text-slate-500">{helper}</div>}
        </div>
        {headerRight}
      </div>
      <div className="p-6 space-y-4">{children}</div>
      {footer && (
        <div className="flex items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 bg-slate-50/60">
          {footer}
        </div>
      )}
    </div>
  );
}

// Small honest marker for cards whose fields are interactive but not yet
// wired to persistence (Company/Communication Preferences, Subscription) —
// preferred over a dashed "coming soon" box when we want the card to still
// visually match a fully-designed reference, just clearly labeled.
export function PreviewPill() {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
      Preview
    </span>
  );
}

// Small "N unsaved changes" affordance shared by every editable card's footer.
export function DirtyHint({ dirty }: { dirty: boolean }) {
  if (!dirty) return <span className="text-xs text-slate-400">Up to date</span>;
  return (
    <span className="flex items-center gap-1.5 text-xs text-amber-700">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      Unsaved changes
    </span>
  );
}

// The dashed "coming soon" workspace already used elsewhere in Settings
// (see SettingsPanel's PLACEHOLDERS) — reused here so cards without real
// backend data yet look intentional, not broken.
export function ComingSoonNotice({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
      <div className="text-xs text-slate-400">{text}</div>
    </div>
  );
}
