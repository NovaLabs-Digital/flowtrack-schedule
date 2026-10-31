// Daily cleanup for Guided Demo Sessions (vercel.json). Ends any live
// session past its 2-hour limit or abandoned by the host, and deletes ended
// sessions after 7 days (migration 042's demo_session_cleanup). Sessions
// already end on their own the moment anyone touches them; this only makes
// sure nothing lingers when nobody does.
//
// Safe at every deployment stage: it runs even when DEMO_HOST_AUTH_USER_ID
// is unset (so leftover sessions are still cleared after the feature is
// switched off), and before migration 042 is applied it reports
// "not installed" as a successful no-op instead of failing every day.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cronAuth";
import { demoRpc, DemoRpcError } from "@/lib/demoSession/server";

export async function GET(req: Request) {
  try {
    if (!isAuthorizedCronRequest(req.headers.get("authorization"), process.env.CRON_SECRET)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await demoRpc("demo_session_cleanup", {});
    return NextResponse.json({ ok: result.outcome === "ok", result });
  } catch (e) {
    if (e instanceof DemoRpcError && e.notInstalled) {
      return NextResponse.json({ ok: true, skipped: "not_installed" });
    }
    console.error("CRON_DEMO_SESSION_CLEANUP_ERROR");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
