import Image from "next/image";
import Link from "next/link";
import { Calendar, Clock, MessageCircle, NotebookPen, Repeat, Users } from "lucide-react";
import TryDemoButton from "@/app/components/TryDemoButton";
import { SUBSCRIPTION_PRICE_DISPLAY, SUBSCRIPTION_TRIAL_DAYS } from "@/lib/billingDisplay";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Nav */}
      <nav className="border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[var(--navy)] text-white text-xs font-bold">
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
              href="/signup"
              className="rounded-lg bg-[var(--navy)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--navy-light)] transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-8 text-center">
        <div className="inline-block rounded-full bg-blue-50 px-4 py-1.5 text-xs font-medium text-blue-700 mb-5">
          Built for service businesses
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 max-w-2xl mx-auto leading-tight">
          Run your service schedule without the chaos
        </h1>
        <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-xl mx-auto leading-relaxed">
          Manage recurring appointments, employees, client details, worked hours, and customer communication from one simple schedule.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-[var(--navy)] px-5 py-2.5 text-sm font-medium text-white hover:bg-[var(--navy-light)] transition-colors shadow-sm"
          >
            Start Free Trial
          </Link>
          <TryDemoButton className="rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
            Try Live Demo
          </TryDemoButton>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {SUBSCRIPTION_TRIAL_DAYS} days free, then {SUBSCRIPTION_PRICE_DISPLAY}/month. Cancel anytime.
        </p>
      </section>

      {/* Product screenshot */}
      <section className="max-w-6xl mx-auto px-6 pb-16">
        <div className="rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
          <Image
            src="/screenshots/sft-dashboard-native.png"
            alt="Schedule FlowTrack weekly dashboard, showing real appointments, client details, and dispatch status"
            width={3200}
            height={1610}
            className="w-full h-auto"
            priority
          />
        </div>
      </section>

      {/* Features */}
      <section className="bg-slate-50 border-y border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-bold text-slate-900">Everything your service business needs to stay organized</h2>
            <p className="mt-2 text-sm text-slate-600">Keep recurring jobs, employees, client details, worked hours, and communication together—without making scheduling complicated.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { Icon: Users, title: "Client Management", desc: "Keep every client's details, contact info, and preferences in one place. Never lose track of a customer again." },
              { Icon: Repeat, title: "Recurring Appointments", desc: "Set up weekly, biweekly, or custom recurring jobs. They stay organized on your calendar automatically." },
              { Icon: Clock, title: "Employees & Worked Hours", desc: "See who's working, on what job, and for how long. Track worked hours per employee without spreadsheets." },
              { Icon: Calendar, title: "Weekly Schedule", desc: "See your whole day or week at a glance, so nothing slips through the cracks." },
              { Icon: NotebookPen, title: "Job Notes & History", desc: "Gate codes, pet info, and preferences attached to each client, with full service history preserved." },
              { Icon: MessageCircle, title: "Customer Communication", desc: "Track SMS, email, and phone preferences per client. Stay in touch without extra tools." },
            ].map((f) => (
              <div key={f.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-slate-100 text-[var(--navy)] mb-3">
                  <f.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="text-sm font-semibold text-slate-900">{f.title}</div>
                <div className="mt-2 text-xs text-slate-600 leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why it matters */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="max-w-2xl mx-auto">
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
                <div className="mt-0.5 flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs shrink-0">✓</div>
                <div className="text-sm text-slate-700">{item.text}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="max-w-md mx-auto rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center">
          <h2 className="text-lg font-semibold text-slate-900">ScheduleFlowTrack Pro</h2>
          <div className="mt-3">
            <span className="text-4xl font-bold text-slate-900">{SUBSCRIPTION_PRICE_DISPLAY}</span>
            <span className="text-sm text-slate-500"> / month</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{SUBSCRIPTION_TRIAL_DAYS}-day free trial</p>
          <ul className="mt-6 space-y-2.5 text-left text-sm text-slate-700">
            {[
              "Complete weekly schedule",
              "Recurring appointments",
              "Client and service management",
              "Projected revenue",
              "Employee worked hours",
              "Email and SMS notification controls",
              "Desktop and mobile access",
            ].map((feature) => (
              <li key={feature} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 text-xs shrink-0">✓</span>
                <span>{feature}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/signup"
            className="mt-7 block w-full rounded-lg bg-[var(--navy)] px-6 py-3 text-sm font-medium text-white hover:bg-[var(--navy-light)] transition-colors shadow-sm"
          >
            Start Free Trial
          </Link>
          <p className="mt-3 text-xs text-slate-500">No annual contract. Cancel anytime.</p>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[var(--navy)] text-white">
        <div className="max-w-6xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-bold">Ready to run your schedule without the chaos?</h2>
          <p className="mt-2 text-sm text-slate-400">Set up recurring jobs, add your team, and see your week in one place.</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-white px-6 py-3 text-sm font-medium text-slate-900 hover:bg-slate-100 transition-colors"
            >
              Start Free Trial
            </Link>
            <TryDemoButton className="rounded-lg border border-slate-600 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors">
              Try Live Demo
            </TryDemoButton>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-md bg-[var(--navy)] text-white text-[10px] font-bold">
              FTS
            </div>
            <span className="text-xs font-medium text-slate-700">Schedule FlowTrack</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-slate-500">
            <Link href="/terms" className="hover:text-slate-700 transition-colors">
              Terms of Service
            </Link>
            <Link href="/privacy" className="hover:text-slate-700 transition-colors">
              Privacy Policy
            </Link>
            <Link href="/contact" className="hover:text-slate-700 transition-colors">
              Contact Us
            </Link>
            <Link href="/learn" className="hover:text-slate-700 transition-colors">
              Learning Center
            </Link>
            <span>Powered by Nova Labs Digital</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
