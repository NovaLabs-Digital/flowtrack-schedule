export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get("sft_session");
    if ((session?.value ?? "") !== "authenticated") {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    const employee_id = (body.employee_id || "").trim();
    const hours_worked = Number(body.hours_worked);
    const note = (body.note || "").trim();

    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
    if (!employee_id) return json({ error: "Missing employee_id" }, 400);
    if (!Number.isFinite(hours_worked) || hours_worked <= 0) {
      return json({ error: "Hours worked must be a positive number" }, 400);
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_employee_hours")
      .upsert(
        {
          appointment_id,
          employee_id,
          hours_worked,
          note: note || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "appointment_id,employee_id" }
      )
      .select("id, appointment_id, employee_id, hours_worked, note, created_at, updated_at")
      .single();

    if (error) throw error;

    return json({ ok: true, entry: data });
  } catch (e: any) {
    console.error("EMPLOYEE_HOURS_SAVE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
