import twilio from "twilio";
import sgMail from "@sendgrid/mail";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

export async function sendSms(to: string, body: string) {
  const msg = await twilioClient.messages.create({
    to,
    from: process.env.TWILIO_FROM_NUMBER!,
    body,
  });
  return msg.sid;
}

const disabled = process.env.DISABLE_MESSAGES === "true";


export async function sendEmail(to: string, subject: string, text: string) {
  const res = await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL!,
      name: process.env.SENDGRID_FROM_NAME || "FlowTrack Schedule",
    },
    subject,
    text,
  });
  return res?.[0]?.headers?.["x-message-id"]?.toString() || "sendgrid";
}
