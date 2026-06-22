import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Nav */}
      <nav className="border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Login
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-[#0f172a] px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-block rounded-full bg-blue-50 px-4 py-1.5 text-xs font-medium text-blue-700 mb-6">
          Built for service businesses
        </div>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900 max-w-3xl mx-auto leading-tight">
          Scheduling made simple for service businesses
        </h1>
        <p className="mt-5 text-lg text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Manage clients, recurring appointments, notes, and service history without complicated software. Built by a cleaning company owner, for service business owners.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link
            href="/login"
            className="rounded-lg bg-[#0f172a] px-6 py-3 text-sm font-medium text-white hover:bg-slate-800 transition-colors shadow-sm"
          >
            Login
          </Link>
          <button
            className="rounded-lg border border-slate-300 px-6 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            Request Demo
          </button>
        </div>
      </section>

      {/* Features */}
      <section className="bg-slate-50 border-y border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-bold text-slate-900">Everything you need to run your schedule</h2>
            <p className="mt-2 text-sm text-slate-600">No bloat. No learning curve. Just the tools that matter.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: "&#128100;", title: "Client Management", desc: "Store client details, contact info, notes, and preferences. Never lose track of a customer again." },
              { icon: "&#128260;", title: "Recurring Scheduling", desc: "Set up weekly, biweekly, or custom recurring appointments. They appear automatically on your calendar." },
              { icon: "&#128197;", title: "Daily & Weekly Views", desc: "See your day or week at a glance. Navigate forward and back with one click." },
              { icon: "&#128221;", title: "Notes & History", desc: "Keep gate codes, pet info, and preferences attached to each client. Full service history preserved." },
              { icon: "&#9742;", title: "Communication Ready", desc: "Track SMS, email, and phone preferences per client. Automated confirmations when you are ready." },
              { icon: "&#128736;", title: "Service Types", desc: "Define your services with names and descriptions. Regular cleaning, deep cleaning, estimates, and more." },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="text-2xl mb-3">{f.icon}</div>
                <div className="text-sm font-semibold text-slate-900">{f.title}</div>
                <div className="mt-2 text-xs text-slate-600 leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why it matters */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Built for real service businesses</h2>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">
              Schedule FlowTrack was built by a cleaning company owner who got tired of spreadsheets, missed appointments, and scattered client notes. This is the tool we wished existed.
            </p>
            <div className="mt-6 space-y-4">
              {[
                { text: "Keep complete client history — even when they pause and come back" },
                { text: "Never double-book or miss a recurring appointment" },
                { text: "See your entire week in one view — know what is coming next" },
                { text: "Notes, gate codes, and preferences always at your fingertips" },
              ].map((item) => (
                <div key={item.text} className="flex items-start gap-3">
                  <div className="mt-0.5 flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs shrink-0">&#10003;</div>
                  <div className="text-sm text-slate-700">{item.text}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center">
            <div className="text-4xl text-slate-300 mb-3">&#128197;</div>
            <div className="text-sm font-semibold text-slate-700">Schedule FlowTrack</div>
            <div className="mt-1 text-xs text-slate-500">Your week, organized.</div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#0f172a] text-white">
        <div className="max-w-6xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-bold">Ready to simplify your scheduling?</h2>
          <p className="mt-2 text-sm text-slate-400">Start managing your clients and appointments in minutes.</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              href="/login"
              className="rounded-lg bg-white px-6 py-3 text-sm font-medium text-slate-900 hover:bg-slate-100 transition-colors"
            >
              Login
            </Link>
            <button className="rounded-lg border border-slate-600 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors">
              Request Demo
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-md bg-[#0f172a] text-white text-[10px] font-bold">
              FTS
            </div>
            <span className="text-xs font-medium text-slate-700">Schedule FlowTrack</span>
          </div>
          <div className="text-xs text-slate-500">
            Powered by Nova Labs Digital
          </div>
        </div>
      </footer>
    </div>
  );
}
