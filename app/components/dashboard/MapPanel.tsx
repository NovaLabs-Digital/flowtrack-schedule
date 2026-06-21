"use client";

export default function MapPanel() {
  return (
    <div className="flex flex-col h-full rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-semibold text-slate-900">Map / GPS</div>
        <div className="text-xs text-slate-500">Route planning</div>
      </div>

      <div className="flex-1 relative bg-[#e8f0e8]">
        {/* Placeholder map background */}
        <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="none" viewBox="0 0 300 600">
          <rect fill="#e5eedf" width="300" height="600" />
          <path d="M0 100 L80 80 L80 600" fill="none" stroke="#c8d8c0" strokeWidth="3" />
          <path d="M80 200 L200 200" fill="none" stroke="#c8d8c0" strokeWidth="2" />
          <path d="M80 350 L250 350" fill="none" stroke="#c8d8c0" strokeWidth="2" />
          <path d="M150 0 L150 200" fill="none" stroke="#d0dcc8" strokeWidth="2" />
          <path d="M200 200 L200 600" fill="none" stroke="#c8d8c0" strokeWidth="3" />
          <path d="M0 450 L300 450" fill="none" stroke="#d0dcc8" strokeWidth="2" />
          <rect x="85" y="100" width="60" height="95" rx="2" fill="#d8e4d0" />
          <rect x="205" y="210" width="50" height="135" rx="2" fill="#d8e4d0" />
          <rect x="85" y="360" width="110" height="85" rx="2" fill="#d8e4d0" />
          <rect x="205" y="460" width="70" height="80" rx="2" fill="#d8e4d0" />
        </svg>

        {/* Map pin */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="w-8 h-8 rounded-full bg-blue-600 border-3 border-white shadow-lg flex items-center justify-center">
            <div className="w-2.5 h-2.5 rounded-full bg-white" />
          </div>
        </div>

        {/* Zoom controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-1">
          <button className="w-8 h-8 rounded-lg bg-white border border-slate-300 shadow-sm flex items-center justify-center text-slate-600 hover:bg-slate-50 text-lg leading-none">
            +
          </button>
          <button className="w-8 h-8 rounded-lg bg-white border border-slate-300 shadow-sm flex items-center justify-center text-slate-600 hover:bg-slate-50 text-lg leading-none">
            &#8722;
          </button>
        </div>
      </div>
    </div>
  );
}
