// Client "your appointment changed" notification for the atomic recurrence
// change route. Same content, gating and audit logging as the block at the
// end of app/api/appointments/update/route.ts (kept separate so that route
// and its tests are untouched).
//
// DELIVERY GUARANTEE -- read before relying on this: the caller invokes this
// ONLY after apply_recurrence_change has committed, so a rolled-back or
// rejected change never notifies. There is NO outbox: the send is a direct
// provider call from the request that just committed. If the process dies
// after the commit but before/while sending, that notification is lost and
// nothing retries it. A replayed (identical, already-completed) operation
// never re-sends. This is at-most-once from the request's point of view, not
// guaranteed delivery.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, describeProviderError, recordMessageSent, getCompanyIdentity, type NotifyChannel } from "@/lib/notify";
import { changeTemplates } from "@/lib/templates";
import { requireCapabilityForWorkspace } from "@/lib/entitlementServer";

export async function sendAppointmentChangeNotification(params: {
  workspaceId: string;
  appointmentId: string;
  clientId: string;
  channel: NotifyChannel;
}): Promise<void> {
  const { workspaceId, appointmentId, clientId, channel } = params;
  if (channel === "none") return;

  const notifyCapability = await requireCapabilityForWorkspace(workspaceId, "canSendNotifications");
  if (!notifyCapability.allowed) return;

  const apptRes = await supabaseAdmin
    .from("appointments")
    .select("service_type, scheduled_for")
    .eq("id", appointmentId)
    .eq("workspace_id", workspaceId)
    .single();
  const clientRes = await supabaseAdmin
    .from("clients")
    .select("name, email, phone, auto_email, auto_sms")
    .eq("id", clientId)
    .eq("workspace_id", workspaceId)
    .single();
  if (apptRes.error || clientRes.error) return;

  const { name, email, phone, auto_email, auto_sms } = clientRes.data;
  const { service_type, scheduled_for } = apptRes.data;
  const { companyName, timezone } = await getCompanyIdentity(workspaceId);
  const t = changeTemplates(name, service_type, scheduled_for, companyName, timezone);

  if (email && auto_email && shouldSend(channel, "email")) {
    try {
      const providerId = await sendEmail(email, t.email.subject, t.email.body, workspaceId, companyName);
      await recordMessageSent({
        appointment_id: appointmentId, channel: "email", kind: "update", workspace_id: workspaceId,
        to_value: email, body: t.email.body, provider_id: providerId,
      });
    } catch (err) {
      console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
      await recordMessageSent({
        appointment_id: appointmentId, channel: "email", kind: "update", workspace_id: workspaceId,
        to_value: email, body: t.email.body, provider_id: "failed",
      });
    }
  }
  // Runs even if the email attempt failed -- one provider's failure must not
  // block the other channel.
  if (phone && auto_sms && shouldSend(channel, "sms")) {
    try {
      const providerId = await sendSms(phone, t.sms, workspaceId);
      await recordMessageSent({
        appointment_id: appointmentId, channel: "sms", kind: "update", workspace_id: workspaceId,
        to_value: phone, body: t.sms, provider_id: providerId,
      });
    } catch (err) {
      console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
      await recordMessageSent({
        appointment_id: appointmentId, channel: "sms", kind: "update", workspace_id: workspaceId,
        to_value: phone, body: t.sms, provider_id: "failed",
      });
    }
  }
}
