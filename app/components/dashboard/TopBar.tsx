"use client";

export default function TopBar({
  onGoToday,
  onAdd,
  weekOffset,
  onWeekChange,
}: {
  onGoToday: () => void;
  onAdd: () => void;
  weekOffset: number;
  onWeekChange: (offset: number) => void;
}) {
  return (
    <div className="shrink-0 bg-gradient-to-b from-slate-50 to-slate-100/80 border-b border-slate-200 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        {/* Left: navigation controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onGoToday}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            <span className="text-base leading-none">&#128197;</span>
            Today
          </button>
          <button
            onClick={() => onWeekChange(weekOffset - 1)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            &#8592; Prev
          </button>
          <button
            onClick={() => onWeekChange(weekOffset + 1)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            Next &#8594;
          </button>

          <div className="w-px h-6 bg-slate-300 mx-1" />

          {/* Placeholder icons for future: date picker, view options */}
          <button
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors"
            title="Date picker (coming soon)"
          >
            <span className="text-sm leading-none">&#128198;</span>
          </button>
          <button
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors"
            title="View options (coming soon)"
          >
            <span className="text-sm leading-none">&#9776;</span>
          </button>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={onAdd}
            className="flex items-center gap-1.5 rounded-lg bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            <span className="text-base leading-none">+</span>
            Add Appointment
          </button>

          <div className="relative">
            <input
              type="text"
              placeholder="Search clients..."
              className="rounded-lg border border-slate-300 bg-white pl-3 pr-8 py-2 text-sm text-slate-700 shadow-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 w-[160px] transition-colors"
              readOnly
              title="Search (coming soon)"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">&#128269;</span>
          </div>

          <button
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-700 transition-colors relative"
            title="Notifications (coming soon)"
          >
            <span className="text-sm leading-none">&#128276;</span>
          </button>

          <button
            className="flex items-center justify-center w-9 h-9 rounded-full bg-[#0f172a] text-white text-xs font-semibold shadow-sm hover:bg-slate-800 transition-colors"
            title="Account"
          >
            AW
          </button>
        </div>
      </div>
    </div>
  );
}
