"use client";

import { useEffect, useState } from "react";

type CompanyForm = {
  company_name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
};

const EMPTY: CompanyForm = {
  company_name: "",
  phone: "",
  email: "",
  address: "",
  city: "",
  state: "",
  zip: "",
};

export default function CompanyInfoPanel() {
  const [form, setForm] = useState<CompanyForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/company")
      .then((r) => r.json())
      .then((data) => {
        if (data.settings) {
          setForm({
            company_name: data.settings.company_name ?? "",
            phone: data.settings.phone ?? "",
            email: data.settings.email ?? "",
            address: data.settings.address ?? "",
            city: data.settings.city ?? "",
            state: data.settings.state ?? "",
            zip: data.settings.zip ?? "",
          });
        }
      })
      .catch(() => setMessage({ type: "error", text: "Failed to load company settings." }))
      .finally(() => setLoading(false));
  }, []);

  function set(field: keyof CompanyForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setMessage(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMessage({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      setMessage({ type: "success", text: "Company info saved." });
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading company settings...</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-semibold text-slate-900">Company Info</div>
      <div className="mt-1 text-xs text-slate-500">
        Business details used across the application.
      </div>

      <form onSubmit={handleSave} className="mt-5 space-y-4 max-w-xl">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Company Name</label>
          <input
            type="text"
            value={form.company_name}
            onChange={(e) => set("company_name", e.target.value)}
            className={inputCls}
            placeholder="e.g. Alberto's Cleaning Services"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Phone</label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              className={inputCls}
              placeholder="+13861234567"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              className={inputCls}
              placeholder="info@company.com"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Address</label>
          <input
            type="text"
            value={form.address}
            onChange={(e) => set("address", e.target.value)}
            className={inputCls}
            placeholder="123 Main St"
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
            <input
              type="text"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
              className={inputCls}
              placeholder="Orlando"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">State</label>
            <input
              type="text"
              value={form.state}
              onChange={(e) => set("state", e.target.value)}
              className={inputCls}
              placeholder="FL"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">ZIP</label>
            <input
              type="text"
              value={form.zip}
              onChange={(e) => set("zip", e.target.value)}
              className={inputCls}
              placeholder="32801"
            />
          </div>
        </div>

        {message && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs",
              message.type === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            {message.text}
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-[#0f172a] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save Company Info"}
          </button>
        </div>
      </form>
    </div>
  );
}
