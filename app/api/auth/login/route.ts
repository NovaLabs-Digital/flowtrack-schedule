export const runtime = "nodejs";

import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim();
    const password = (body.password || "").trim();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    // Simple credential check for internal alpha.
    // Replace with Supabase Auth when ready.
    const validEmail = process.env.ADMIN_EMAIL || "admin@novalabsdigital.com";
    const validPassword = process.env.ADMIN_PASSWORD || "schedule2026";

    if (email !== validEmail || password !== validPassword) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set("sft_session", "authenticated", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
