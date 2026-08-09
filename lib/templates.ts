import { DateTime } from "luxon";

function fmt(iso: string) {
  return DateTime.fromISO(iso)
    .setZone("America/New_York")
    .toFormat("ccc, LLL d 'at' h:mm a");
}

function fmtDate(iso: string) {
  return DateTime.fromISO(iso).setZone("America/New_York").toFormat("cccc, LLLL d");
}

function fmtTime(iso: string) {
  return DateTime.fromISO(iso).setZone("America/New_York").toFormat("h:mm a");
}

export function confirmationTemplates(
  name: string,
  service: string,
  scheduledIso: string,
  cancelUrl: string,
  companyName: string
) {
  const when = fmt(scheduledIso);
  const date = fmtDate(scheduledIso);
  const time = fmtTime(scheduledIso);

  return {
    email: {
      subject: `Appointment Confirmed — ${service} (${when})`,
      body: `Hi ${name},

✅ Appointment Confirmed

Service: ${service}
Date: ${date}
Time: ${time}

Need to cancel?
${cancelUrl}

Thank you,
${companyName}`,
    },
    sms: `${companyName}: ✅ Appointment Confirmed

Service: ${service}
Date: ${date}
Time: ${time}

Need to cancel?
${cancelUrl}`,
  };
}

export function reminder24hTemplates(
  name: string,
  service: string,
  scheduledIso: string,
  companyName: string
) {
  const when = fmt(scheduledIso);
  const date = fmtDate(scheduledIso);
  const time = fmtTime(scheduledIso);

  return {
    email: {
      subject: `Reminder — ${service} (${when})`,
      body: `Hi ${name},

This is a friendly reminder for your upcoming appointment.

Service: ${service}
Date: ${date}
Time: ${time}

Thank you,
${companyName}`,
    },
    sms: `${companyName}: Reminder

Service: ${service}
Date: ${date}
Time: ${time}`,
  };
}

export function changeTemplates(
  name: string,
  service: string,
  scheduledIso: string,
  companyName: string
) {
  const when = fmt(scheduledIso);
  const date = fmtDate(scheduledIso);
  const time = fmtTime(scheduledIso);

  return {
    email: {
      subject: `Appointment Updated — ${service} (${when})`,
      body: `Hi ${name},

Your appointment has been updated.

Service: ${service}
Date: ${date}
Time: ${time}

Thank you,
${companyName}`,
    },
    sms: `${companyName}: Appointment Updated

Service: ${service}
Date: ${date}
Time: ${time}`,
  };
}

// bookingEnabled: the workspace's own company_settings.booking_enabled,
// read by the caller and passed in explicitly rather than looked up here --
// this file has no Supabase dependency and stays that way. When false (or
// the caller couldn't safely determine it and fails closed to false), the
// entire "Need another appointment?" section is omitted from both the email
// and the SMS -- a client must never be invited to a booking page the
// business has turned off.
export function cancelTemplates(name: string, service: string, companyName: string, bookingEnabled: boolean) {
  const bookingCta = bookingEnabled
    ? `\n\nNeed another appointment?\n${process.env.NEXT_PUBLIC_APP_URL}/book`
    : "";
  return {
    email: {
      subject: `Appointment Cancelled`,
      body: `Hi ${name},

Your appointment has been cancelled.

Service: ${service}${bookingCta}

Thank you,
${companyName}`,
    },
    sms: `${companyName}: Your appointment has been cancelled.

Service: ${service}${bookingCta}`,
  };
}
