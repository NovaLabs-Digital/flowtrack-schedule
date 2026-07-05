/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS script, not part of the app bundle */
// Seeds the fictional "Sunshine Property Services" demo dataset used by the
// tester/demo login. Every row is tagged is_demo = true so it can never mix
// with the real business's data. Safe to run against the shared Supabase
// project since it only touches is_demo = true rows.
//
// Usage:
//   node --env-file=.env.local scripts/seed-demo-data.cjs          (seed once)
//   node --env-file=.env.local scripts/seed-demo-data.cjs --reset  (wipe + reseed demo rows)

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const RESET = process.argv.includes("--reset");

const EMPLOYEES = [
  { name: "Marcus Bell", phone: "(407) 555-0201", position: "Lawn & Grounds Technician", color: "#22C55E", active: true, is_demo: true },
  { name: "Priya Nandan", phone: "(407) 555-0202", position: "Cleaning & Turnover Specialist", color: "#3B82F6", active: true, is_demo: true },
  { name: "Derek Osei", phone: "(407) 555-0203", position: "Maintenance & Inspections", color: "#F59E0B", active: true, is_demo: true },
];

const SERVICES = [
  { name: "Lawn Mowing & Edging", description: "Routine mowing, edging, and trimming", duration_minutes: 45, active: true, color: "#22C55E", is_demo: true },
  { name: "Property Inspection", description: "Walkthrough inspection with condition report", duration_minutes: 30, active: true, color: "#F59E0B", is_demo: true },
  { name: "Window Washing", description: "Interior and exterior window cleaning", duration_minutes: 90, active: true, color: "#38BDF8", is_demo: true },
  { name: "Pressure Washing", description: "Driveway, walkway, and siding pressure wash", duration_minutes: 120, active: true, color: "#0EA5E9", is_demo: true },
  { name: "Move-Out Turnover Cleaning", description: "Full turnover cleaning between tenants", duration_minutes: 180, active: true, color: "#A855F7", is_demo: true },
  { name: "Landscaping & Yard Cleanup", description: "Seasonal yard cleanup and landscaping touch-ups", duration_minutes: 150, active: true, color: "#84CC16", is_demo: true },
];

