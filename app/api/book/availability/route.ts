export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  computeAvailableSlots,
  businessDayBounds,
  todayBusinessDate,
  type BusyRange,
} from "@/lib/availability";
import { REAL_WORKSPACE_ID } from "@/lib/workspace";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Public, unauthenticated by design (the booking page needs this before a
// customer has any session). Returns only free start times — never
// appointment or client details — so it can't be used to learn anything
// about who else is booked.
export async function GET(req: Request) {
  try {
    const { data: settings } = await supabaseAdmin
      .from("company_settings")
      .select("booking_enabled")
      .eq("workspace_id", REAL_WORKSPACE_ID)
      .maybeSingle();

    if (!settings?.booking_enabled) {
      return json({ error: "Online booking is currently unavailable." }, 403);
    }

    const url = new URL(req.url);
    const dateStr = (url.searchParams.get("date") || "").trim();
    const serviceName = (url.searchParams.get("service") || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return json({ error: "Invalid date" }, 400);
    }
    if (!serviceName) {
      return json({ error: "Missing service" }, 400);
    }
    if (dateStr < todayBusinessDate()) {
      return json({ slots: [] });
    }

    const { data: svc } = await supabaseAdmin
      .from("services")
      .select("duration_minutes")
      .eq("name", serviceName)
      .eq("workspace_id", REAL_WORKSPACE_ID)
      .eq("is_demo", false)
      .eq("active", true)
      .maybeSingle();

    if (!svc) {
      return json({ error: "Please choose a valid service." }, 400);
    }

    const { start, end } = businessDayBounds(dateStr);
    const { data: appts, error } = await supabaseAdmin
      .from("appointments")
      .select("scheduled_for, scheduled_end, duration_minutes")
      .eq("status", "scheduled")
      .eq("workspace_id", REAL_WORKSPACE_ID)
      .eq("is_demo", false)
      .gte("scheduled_for", start.toISOString())
      .lt("scheduled_for", end.toISOString());

    if (error) throw error;

    const busy: BusyRange[] = (appts ?? []).map((a) => {
      const busyStart = new Date(a.scheduled_for);
      const busyEnd = a.scheduled_end
        ? new Date(a.scheduled_end)
        : new Date(busyStart.getTime() + (a.duration_minutes || 60) * 60000);
      return { start: busyStart, end: busyEnd };
    });

    const slots = computeAvailableSlots(dateStr, svc.duration_minutes || 60, busy);
    return json({ slots });
  } catch (e: any) {
    console.error("BOOK_AVAILABILITY_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
