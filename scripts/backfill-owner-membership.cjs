/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS script, not part of the app bundle */
// One-time, idempotent backfill for Phase 3 owner-auth migration.
//
// Creates (or verifies) exactly two rows:
//   - profiles: one row for Alberto's existing Supabase Auth user
//   - workspace_memberships: one "owner" row linking that profile to the
//     existing real workspace
//
// Defensive by design: if either row already exists, its contents are
// verified against the expected values and never overwritten. Any mismatch
// stops the script immediately with an explicit error rather than touching
// the row. Nothing outside these two rows is ever read or written.
//
// Usage: node --env-file=.env.local scripts/backfill-owner-membership.cjs

const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

const env = {};
fs.readFileSync(".env.local", "utf8").split(/\r?\n/).forEach((line) => {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
});

const OWNER_AUTH_USER_ID = "5a28f3a0-e563-4307-b816-51ff9831cfc5";
const OWNER_EMAIL = "admin@novalabsdigital.com";
const REAL_WORKSPACE_ID = "c6053b32-8c71-498f-8f13-218579805d4d";
const OWNER_ROLE = "owner";

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function fail(msg) {
  console.error(`STOP: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log("=== Prerequisite checks ===");

  const { data: userData, error: userErr } = await sb.auth.admin.getUserById(OWNER_AUTH_USER_ID);
  if (userErr || !userData?.user) {
    fail(`expected Auth user ${OWNER_AUTH_USER_ID} not found (${userErr?.message || "no user"})`);
  }
  if (userData.user.email !== OWNER_EMAIL) {
    fail(`Auth user ${OWNER_AUTH_USER_ID} has unexpected email — refusing to proceed`);
  }
  console.log(`OK: Auth user ${OWNER_AUTH_USER_ID} exists with expected email`);

  const { data: ws, error: wsErr } = await sb
    .from("workspaces")
    .select("id")
    .eq("id", REAL_WORKSPACE_ID)
    .maybeSingle();
  if (wsErr) fail(`workspace lookup failed: ${wsErr.message}`);
  if (!ws) fail(`expected real workspace ${REAL_WORKSPACE_ID} not found`);
  console.log(`OK: real workspace ${REAL_WORKSPACE_ID} exists`);

  console.log("\n=== Baseline (before) ===");
  const { data: profilesBefore } = await sb.from("profiles").select("id");
  const { data: membershipsBefore } = await sb.from("workspace_memberships").select("id");
  console.log(`profiles: ${profilesBefore.length} row(s)`);
  console.log(`workspace_memberships: ${membershipsBefore.length} row(s)`);

  console.log("\n=== profiles ===");
  const { data: existingProfile, error: profSelErr } = await sb
    .from("profiles")
    .select("id, email")
    .eq("id", OWNER_AUTH_USER_ID)
    .maybeSingle();
  if (profSelErr) fail(`profiles select failed: ${profSelErr.message}`);

  let profileResult;
  if (!existingProfile) {
    const { error: insErr } = await sb.from("profiles").insert({ id: OWNER_AUTH_USER_ID, email: OWNER_EMAIL });
    if (insErr) fail(`profiles insert failed: ${insErr.message}`);
    profileResult = "created";
  } else if (existingProfile.email === OWNER_EMAIL) {
    profileResult = "already-correct";
  } else {
    fail(`profiles row ${OWNER_AUTH_USER_ID} exists with a different email than expected — not overwriting`);
  }
  console.log(`profile: ${profileResult}`);

  console.log("\n=== workspace_memberships ===");
  const { data: existingMembership, error: memSelErr } = await sb
    .from("workspace_memberships")
    .select("id, workspace_id, role")
    .eq("profile_id", OWNER_AUTH_USER_ID)
    .maybeSingle();
  if (memSelErr) fail(`workspace_memberships select failed: ${memSelErr.message}`);

  let membershipResult;
  if (!existingMembership) {
    const { error: insErr } = await sb
      .from("workspace_memberships")
      .insert({ profile_id: OWNER_AUTH_USER_ID, workspace_id: REAL_WORKSPACE_ID, role: OWNER_ROLE });
    if (insErr) fail(`workspace_memberships insert failed: ${insErr.message}`);
    membershipResult = "created";
  } else if (existingMembership.workspace_id === REAL_WORKSPACE_ID && existingMembership.role === OWNER_ROLE) {
    membershipResult = "already-correct";
  } else {
    fail(
      `workspace_memberships row for profile ${OWNER_AUTH_USER_ID} exists with a different workspace_id/role than expected — not overwriting`
    );
  }
  console.log(`membership: ${membershipResult}`);

  console.log("\n=== Baseline (after) ===");
  const { data: profilesAfter } = await sb.from("profiles").select("id, email");
  const { data: membershipsAfter } = await sb.from("workspace_memberships").select("id, profile_id, workspace_id, role");
  console.log(`profiles: ${profilesAfter.length} row(s)`);
  console.log(`workspace_memberships: ${membershipsAfter.length} row(s)`);

  console.log("\n=== Summary ===");
  console.log(JSON.stringify({ profile: profileResult, membership: membershipResult }, null, 2));
}

main().catch((e) => fail(e.message || String(e)));
