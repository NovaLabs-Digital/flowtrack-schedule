export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, describeProviderError, recordMessageSent } from "@/lib/notify";
import { reminder24hTemplates } from "@/lib/templates";
import { safeEqual } from "@/lib/safeEqual";
import { requireCapabilityForWorkspace } from "@/lib/entitlementServer";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    const cronSecret = process.env.CRON_SECRET;
    if (!secret || !cronSecret || !safeEqual(secret, cronSecret)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const now = DateTime.now().setZone("America/New_York");
    const start = now.plus({ hours: 23 }).toUTC().toISO();
    const end = now.plus({ hours: 25 }).toUTC().toISO();

    // This single cron run spans every workspace at once — no workspace
    // filter here by design. Each appointment carries its own workspace_id,
    // and every downstream decision (notifications_enabled, the send calls
    // themselves) uses that appointment's own workspace, never a shared
    // default, so one workspace's settings can never leak into another's.
    // Demo appointments are excluded outright — reminders are a real-business
    // action, not something the demo experience needs to simulate.
    const appts = await supabaseAdmin
      .from("appointments")
      .select("id, scheduled_for, service_type, client_id, workspace_id")
      .eq("status", "scheduled")
      .eq("is_demo", false)
      .is("reminder_24h_sent_at", null)
      .gte("scheduled_for", start!)
      .lte("scheduled_for", end!);

    if (appts.error) throw appts.error;

    // Local, single-request cache — avoids re-querying the same workspace's
    // company_settings once per appointment when a cron run covers many
    // appointments for the same business. lib/notify.ts's sendEmail/sendSms
    // still perform their own authoritative check on every call; this is
    // purely an optimization to skip attempting a send we can already
    // predict will no-op.
    const notifCache = new Map<string, boolean>();
    async function workspaceNotifying(workspaceId: string): Promise<boolean> {
      if (notifCache.has(workspaceId)) return notifCache.get(workspaceId)!;
      const { data } = await supabaseAdmin
        .from("company_settings")
        .select("notifications_enabled")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      const enabled = Boolean(data?.notifications_enabled);
      notifCache.set(workspaceId, enabled);
      return enabled;
    }

    // One entitlement check per unique workspace present in this run,
    // cached exactly like workspaceNotifying above -- a single cron
    // invocation spans every workspace, so a restricted workspace must never
    // block, slow down, or share a decision with another workspace's
    // reminders. Uses requireCapabilityForWorkspace (never requireCapability
    // with a manufactured session -- this route has no session at all) with
    // the workspace_id already read off the candidate appointment row in the
    // discovery query above -- server-derived, never request input.
    const entitlementCache = new Map<string, boolean>();
    async function workspaceEntitled(workspaceId: string): Promise<boolean> {
      if (entitlementCache.has(workspaceId)) return entitlementCache.get(workspaceId)!;
      const capability = await requireCapabilityForWorkspace(workspaceId, "canSendNotifications");
      entitlementCache.set(workspaceId, capability.allowed);
      return capability.allowed;
    }

    let sent = 0;
    let entitlementSkipped = 0;

    for (const a of appts.data || []) {
      // Checked before the client lookup below (which reads real PII --
      // name/email/phone) so a restricted workspace's data is never touched
      // beyond the minimal id/workspace_id/scheduling fields already read in
      // the discovery query above. No content is constructed, no provider is
      // called, and reminder_24h_sent_at is never updated for a skipped
      // appointment -- it remains eligible to be picked up once the
      // workspace's entitlement is restored (subject to the existing 23-25h
      // window, unchanged).
      if (!(await workspaceEntitled(a.workspace_id))) {
        entitlementSkipped++;
        continue;
      }

      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone, auto_email, auto_sms")
        .eq("id", a.client_id)
        .eq("workspace_id", a.workspace_id)
        .single();

      if (clientRes.error) continue;

      const { name, email, phone, auto_email, auto_sms } = clientRes.data;
      const t = reminder24hTemplates(name, a.service_type, a.scheduled_for);
      const notifying = await workspaceNotifying(a.workspace_id);

      // Each channel is isolated in its own try/catch — matching the
      // pattern already used in create/update/delete — so one appointment's
      // (or one workspace's) provider failure can never abort the rest of
      // the run. Previously this route had no such isolation at all: a
      // single thrown error here would abort the entire cron invocation,
      // leaving every other workspace's reminders unprocessed too.
      if (notifying && email && auto_email) {
        try {
          const providerId = await sendEmail(email, t.email.subject, t.email.body, a.workspace_id);
          await recordMessageSent({
            appointment_id: a.id,
            channel: "email",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: email,
            body: t.email.body,
            provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id: a.id,
            channel: "email",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: email,
            body: t.email.body,
            provider_id: "failed",
          });
        }
      }

      if (notifying && phone && auto_sms) {
        try {
          const providerId = await sendSms(phone, t.sms, a.workspace_id);
          await recordMessageSent({
            appointment_id: a.id,
            channel: "sms",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: phone,
            body: t.sms,
            provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id: a.id,
            channel: "sms",
            kind: "reminder_24h",
            workspace_id: a.workspace_id,
            to_value: phone,
            body: t.sms,
            provider_id: "failed",
          });
        }
      }

      await supabaseAdmin
        .from("appointments")
        .update({ reminder_24h_sent_at: new Date().toISOString() })
        .eq("id", a.id)
        .eq("workspace_id", a.workspace_id);

      sent++;
    }

    return json({ ok: true, checked: appts.data?.length || 0, sent, entitlementSkipped });
  } catch (e: any) {
    console.error("CRON_REMINDERS_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
