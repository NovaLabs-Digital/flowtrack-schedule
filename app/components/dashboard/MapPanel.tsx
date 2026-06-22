"use client";

export default function MapPanel() {
  return (
    <div className="flex flex-col h-full rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-semibold text-slate-900">Map / GPS</div>
        <div className="text-xs text-slate-500">Route planning</div>
      </div>

      <div className="flex-1 relative bg-[#eaf0e6] overflow-hidden">
        <svg className="absolute inset-0 w-full h-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 900">
          {/* Base */}
          <rect fill="#eaf0e6" width="400" height="900" />

          {/* Water feature (lake/pond) */}
          <ellipse cx="340" cy="120" rx="70" ry="45" fill="#c5dce8" />
          <ellipse cx="345" cy="118" rx="55" ry="35" fill="#d0e4ef" />

          {/* Park area */}
          <rect x="10" y="680" width="120" height="90" rx="12" fill="#c8ddb8" />
          <circle cx="40" cy="710" r="10" fill="#b4d0a0" />
          <circle cx="70" cy="720" r="14" fill="#a8c894" />
          <circle cx="100" cy="705" r="11" fill="#b4d0a0" />
          <circle cx="55" cy="745" r="9" fill="#a8c894" />

          {/* Major roads */}
          <rect x="0" y="170" width="400" height="8" fill="#f5f0e8" />
          <rect x="0" y="370" width="400" height="8" fill="#f5f0e8" />
          <rect x="0" y="560" width="400" height="8" fill="#f5f0e8" />
          <rect x="0" y="780" width="400" height="6" fill="#f5f0e8" />
          <rect x="135" y="0" width="8" height="900" fill="#f5f0e8" />
          <rect x="265" y="0" width="8" height="900" fill="#f5f0e8" />

          {/* Minor streets */}
          <rect x="0" y="80" width="400" height="3" fill="#e2e0d8" />
          <rect x="0" y="270" width="400" height="3" fill="#e2e0d8" />
          <rect x="0" y="470" width="400" height="3" fill="#e2e0d8" />
          <rect x="0" y="650" width="400" height="3" fill="#e2e0d8" />
          <rect x="0" y="850" width="400" height="3" fill="#e2e0d8" />
          <rect x="60" y="0" width="3" height="900" fill="#e2e0d8" />
          <rect x="200" y="0" width="3" height="900" fill="#e2e0d8" />
          <rect x="340" y="170" width="3" height="730" fill="#e2e0d8" />

          {/* Blocks - row 1 */}
          <rect x="8" y="8" width="48" height="68" rx="3" fill="#dde6d6" />
          <rect x="67" y="8" width="64" height="68" rx="3" fill="#d8e2d0" />
          <rect x="147" y="8" width="50" height="68" rx="3" fill="#dde6d6" />
          <rect x="207" y="8" width="54" height="68" rx="3" fill="#d5dece" />

          {/* Blocks - row 2 */}
          <rect x="8" y="87" width="48" height="78" rx="3" fill="#d5dece" />
          <rect x="67" y="87" width="64" height="78" rx="3" fill="#dde6d6" />
          <rect x="147" y="87" width="50" height="78" rx="3" fill="#d8e2d0" />
          <rect x="207" y="87" width="54" height="78" rx="3" fill="#dde6d6" />

          {/* Blocks - row 3 */}
          <rect x="8" y="182" width="48" height="84" rx="3" fill="#dde6d6" />
          <rect x="67" y="182" width="64" height="84" rx="3" fill="#d5dece" />
          <rect x="147" y="182" width="50" height="84" rx="3" fill="#dde6d6" />
          <rect x="207" y="182" width="54" height="84" rx="3" fill="#d8e2d0" />
          <rect x="277" y="182" width="58" height="84" rx="3" fill="#dde6d6" />
          <rect x="347" y="182" width="45" height="84" rx="3" fill="#d5dece" />

          {/* Blocks - row 4 */}
          <rect x="8" y="277" width="48" height="88" rx="3" fill="#d8e2d0" />
          <rect x="67" y="277" width="64" height="88" rx="3" fill="#dde6d6" />
          <rect x="147" y="277" width="50" height="88" rx="3" fill="#d5dece" />
          <rect x="207" y="277" width="54" height="88" rx="3" fill="#dde6d6" />
          <rect x="277" y="277" width="58" height="88" rx="3" fill="#d8e2d0" />
          <rect x="347" y="277" width="45" height="88" rx="3" fill="#dde6d6" />

          {/* Blocks - row 5 */}
          <rect x="8" y="382" width="48" height="84" rx="3" fill="#dde6d6" />
          <rect x="67" y="382" width="64" height="84" rx="3" fill="#d8e2d0" />
          <rect x="147" y="382" width="50" height="84" rx="3" fill="#dde6d6" />
          <rect x="207" y="382" width="54" height="84" rx="3" fill="#d5dece" />
          <rect x="277" y="382" width="58" height="84" rx="3" fill="#dde6d6" />
          <rect x="347" y="382" width="45" height="84" rx="3" fill="#d8e2d0" />

          {/* Blocks - row 6 */}
          <rect x="8" y="477" width="48" height="78" rx="3" fill="#d5dece" />
          <rect x="67" y="477" width="64" height="78" rx="3" fill="#dde6d6" />
          <rect x="147" y="477" width="50" height="78" rx="3" fill="#d8e2d0" />
          <rect x="207" y="477" width="54" height="78" rx="3" fill="#dde6d6" />
          <rect x="277" y="477" width="58" height="78" rx="3" fill="#d5dece" />
          <rect x="347" y="477" width="45" height="78" rx="3" fill="#dde6d6" />

          {/* Blocks - row 7 */}
          <rect x="8" y="570" width="48" height="76" rx="3" fill="#dde6d6" />
          <rect x="67" y="570" width="64" height="76" rx="3" fill="#d5dece" />
          <rect x="147" y="570" width="50" height="76" rx="3" fill="#dde6d6" />
          <rect x="207" y="570" width="54" height="76" rx="3" fill="#d8e2d0" />
          <rect x="277" y="570" width="58" height="76" rx="3" fill="#dde6d6" />
          <rect x="347" y="570" width="45" height="76" rx="3" fill="#d5dece" />

          {/* Blocks - row 8 */}
          <rect x="147" y="655" width="50" height="70" rx="3" fill="#dde6d6" />
          <rect x="207" y="655" width="54" height="70" rx="3" fill="#d5dece" />
          <rect x="277" y="655" width="58" height="70" rx="3" fill="#dde6d6" />
          <rect x="347" y="655" width="45" height="70" rx="3" fill="#d8e2d0" />

          {/* Blocks - row 9 */}
          <rect x="8" y="790" width="48" height="56" rx="3" fill="#d8e2d0" />
          <rect x="67" y="790" width="64" height="56" rx="3" fill="#dde6d6" />
          <rect x="147" y="790" width="50" height="56" rx="3" fill="#d5dece" />
          <rect x="207" y="790" width="54" height="56" rx="3" fill="#dde6d6" />
          <rect x="277" y="790" width="58" height="56" rx="3" fill="#d8e2d0" />
          <rect x="347" y="790" width="45" height="56" rx="3" fill="#dde6d6" />

          {/* Small building details on some blocks */}
          <rect x="15" y="195" width="18" height="22" rx="1" fill="#cdd8c4" />
          <rect x="35" y="200" width="14" height="17" rx="1" fill="#cdd8c4" />
          <rect x="155" y="290" width="16" height="25" rx="1" fill="#cdd8c4" />
          <rect x="220" y="395" width="20" height="18" rx="1" fill="#cdd8c4" />
          <rect x="290" y="490" width="15" height="20" rx="1" fill="#cdd8c4" />
          <rect x="80" y="585" width="22" height="16" rx="1" fill="#cdd8c4" />
          <rect x="355" y="300" width="18" height="22" rx="1" fill="#cdd8c4" />

          {/* Road labels */}
          <text x="180" y="168" fontSize="6" fill="#b8b0a0" fontFamily="Arial" textAnchor="middle">Main St</text>
          <text x="300" y="368" fontSize="6" fill="#b8b0a0" fontFamily="Arial" textAnchor="middle">Oak Ave</text>
          <text x="132" y="450" fontSize="6" fill="#b8b0a0" fontFamily="Arial" transform="rotate(-90, 132, 450)">1st St</text>
          <text x="262" y="450" fontSize="6" fill="#b8b0a0" fontFamily="Arial" transform="rotate(-90, 262, 450)">2nd St</text>

          {/* Pin shadow */}
          <ellipse cx="200" cy="445" rx="8" ry="3" fill="rgba(0,0,0,0.12)" />
        </svg>

        {/* Animated location pin */}
        <div className="absolute" style={{ top: "46%", left: "48%", transform: "translate(-50%, -100%)" }}>
          <div className="relative">
            <div className="absolute -inset-3 rounded-full bg-blue-500/20 animate-ping" />
            <div className="relative w-7 h-7 rounded-full bg-blue-600 border-[3px] border-white shadow-lg flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-white" />
            </div>
          </div>
        </div>

        {/* Zoom controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-1">
          <button className="w-8 h-8 rounded-lg bg-white/90 backdrop-blur border border-slate-300 shadow-sm flex items-center justify-center text-slate-600 hover:bg-white text-lg leading-none">
            +
          </button>
          <button className="w-8 h-8 rounded-lg bg-white/90 backdrop-blur border border-slate-300 shadow-sm flex items-center justify-center text-slate-600 hover:bg-white text-lg leading-none">
            −
          </button>
        </div>

        {/* Map preview label */}
        <div className="absolute top-3 left-3 rounded-md bg-white/80 backdrop-blur px-2 py-1 text-[10px] text-slate-500 border border-slate-200/60">
          Map preview
        </div>
      </div>
    </div>
  );
}
