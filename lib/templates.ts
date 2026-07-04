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
  cancelUrl: string
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
ScheduleFlowTrack`,
    },
    sms: `✅ Appointment Confirmed

Service: ${service}
Date: ${date}
Time: ${time}

Need to cancel?
${cancelUrl}

Thank you,
ScheduleFlowTrack`,
  };
}

export function reminder24hTemplates(
  name: string,
  service: string,
  scheduledIso: string
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
ScheduleFlowTrack`,
    },
    sms: `Reminder

Service: ${service}
Date: ${date}
Time: ${time}

Thank you,
ScheduleFlowTrack`,
  };
}

export function changeTemplates(
  name: string,
  service: string,
  scheduledIso: string
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
ScheduleFlowTrack`,
    },
    sms: `Appointment Updated

Service: ${service}
Date: ${date}
Time: ${time}

Thank you,
ScheduleFlowTrack`,
  };
}

export function cancelTemplates(name: string, service: string) {
  const bookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/book`;
  return {
    email: {
      subject: `Appointment Cancelled`,
      body: `Hi ${name},

Your appointment has been cancelled.

Service: ${service}

Need another appointment?
${bookUrl}

Thank you,
ScheduleFlowTrack`,
    },
    sms: `Your appointment has been cancelled.

Service: ${service}

Need another appointment?
${bookUrl}

Thank you,
ScheduleFlowTrack`,
  };
}
