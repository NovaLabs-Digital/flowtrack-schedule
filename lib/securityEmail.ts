import "server-only";
import { Resend } from "resend";
import { getOwnerEmail } from "@/lib/ownerSecurityStore";

// Account security notices to an owner's own sign-in email (two-step sign-in
// turned off, a recovery code used). Unlike lib/notify.ts's client
// notifications, these never depend on the business's "Enable Client
// Notifications" switch -- they protect the owner's account. Only
// DISABLE_MESSAGES (development) skips them. Never throws: the security
// change itself has already happened; a failed notice is logged.
export async function sendAccountSecurityEmail(authUserId: string, subject: string, text: string): Promise<boolean> {
  try {
    if (process.env.DISABLE_MESSAGES === "true") {
      console.log("[DISABLE_MESSAGES] Security email skipped -- subject:", subject);
      return false;
    }
    const to = await getOwnerEmail(authUserId);
    if (!to) {
      console.error("SECURITY_EMAIL_NO_ADDRESS");
      return false;
    }
    const fromName = process.env.RESEND_FROM_NAME || "FlowTrack Schedule";
    const { error } = await new Resend(process.env.RESEND_API_KEY!).emails.send({
      from: `${fromName} <${process.env.RESEND_FROM_EMAIL}>`,
      to,
      subject,
      text,
    });
    if (error) {
      console.error("SECURITY_EMAIL_SEND_ERROR");
      return false;
    }
    return true;
  } catch {
    console.error("SECURITY_EMAIL_SEND_ERROR");
    return false;
  }
}

export const TWO_STEP_OFF_EMAIL = {
  subject: "Two-step sign-in was turned off",
  text: [
    "Two-step sign-in was just turned off for your Schedule FlowTrack owner account.",
    "Your account now signs in with your password only, and every other device was signed out.",
    "",
    "If this was you, no action is needed.",
    "If this wasn't you, contact support right away.",
  ].join("\n"),
};

export const RECOVERY_CODE_USED_EMAIL = {
  subject: "A recovery code was used on your account",
  text: [
    "A recovery code was just used on your Schedule FlowTrack owner account. Your previous authenticator was removed so a new one can be set up.",
    "",
    "If this was you, finish setting up your new authenticator and keep your new recovery codes somewhere safe.",
    "If this wasn't you, contact support right away.",
  ].join("\n"),
};
