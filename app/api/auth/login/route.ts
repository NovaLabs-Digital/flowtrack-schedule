export const runtime = "nodejs";

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function setCookie(res: NextResponse, value: string) {
  res.cookies.set("sft_session", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = (body.email || "").trim();
    const password = (body.password || "").trim();
    const role = (body.role || "").trim();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    if (role === "employee") {
      const { data: emp, error } = await supabaseAdmin
        .from("employees")
        .select("id, password_hash, active")
        .eq("email", email)
        .maybeSingle();

      if (error) throw error;
      if (!emp) {
        return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
      }
      if (!emp.active) {
        return NextResponse.json({ error: "Account is inactive. Contact your manager." }, { status: 401 });
      }
      if (!emp.password_hash || !(await bcrypt.compare(password, emp.password_hash))) {
        return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
      }

      const res = NextResponse.json({ ok: true, redirect: "/schedule" });
      setCookie(res, `employee:${emp.id}`);
      return res;
    }

    const validEmail = process.env.ADMIN_EMAIL || "admin@novalabsdigital.com";
    const validPassword = process.env.ADMIN_PASSWORD || "schedule2026";

    if (email !== validEmail || password !== validPassword) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
    setCookie(res, "authenticated");
    return res;
  } catch (e: any) {
    console.error("LOGIN_ERROR", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
