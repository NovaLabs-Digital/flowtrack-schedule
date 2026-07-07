"use client";

// Shared on/off switch for Settings preference rows. Deliberately dumb —
// caller owns the checked/onChange state so every card can stay on the same
// manual-save pattern (toggling doesn't write anything until Save is clicked).
export default function SettingsToggle({
  checked,
  onChange,
  label,
  helper,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  helper?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div>
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {helper && <div className="text-xs text-slate-500 mt-0.5">{helper}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          "relative w-9 h-5 rounded-full shrink-0 transition-colors disabled:opacity-50",
          checked ? "bg-emerald-500" : "bg-slate-300",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          ].join(" ")}
        />
      </button>
    </div>
  );
}