const CLIENTS = [
  { name: "Jordan Whitfield", address: "118 Sunbeam Lane, Palmetto Cove, FL 32999", client_since: "2024-03-12", preferred_contact_method: "phone", notes: "Gate code 4471. Friendly golden retriever in back yard — keep gate latched." },
  { name: "Melissa Carter", address: "42 Harbor View Dr, Palmetto Cove, FL 32999", client_since: "2023-11-02", preferred_contact_method: "email", notes: "Prefers text confirmation the morning of service." },
  { name: "Devon Marsh", address: "275 Maple Ridge Ct, Palmetto Cove, FL 32999", client_since: "2025-01-20", preferred_contact_method: "phone", notes: "" },
  { name: "Priscilla Nguyen", address: "9 Coral Breeze Ave, Palmetto Cove, FL 32999", client_since: "2024-07-08", preferred_contact_method: "sms", notes: "Two indoor-only cats — do not prop doors open." },
  { name: "Owen Fairweather", address: "630 Willowbend Rd, Palmetto Cove, FL 32999", client_since: "2022-09-15", referred_by: "Melissa Carter", notes: "Gate code 8823." },
  { name: "Natalie Brooks", address: "14 Seagrass Ln, Palmetto Cove, FL 32999", client_since: "2025-02-11", notes: "Side gate sticks — lift slightly while pushing." },
  { name: "Terrence Wallace", address: "501 Driftwood Ct, Palmetto Cove, FL 32999", client_since: "2023-05-30", notes: "" },
  { name: "Sophia Delgado", address: "88 Palmetto Ave, Palmetto Cove, FL 32999", client_since: "2024-12-01", notes: "Please call ahead, prefers 30 min notice." },
  { name: "Grant Kim", address: "226 Heron Point Dr, Palmetto Cove, FL 32999", client_since: "2023-08-19", notes: "Gate code 1290. Two dogs, keep gate closed at all times." },
  { name: "Renee Ashworth", address: "77 Bayview Ter, Palmetto Cove, FL 32999", client_since: "2025-04-02", referred_by: "Grant Kim", notes: "" },
  { name: "Corey Padilla", address: "340 Magnolia St, Palmetto Cove, FL 32999", client_since: "2022-06-25", notes: "Leave invoice under the mat." },
  { name: "Angela Winslow", address: "19 Tidewater Way, Palmetto Cove, FL 32999", client_since: "2024-10-14", notes: "" },
  { name: "Felix Contreras", address: "512 Cypress Bend, Palmetto Cove, FL 32999", client_since: "2021-11-08", status: "inactive", notes: "Seasonal resident — only present Nov–Apr." },
  { name: "Brianna Holt", address: "63 Lighthouse Rd, Palmetto Cove, FL 32999", client_since: "2025-05-19", notes: "Gate code 6604." },
  { name: "Walter Ngata", address: "205 Sandpiper Ln, Palmetto Cove, FL 32999", client_since: "2023-02-27", notes: "" },
  { name: "Tasha Reyes", address: "8 Osprey Cir, Palmetto Cove, FL 32999", client_since: "2024-04-30", notes: "Friendly but vocal dog — will bark, that's normal." },
  { name: "Douglas Fenwick", address: "450 Estuary Dr, Palmetto Cove, FL 32999", client_since: "2022-01-05", status: "inactive", notes: "On hold for remodeling — resume in spring." },
  { name: "Yvonne Castillo", address: "27 Marina Walk, Palmetto Cove, FL 32999", client_since: "2025-03-08", notes: "Gate code 3315. Please close side gate fully." },
  { name: "Preston Aldridge", address: "611 Sunset Palm Dr, Palmetto Cove, FL 32999", client_since: "2023-09-22", notes: "" },
  { name: "Camille Duvall", address: "132 Egret Cove, Palmetto Cove, FL 32999", client_since: "2024-08-16", referred_by: "Yvonne Castillo", notes: "Prefers early morning appointments before 9am." },
].map((c, i) => ({
  name: c.name,
  email: `${c.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
  phone: `(407) 555-01${String(20 + i).padStart(2, "0")}`,
  address: c.address,
  client_since: c.client_since,
  referred_by: c.referred_by || null,
  status: c.status || "active",
  notes: c.notes || null,
  preferred_contact_method: c.preferred_contact_method || "",
  auto_email: false,
  auto_sms: false,
  is_demo: true,
}));

const HOURS = [8, 9, 10, 11, 13, 14, 15];
const NOTE_SAMPLES = [
  "First-time service for this property.",
  "Requested extra attention to entry areas.",
  "Follow-up from last visit.",
  null, null, null,
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function buildAppointments(clientIds, serviceRows, employeeIds) {
  const rows = [];
  const TOTAL = 35;
  const now = new Date();

  for (let i = 0; i < TOTAL - 3; i++) {
    const dayOffset = Math.floor(Math.random() * 29) - 7; // -7..+21
    const hour = pick(HOURS);
    const minute = pick([0, 30]);
    const start = new Date(now);
    start.setDate(start.getDate() + dayOffset);
    start.setHours(hour, minute, 0, 0);

    const service = pick(serviceRows);
    const end = new Date(start.getTime() + service.duration_minutes * 60000);
    const isPast = dayOffset < 0;

    let status = "scheduled";
    let actual_started_at = null;
    let actual_completed_at = null;

    if (isPast) {
      if (Math.random() < 0.7) {
        actual_started_at = start.toISOString();
        actual_completed_at = end.toISOString();
      } else {
        status = "cancelled";
      }
    } else if (Math.random() < 0.1) {
      status = "cancelled";
    }

    rows.push({
      client_id: pick(clientIds),
      service_type: service.name,
      scheduled_for: start.toISOString(),
      scheduled_end: end.toISOString(),
      duration_minutes: service.duration_minutes,
      status,
      notes: pick(NOTE_SAMPLES),
      employee_id: pick(employeeIds),
      frequency_type: "one_time",
      repeat_weeks: 1,
      series_id: null,
      actual_started_at,
      actual_completed_at,
      cancel_token: randomHex(24),
      is_demo: true,
    });
  }

  // A couple of short weekly recurring series among the future dates, for realism.
  for (let s = 0; s < 2; s++) {
    const seriesId = randomHex(16);
    const service = pick(serviceRows);
    const clientId = pick(clientIds);
    const employeeId = pick(employeeIds);
    const hour = pick(HOURS);
    for (let occ = 0; occ < 3; occ++) {
      const start = new Date(now);
      start.setDate(start.getDate() + 2 + occ * 7);
      start.setHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + service.duration_minutes * 60000);
      rows.push({
        client_id: clientId,
        service_type: service.name,
        scheduled_for: start.toISOString(),
        scheduled_end: end.toISOString(),
        duration_minutes: service.duration_minutes,
        status: "scheduled",
        notes: null,
        employee_id: employeeId,
        frequency_type: "weekly",
        repeat_weeks: 1,
        series_id: seriesId,
        actual_started_at: null,
        actual_completed_at: null,
        cancel_token: randomHex(24),
        is_demo: true,
      });
    }
  }

  return rows;
}

async function main() {
  const { count } = await supabase.from("clients").select("id", { count: "exact", head: true }).eq("is_demo", true);

  if (count > 0 && !RESET) {
    console.log(`Demo data already present (${count} demo clients). Run with --reset to wipe and reseed.`);
    return;
  }

  if (RESET) {
    console.log("Resetting existing demo rows...");
    await supabase.from("appointments").delete().eq("is_demo", true);
    await supabase.from("clients").delete().eq("is_demo", true);
    await supabase.from("employees").delete().eq("is_demo", true);
    await supabase.from("services").delete().eq("is_demo", true);
  }

  console.log("Inserting services...");
  const { data: services, error: svcErr } = await supabase.from("services").insert(SERVICES).select("id, name, duration_minutes");
  if (svcErr) throw svcErr;

  console.log("Inserting employees...");
  const { data: employees, error: empErr } = await supabase.from("employees").insert(EMPLOYEES).select("id");
  if (empErr) throw empErr;

  console.log("Inserting clients...");
  const { data: clients, error: cliErr } = await supabase.from("clients").insert(CLIENTS).select("id");
  if (cliErr) throw cliErr;

  console.log("Generating appointments...");
  const appointments = buildAppointments(
    clients.map((c) => c.id),
    services,
    employees.map((e) => e.id)
  );
  const { data: inserted, error: apptErr } = await supabase.from("appointments").insert(appointments).select("id");
  if (apptErr) throw apptErr;

  console.log(`Done. Seeded ${services.length} services, ${employees.length} employees, ${clients.length} clients, ${inserted.length} appointments (all is_demo = true).`);
}

main().catch((e) => {
  console.error("SEED_ERROR", e);
  process.exit(1);
});
