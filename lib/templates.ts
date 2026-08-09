import { DateTime } from "luxon";

// Phase 5E: every appointment date/time formatter below requires an
// explicit, resolved workspace timezone -- no hardcoded "America/New_York"
// remains. A 9:00 AM Pacific appointment must read "9:00 AM" in the
// client's message, not a New York (or device) reinterpretation of that
// same UTC instant. Callers resolve the trusted timezone via
// effectiveTimezone(company_settings.timezone) and pass it through.
function fmt(iso: string, tz: string) {
  return DateTime.fromISO(iso)
    .setZone(tz)
    .toFormat("ccc, LLL d 'at' h:mm a");
}

function fmtDate(iso: string, tz: string) {
  return DateTime.fromISO(iso).setZone(tz).toFormat("cccc, LLLL d");
}

function fmtTime(iso: string, tz: string) {
  return DateTime.fromISO(iso).setZone(tz).toFormat("h:mm a");
}

export function confirmationTemplates(
  name: string,
  service: string,
  scheduledIso: string,
  cancelUrl: string,
  companyName: string,
  tz: string
) {
  const when = fmt(scheduledIso, tz);
  const date = fmtDate(scheduledIso, tz);
  const time = fmtTime(scheduledIso, tz);

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
  companyName: string,
  tz: string
) {
  const when = fmt(scheduledIso, tz);
  const date = fmtDate(scheduledIso, tz);
  const time = fmtTime(scheduledIso, tz);

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
  companyName: string,
  tz: string
) {
  const when = fmt(scheduledIso, tz);
  const date = fmtDate(scheduledIso, tz);
  const time = fmtTime(scheduledIso, tz);

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
//
// No timezone parameter -- this template contains no appointment date/time
// (a cancellation has nothing left to schedule), so there is nothing here
// that could read wrong in the wrong zone.
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
