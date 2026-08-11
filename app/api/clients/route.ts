export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { quarantineActiveSeriesForClient, finalizeStoppedSeriesByIds, RECURRING_SERIES_REVIEW_WARNING } from "@/lib/recurringSeries";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

async function hasColumn(col: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("clients").select(col).limit(0);
  return !error;
}

const OPTIONAL_TEXT_FIELDS = ["address", "referred_by", "status", "notes", "preferred_contact_method"];
const OPTIONAL_BOOL_FIELDS = ["auto_email", "auto_sms"];

export async function PATCH(req: Request) {
  try {
    const body = await req.json();

    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    // Request-shape validation runs only after authentication, role
    // authorization, and the entitlement gate have all passed — an
    // unauthenticated or restricted caller must never learn "your request
    // was also malformed" before learning "you're not allowed to do this."
    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing client id" }, 400);

    const isTester = session.role === "tester";
    // Always confirm the row exists in this workspace before mutating —
    // an UPDATE whose WHERE clause matches nothing succeeds silently with
    // zero rows affected, which would otherwise look identical to a real
    // success. Checked for every role, not just tester, so a wrong-workspace
    // ID gets an honest 404 instead of a misleading 200.
    {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("is_demo")
        .eq("id", id)
        .eq("workspace_id", session.workspaceId)
        .maybeSingle();
      if (!data) return json({ error: "Client not found" }, 404);
      if (isTester && !data.is_demo) return json({ error: "Client not found" }, 404);
    }

    const update: Record<string, any> = {};
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.email !== undefined) update.email = body.email.trim() || null;
    if (body.phone !== undefined) update.phone = body.phone.trim() || null;
    if (body.client_since !== undefined) update.client_since = body.client_since || null;

    for (const f of OPTIONAL_TEXT_FIELDS) {
      if (body[f] !== undefined && await hasColumn(f)) {
        update[f] = typeof body[f] === "string" ? (body[f].trim() || null) : body[f];
      }
    }
    for (const f of OPTIONAL_BOOL_FIELDS) {
      if (body[f] !== undefined && await hasColumn(f)) {
        update[f] = !!body[f];
      }
    }
    if (body.client_since !== undefined && await hasColumn("client_since")) {
      update.client_since = body.client_since || null;
    }

    if (Object.keys(update).length === 0)
      return json({ error: "Nothing to update" }, 400);

    const { error } = await supabaseAdmin
      .from("clients")
      .update(update)
      .eq("id", id)
      .eq("workspace_id", session.workspaceId);
    if (error) throw error;

    return json({ ok: true });
  } catch (e: any) {
    console.error("CLIENT_PATCH_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = (body.action || "").trim();

    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    // Request-shape validation runs only after authentication, role
    // authorization, and the entitlement gate have all passed — an
    // unauthenticated or restricted caller must never learn "your request
    // was also malformed" before learning "you're not allowed to do this."
    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing client id" }, 400);

    const isTester = session.role === "tester";
    // Always confirm the row exists in this workspace before mutating —
    // an UPDATE whose WHERE clause matches nothing succeeds silently with
    // zero rows affected, which would otherwise look identical to a real
    // success. Checked for every role, not just tester, so a wrong-workspace
    // ID gets an honest 404 instead of a misleading 200.
    {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("is_demo")
        .eq("id", id)
        .eq("workspace_id", session.workspaceId)
        .maybeSingle();
      if (!data) return json({ error: "Client not found" }, 404);
      if (isTester && !data.is_demo) return json({ error: "Client not found" }, 404);
    }

    if (action === "archive") {
      // Block 2B safety correction: every currently-ACTIVE series tied to
      // this client is quarantined to review_required BEFORE the client
      // itself is archived -- fail closed. If this can't be established,
      // the archive is aborted rather than risking a still-active,
      // now-orphaned series. quarantinedSeriesIds is the exact set this
      // call moved, so the finalize step below can never sweep up an
      // unrelated legacy review_required series for the same client.
      let quarantinedSeriesIds: string[] = [];
      try {
        quarantinedSeriesIds = await quarantineActiveSeriesForClient(id, session.workspaceId);
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        return json({ error: "Unable to archive this client right now. Please try again." }, 500);
      }

      const update: Record<string, any> = { archived_at: new Date().toISOString() };
      if (await hasColumn("status")) update.status = "inactive";
      const { error } = await supabaseAdmin
        .from("clients")
        .update(update)
        .eq("id", id)
        .eq("workspace_id", session.workspaceId);
      if (error) throw error;

      // Finalize the quarantined series as stopped -- only after the
      // archive above has already fully succeeded. finalizeStoppedSeriesByIds
      // returns exactly which of the given ids actually transitioned (its
      // own compare-and-set excludes any that changed status again
      // concurrently) -- a partial result is exactly as much a "not fully
      // finalized" case as a thrown error, and must warn the same way,
      // never be silently reported as complete. Automatic replenishment
      // must also independently re-check current client status at the
      // moment it would act -- this registry transition is one layer of
      // defense, not the only one.
      let registryWarning = false;
      if (quarantinedSeriesIds.length > 0) {
        try {
          const finalizedIds = await finalizeStoppedSeriesByIds(quarantinedSeriesIds, session.workspaceId);
          if (finalizedIds.length !== quarantinedSeriesIds.length) registryWarning = true;
        } catch (err) {
          console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
          registryWarning = true;
        }
      }

      // Second safety sweep: the FIRST quarantine above ran before the
      // client was actually archived, so a completely separate, concurrent
      // request (create, Manage Recurrence, This & Future, or owner
      // activation) could have finalized a brand-new or edited series
      // active for this exact client in the narrow window between that
      // first quarantine and the client update just above -- each of those
      // finalize paths now independently re-checks client status right
      // before writing (see activate_recurring_series, migrations/027a --
      // locked and re-verified inside the same atomic transaction as the
      // rest of that activation), so this cannot actually happen anymore,
      // but this sweep is the second, independent layer of
      // defense against it regardless, catching anything that slips through
      // by any other path. The client itself is already safely inactive by
      // this point either way -- a failure here is never rolled back and
      // never retried, only reported as a warning.
      let secondSweepIds: string[] = [];
      try {
        secondSweepIds = await quarantineActiveSeriesForClient(id, session.workspaceId);
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        registryWarning = true;
      }
      if (secondSweepIds.length > 0) {
        try {
          const finalizedIds = await finalizeStoppedSeriesByIds(secondSweepIds, session.workspaceId);
          if (finalizedIds.length !== secondSweepIds.length) registryWarning = true;
        } catch (err) {
          console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
          registryWarning = true;
        }
      }

      return json({ ok: true, ...(registryWarning ? { warning: RECURRING_SERIES_REVIEW_WARNING } : {}) });
    }

    if (action === "restore") {
      // Fail-closed safety sweep BEFORE the client becomes active again:
      // any recurring_series row for this client that is still active (a
      // stray row the archive-time sweeps above somehow missed, or a
      // pre-existing inconsistency) must be neutralized first -- restoring
      // a client must never silently resurrect automatic-replenishment
      // eligibility for a series the owner never reviewed. Unlike archive's
      // sweeps (which run after the client is already safely inactive and
      // therefore only ever warn on failure), this is stricter: a failure
      // here aborts the ENTIRE restore before the client ever becomes
      // active, since proceeding would risk the opposite direction of
      // mistake. A pre-existing review_required or stopped series is never
      // touched by this sweep at all (quarantineActiveSeriesForClient only
      // ever matches status='active'), so this never itself reactivates
      // anything -- it only ever moves a stray active row to stopped.
      let quarantinedForRestore: string[] = [];
      try {
        quarantinedForRestore = await quarantineActiveSeriesForClient(id, session.workspaceId);
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        return json({ error: "Unable to restore this client right now. Please try again." }, 500);
      }
      if (quarantinedForRestore.length > 0) {
        let finalizedForRestore: string[];
        try {
          finalizedForRestore = await finalizeStoppedSeriesByIds(quarantinedForRestore, session.workspaceId);
        } catch (err) {
          console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
          return json({ error: "Unable to restore this client right now. Please try again." }, 500);
        }
        if (finalizedForRestore.length !== quarantinedForRestore.length) {
          console.error("RECURRING_SERIES_REGISTRY_ERROR", "partial finalize during restore safety sweep");
          return json({ error: "Unable to restore this client right now. Please try again." }, 500);
        }
      }

      const update: Record<string, any> = { archived_at: null };
      if (await hasColumn("status")) update.status = "active";
      const { error } = await supabaseAdmin
        .from("clients")
        .update(update)
        .eq("id", id)
        .eq("workspace_id", session.workspaceId);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Invalid action" }, 400);
  } catch (e: any) {
    console.error("CLIENT_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
