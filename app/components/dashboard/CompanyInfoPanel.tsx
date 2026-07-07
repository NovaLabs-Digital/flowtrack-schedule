"use client";

import { useEffect, useState } from "react";
import SettingsCard, { DirtyHint, ComingSoonNotice } from "@/app/components/dashboard/SettingsCard";
import SettingsToggle from "@/app/components/dashboard/SettingsToggle";
import CompanyStatusStrip from "@/app/components/dashboard/CompanyStatusStrip";

type IdentityForm = { company_name: string };
type ContactForm = { phone: string; email: string; address: string; city: string; state: string; zip: string };
type SchedulingForm = { booking_enabled: boolean };

type Status = { emailConfigured: boolean; smsConfigured: boolean; activeStaff: number; totalStaff: number };

const EMPTY_IDENTITY: IdentityForm = { company_name: "" };
const EMPTY_CONTACT: ContactForm = { phone: "", email: "", address: "", city: "", state: "", zip: "" };
const EMPTY_SCHEDULING: SchedulingForm = { booking_enabled: false };
const inputCls =
  "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";

export default function CompanyInfoPanel() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);

  // Each card owns its own draft + last-saved snapshot, so dirty-state and
  // Save are per-card (one question, one commit point) rather than one
  // page-wide form.
  const [identity, setIdentity] = useState<IdentityForm>(EMPTY_IDENTITY);
  const [identitySaved, setIdentitySaved] = useState<IdentityForm>(EMPTY_IDENTITY);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityMsg, setIdentityMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [contact, setContact] = useState<ContactForm>(EMPTY_CONTACT);
  const [contactSaved, setContactSaved] = useState<ContactForm>(EMPTY_CONTACT);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactMsg, setContactMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [scheduling, setScheduling] = useState<SchedulingForm>(EMPTY_SCHEDULING);
  const [schedulingSaved, setSchedulingSaved] = useState<SchedulingForm>(EMPTY_SCHEDULING);
  const [schedulingSaving, setSchedulingSaving] = useState(false);
  const [schedulingMsg, setSchedulingMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings/company")
      .then((r) => r.json())
      .then((data) => {
        const s = data.settings;
        if (s) {
          const nextIdentity = { company_name: s.company_name ?? "" };
          const nextContact = {
            phone: s.phone ?? "",
            email: s.email ?? "",
            address: s.address ?? "",
            city: s.city ?? "",
            state: s.state ?? "",
            zip: s.zip ?? "",
          };
          const nextScheduling = { booking_enabled: Boolean(s.booking_enabled) };
          setIdentity(nextIdentity);
          setIdentitySaved(nextIdentity);
          setContact(nextContact);
          setContactSaved(nextContact);
          setScheduling(nextScheduling);
          setSchedulingSaved(nextScheduling);
        }
        if (data.status) setStatus(data.status);
      })
      .catch(() => setIdentityMsg({ type: "error", text: "Failed to load company settings." }))
      .finally(() => setLoading(false));
  }, []);

  async function save(
    fields: Record<string, unknown>,
    onSuccess: () => void,
    setSaving: (v: boolean) => void,
    setMsg: (m: { type: "success" | "error"; text: string } | null) => void
  ) {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ type: "error", text: data?.error || "Save failed." });
        return;
      }
      onSuccess();
      setMsg({ type: "success", text: "Saved." });
    } catch {
      setMsg({ type: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  const identityDirty = identity.company_name !== identitySaved.company_name;
  const contactDirty = JSON.stringify(contact) !== JSON.stringify(contactSaved);
  const schedulingDirty = scheduling.booking_enabled !== schedulingSaved.booking_enabled;

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading company settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-3xl">
      {status && (
        <CompanyStatusStrip
          emailConfigured={status.emailConfigured}
          smsConfigured={status.smsConfigured}
          bookingEnabled={scheduling.booking_enabled}
          activeStaff={status.activeStaff}
          totalStaff={status.totalStaff}
        />
      )}

      <SettingsCard
        title="Business Identity"
        helper="Who you are — used across confirmations, invoices, and the public booking page."
        footer={
          <>
            <DirtyHint dirty={identityDirty} />
            <button
              type="button"
              disabled={identitySaving || !identityDirty}
              onClick={() =>
                save(
                  { company_name: identity.company_name },
                  () => setIdentitySaved(identity),
                  setIdentitySaving,
                  setIdentityMsg
                )
              }
              className="rounded-xl bg-[#0f172a] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              {identitySaving ? "Saving..." : "Save"}
            </button>
          </>
        }
      >
        <div className="max-w-md">
          <label className="block text-xs font-medium text-slate-600 mb-1">Company Name</label>
          <input
            type="text"
            value={identity.company_name}
            onChange={(e) => setIdentity({ company_name: e.target.value })}
            className={inputCls}
            placeholder="e.g. Alberto's Cleaning Services"
          />
        </div>
        {identityMsg && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs",
              identityMsg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            {identityMsg.text}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Contact & Location"
        helper="Where clients reach you and where your service area is centered."
        footer={
          <>
            <DirtyHint dirty={contactDirty} />
            <button
              type="button"
              disabled={contactSaving || !contactDirty}
              onClick={() => save(contact, () => setContactSaved(contact), setContactSaving, setContactMsg)}
              className="rounded-xl bg-[#0f172a] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              {contactSaving ? "Saving..." : "Save"}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Phone</label>
            <input
              type="tel"
              value={contact.phone}
              onChange={(e) => setContact((p) => ({ ...p, phone: e.target.value }))}
              className={inputCls}
              placeholder="+13861234567"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
            <input
              type="email"
              value={contact.email}
              onChange={(e) => setContact((p) => ({ ...p, email: e.target.value }))}
              className={inputCls}
              placeholder="info@company.com"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Address</label>
          <input
            type="text"
            value={contact.address}
            onChange={(e) => setContact((p) => ({ ...p, address: e.target.value }))}
            className={inputCls}
            placeholder="123 Main St"
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">City</label>
            <input
              type="text"
              value={contact.city}
              onChange={(e) => setContact((p) => ({ ...p, city: e.target.value }))}
              className={inputCls}
              placeholder="Orlando"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">State</label>
            <input
              type="text"
              value={contact.state}
              onChange={(e) => setContact((p) => ({ ...p, state: e.target.value }))}
              className={inputCls}
              placeholder="FL"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">ZIP</label>
            <input
              type="text"
              value={contact.zip}
              onChange={(e) => setContact((p) => ({ ...p, zip: e.target.value }))}
              className={inputCls}
              placeholder="32801"
            />
          </div>
        </div>
        {contactMsg && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs",
              contactMsg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            {contactMsg.text}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Scheduling Preferences"
        helper="Defaults that control how appointments get booked."
        footer={
          <>
            <DirtyHint dirty={schedulingDirty} />
            <button
              type="button"
              disabled={schedulingSaving || !schedulingDirty}
              onClick={() =>
                save(
                  { booking_enabled: scheduling.booking_enabled },
                  () => setSchedulingSaved(scheduling),
                  setSchedulingSaving,
                  setSchedulingMsg
                )
              }
              className="rounded-xl bg-[#0f172a] px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-40 transition-colors"
            >
              {schedulingSaving ? "Saving..." : "Save"}
            </button>
          </>
        }
      >
        <SettingsToggle
          checked={scheduling.booking_enabled}
          onChange={(next) => setScheduling({ booking_enabled: next })}
          label="Allow clients to book online"
          helper="Keeps your public booking page live"
        />
        {schedulingMsg && (
          <div
            className={[
              "rounded-xl border px-3 py-2 text-xs",
              schedulingMsg.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700",
            ].join(" ")}
          >
            {schedulingMsg.text}
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="Communication Preferences" helper="What clients automatically hear from you, and when.">
        <ComingSoonNotice text="Communication preferences will be available in a future update." />
      </SettingsCard>

      <SettingsCard title="Subscription & Plan" helper="Your Nova Labs Schedule plan and billing.">
        <ComingSoonNotice text="Subscription management will be available in a future update." />
      </SettingsCard>
    </div>
  );
}
