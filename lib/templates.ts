import { DateTime } from "luxon";

function fmt(iso: string) {
  return DateTime.fromISO(iso)
    .setZone("America/New_York")
    .toFormat("ccc, LLL d 'at' h:mm a");
}

export function confirmationTemplates(
  name: string,
  service: string,
  scheduledIso: string,
  cancelUrl: string
) {
  const when = fmt(scheduledIso);

  return {
    email: {
      subject: `Confirmed — ${service} (${when})`,
      body: `Hi ${name},

Your appointment is confirmed.

Service: ${service}
When: ${when}

Need to cancel? Click here:
${cancelUrl}

Thank you,
FlowTrack Schedule`,
    },
    sms: `Confirmed: ${service} on ${when}. Cancel: ${cancelUrl}`,
  };
}

export function reminder24hTemplates(
  name: string,
  service: string,
  scheduledIso: string
) {
  const when = fmt(scheduledIso);

  return {
    email: {
      subject: `Reminder — ${service} (${when})`,
      body: `Hi ${name},

Friendly reminder for your appointment:

Service: ${service}
When: ${when}

Thank you,
FlowTrack Schedule`,
    },
    sms: `Reminder: ${service} on ${when}. — FlowTrack Schedule`,
  };
}

export function cancelTemplates(name: string) {
  const bookUrl = `${process.env.APP_URL}/book`;
  return {
    email: {
      subject: `Appointment Cancelled`,
      body: `Hi ${name},

Your appointment has been cancelled.
To reschedule anytime:
${bookUrl}

Thank you,
FlowTrack Schedule`,
    },
    sms: `Cancelled. Reschedule: ${bookUrl}`,
  };
}
