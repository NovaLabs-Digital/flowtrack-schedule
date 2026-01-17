import { createClient } from "@supabase/supabase-js";

console.log("SB_URL prefix:", (process.env.SUPABASE_URL || "").slice(0, 30));
console.log("SRK length:", (process.env.SUPABASE_SERVICE_ROLE_KEY || "").length);

export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
