export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner } from "@/lib/session";
import { bumpSessionEpoch } from "@/lib/signupProvisioning";

// "Sign out all devices" — a distinct, explicit owner action, separate from
// ordinary POST /api/auth/logout (see app/api/auth/logout/route.ts, which
// clears only the current device's cookie and never touches session_epoch).
// This route increments session_epoch, which invalidates every
// PREVIOUSLY-issued sft_session for this owner on their next request
// (see lib/sessionEpoch.ts) — including sessions on other devices/browsers
// this request has no direct access to. The current device's own cookie is
// also cleared here for immediate local effect, rather than relying solely
// on the epoch mismatch to catch it on this device's own next request.
export async function POST() {
  const session = await getSession();
  const deny = requireOwner(session);
  if (deny) return deny;
  // requireOwner() already guarantees role === "owner" at runtime; this
  // check exists purely so TypeScript narrows session to the owner variant
  // (carrying authUserId) — reaching the else branch would mean
  // requireOwner() wasn't actually called first, a programmer error, not a
  // real request path (same reasoning as lib/session.ts's assertWorkspace).
  if (session.role !== "owner") {
    throw new Error("logout-all reached with a non-owner session after requireOwner() — programmer error");
  }

  await bumpSessionEpoch(session.authUserId);

  const res = NextResponse.json({ ok: true });
  res.cookies.set("sft_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
